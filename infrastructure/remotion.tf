# ===== Remotion Lambda Rendering Infrastructure =====
# Note: Remotion Lambda requires its own deployment process.
# Run `npx remotion lambda sites create` and `npx remotion lambda functions deploy` 
# after this infrastructure is created.

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

  # Lambda invoke for Remotion's distributed rendering
  statement {
    actions = [
      "lambda:InvokeFunction"
    ]
    resources = [
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:remotion-render-*"
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

# Lambda function to trigger Remotion render
resource "aws_lambda_function" "render_video" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-render-video"
  role             = aws_iam_role.remotion_lambda_role.arn
  handler          = "renderVideo.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  timeout          = 300
  memory_size      = 512

  environment {
    variables = {
      RENDER_JOBS_TABLE       = aws_dynamodb_table.render_jobs.name
      RENDERS_BUCKET          = aws_s3_bucket.renders.id
      MEDIA_BUCKET            = aws_s3_bucket.media.id
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      ASSETS_TABLE            = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
      AWS_REGION_NAME         = var.aws_region
      # These will be set after Remotion Lambda deployment
      REMOTION_SERVE_URL      = "https://remotionlambda-uswest2-0a5jiyy2o6.s3.us-west-2.amazonaws.com/sites/zeevee-renderer/index.html"
      REMOTION_FUNCTION_NAME  = "remotion-render-4-0-387-mem2048mb-disk2048mb-300sec"
    }
  }
}

# Lambda function to get render status
resource "aws_lambda_function" "get_render_status" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-get-render-status"
  role             = aws_iam_role.remotion_lambda_role.arn
  handler          = "getRenderStatus.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  timeout          = 30

  environment {
    variables = {
      RENDER_JOBS_TABLE       = aws_dynamodb_table.render_jobs.name
      RENDERS_BUCKET          = aws_s3_bucket.renders.id
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
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
