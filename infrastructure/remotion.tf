# ===== Remotion Lambda Rendering Infrastructure =====
# Note: Remotion Lambda requires its own deployment process.
# After this infrastructure is created, run:
#
# 1. Deploy the site bundle:
#    npx remotion lambda sites create --site-name=zeevee-renderer
#
# 2. Deploy the render function with OPTIMIZED settings:
#    npx remotion lambda functions deploy \
#      --memory=2048 \
#      --disk=2048 \
#      --timeout=240 \
#      --architecture=arm64 \
#      --region=us-west-2
#
# Configuration rationale (for 10-minute videos):
# - memory=2048: Sweet spot - higher rarely helps, lower risks crashes
# - disk=2048: Handles large source files without "No space left" errors
# - timeout=240: 4 minutes per chunk prevents zombie processes
# - architecture=arm64: ~20% cheaper than x86, same performance
#
# The framesPerLambda=150 setting in renderVideo.ts creates ~120 workers
# for a 10-min video, fitting within the 1,000 concurrency limit.

# S3 bucket for Remotion renders
resource "aws_s3_bucket" "renders" {
  bucket = "${var.project_name}-renders-${var.stage}"
}

resource "aws_s3_bucket_cors_configuration" "renders" {
  bucket = aws_s3_bucket.renders.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# DynamoDB table for render jobs
resource "aws_dynamodb_table" "render_jobs" {
  name         = "${var.project_name}-render-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "jobId"

  attribute {
    name = "jobId"
    type = "S"
  }

  attribute {
    name = "projectId"
    type = "S"
  }

  global_secondary_index {
    name            = "ProjectIdIndex"
    hash_key        = "projectId"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

# IAM role for Remotion Lambda
resource "aws_iam_role" "remotion_lambda_role" {
  name               = "${var.project_name}-remotion-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "remotion_lambda_basic" {
  role       = aws_iam_role.remotion_lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "remotion_lambda_policy" {
  # S3 global permissions (needed by Remotion)
  statement {
    actions = [
      "s3:ListAllMyBuckets"
    ]
    resources = ["*"]
  }

  # S3 access for renders bucket
  statement {
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:DeleteObject"
    ]
    resources = [
      aws_s3_bucket.renders.arn,
      "${aws_s3_bucket.renders.arn}/*"
    ]
  }

  # S3 access for media bucket (read source videos)
  statement {
    actions = [
      "s3:GetObject",
      "s3:ListBucket"
    ]
    resources = [
      aws_s3_bucket.media.arn,
      "${aws_s3_bucket.media.arn}/*"
    ]
  }

  # S3 access for Remotion Lambda bucket (site and renders)
  statement {
    actions = [
      "s3:CreateBucket",
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
      "s3:ListBucket",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketAcl"
    ]
    resources = [
      "arn:aws:s3:::remotionlambda-*",
      "arn:aws:s3:::remotionlambda-*/*"
    ]
  }

  # DynamoDB access for render jobs
  statement {
    actions = [
      "dynamodb:PutItem",
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query"
    ]
    resources = [
      aws_dynamodb_table.render_jobs.arn,
      "${aws_dynamodb_table.render_jobs.arn}/index/*"
    ]
  }

  # DynamoDB access for projects table (to read project data)
  statement {
    actions = [
      "dynamodb:GetItem"
    ]
    resources = [
      aws_dynamodb_table.projects.arn
    ]
  }

  # DynamoDB access for assets table (to read asset/video data)
  statement {
    actions = [
      "dynamodb:GetItem"
    ]
    resources = [
      aws_dynamodb_table.assets.arn
    ]
  }

  # Lambda invoke for Remotion's distributed rendering
  statement {
    actions = [
      "lambda:InvokeFunction"
    ]
    resources = [
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:remotion-render-*"
    ]
  }

  # Lambda invoke for stitch segments function
  statement {
    actions = [
      "lambda:InvokeFunction"
    ]
    resources = [
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-stitch-segments"
    ]
  }

  # Secrets access
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.api_password.arn
    ]
  }
}

resource "aws_iam_role_policy" "remotion_lambda_policy" {
  name   = "${var.project_name}-remotion-lambda-policy"
  role   = aws_iam_role.remotion_lambda_role.id
  policy = data.aws_iam_policy_document.remotion_lambda_policy.json
}

# Special zip for render functions (includes node_modules)
data "archive_file" "render_lambda_zip" {
  type        = "zip"
  source_dir  = "../backend/render-package"
  output_path = "${path.module}/render-lambda.zip"
  depends_on  = [null_resource.build_render_package]
}

# Build render package before zipping
resource "null_resource" "build_render_package" {
  triggers = {
    # Only rebuild when handler files change
    render_video_hash = filemd5("../backend/dist/renderVideo.js")
    render_status_hash = filemd5("../backend/dist/getRenderStatus.js")
  }
  provisioner "local-exec" {
    command     = "./package-render.sh"
    working_dir = "../backend"
  }
}

# Lambda function to trigger Remotion render
resource "aws_lambda_function" "render_video" {
  filename         = data.archive_file.render_lambda_zip.output_path
  function_name    = "${var.project_name}-render-video"
  role             = aws_iam_role.remotion_lambda_role.arn
  handler          = "renderVideo.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.render_lambda_zip.output_base64sha256
  timeout          = 300
  memory_size      = 1024

  environment {
    variables = {
      RENDER_JOBS_TABLE       = aws_dynamodb_table.render_jobs.name
      RENDERS_BUCKET          = aws_s3_bucket.renders.id
      MEDIA_BUCKET            = aws_s3_bucket.media.id
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      ASSETS_TABLE            = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
      AWS_REGION_NAME         = var.aws_region
      STITCH_FUNCTION_NAME    = aws_lambda_function.stitch_segments.function_name
    }
  }
}

# Lambda function to get render status
resource "aws_lambda_function" "get_render_status" {
  filename         = data.archive_file.render_lambda_zip.output_path
  function_name    = "${var.project_name}-get-render-status"
  role             = aws_iam_role.remotion_lambda_role.arn
  handler          = "getRenderStatus.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.render_lambda_zip.output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      RENDER_JOBS_TABLE       = aws_dynamodb_table.render_jobs.name
      RENDERS_BUCKET          = aws_s3_bucket.renders.id
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
      REMOTION_FUNCTION_NAME  = "remotion-render-4-0-387-mem2048mb-disk2048mb-240sec"
      AWS_REGION_NAME         = var.aws_region
    }
  }
}

# Outputs for Remotion CLI configuration
output "remotion_renders_bucket" {
  value = aws_s3_bucket.renders.id
}

output "remotion_lambda_role_arn" {
  value = aws_iam_role.remotion_lambda_role.arn
}

output "render_jobs_table" {
  value = aws_dynamodb_table.render_jobs.name
}
