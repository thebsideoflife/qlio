# ===== FFmpeg Lambda for Video Segment Stitching =====
# This Lambda uses a Docker container with FFmpeg to stitch video segments
# before passing to Remotion for caption rendering.

# ECR repository for the FFmpeg Lambda container
resource "aws_ecr_repository" "ffmpeg_lambda" {
  name                 = "${var.project_name}-ffmpeg-lambda"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  force_delete = true
}

# Lifecycle policy to keep only recent images
resource "aws_ecr_lifecycle_policy" "ffmpeg_lambda" {
  repository = aws_ecr_repository.ffmpeg_lambda.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 3 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 3
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# IAM role for the stitch Lambda
resource "aws_iam_role" "stitch_lambda_role" {
  name               = "${var.project_name}-stitch-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "stitch_lambda_basic" {
  role       = aws_iam_role.stitch_lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "stitch_lambda_policy" {
  # S3 access for media bucket (read source videos, write stitched/chunks)
  statement {
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:ListBucket",
      "s3:HeadObject"
    ]
    resources = [
      aws_s3_bucket.media.arn,
      "${aws_s3_bucket.media.arn}/*"
    ]
  }

  # DynamoDB access for render jobs and assets
  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
      "dynamodb:PutItem"
    ]
    resources = [
      aws_dynamodb_table.render_jobs.arn,
      aws_dynamodb_table.assets.arn
    ]
  }

  # Lambda invoke for Remotion and indexChunks
  statement {
    actions = [
      "lambda:InvokeFunction"
    ]
    resources = [
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:remotion-render-*",
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-index-chunks"
    ]
  }

  # S3 access for Remotion Lambda bucket
  statement {
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:ListBucket"
    ]
    resources = [
      "arn:aws:s3:::remotionlambda-*",
      "arn:aws:s3:::remotionlambda-*/*"
    ]
  }

  # Remotion client needs to list buckets to find its bucket
  statement {
    actions   = ["s3:ListAllMyBuckets"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "stitch_lambda_policy" {
  name   = "${var.project_name}-stitch-lambda-policy"
  role   = aws_iam_role.stitch_lambda_role.id
  policy = data.aws_iam_policy_document.stitch_lambda_policy.json
}

# Lambda function for stitching video segments
# Note: This requires the Docker image to be built and pushed first.
# Run: ./build-ffmpeg-lambda.sh before applying this.
resource "aws_lambda_function" "stitch_segments" {
  function_name = "${var.project_name}-stitch-segments"
  role          = aws_iam_role.stitch_lambda_role.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.ffmpeg_lambda.repository_url}:latest"

  timeout     = 900  # 15 minutes - video processing can take time
  memory_size = 3008 # 3GB - FFmpeg needs memory for processing

  # Note: reserved_concurrent_executions removed - account doesn't have enough
  # unreserved capacity. Cost control is handled by:
  # 1. Natural workflow throttling (one render at a time per user)
  # 2. Frontend UI preventing duplicate submissions
  # 3. AWS Lambda's default account-level concurrency limit (1000)

  ephemeral_storage {
    size = 10240 # 10GB - for downloading and processing videos
  }

  environment {
    variables = {
      RENDER_JOBS_TABLE      = aws_dynamodb_table.render_jobs.name
      MEDIA_BUCKET           = aws_s3_bucket.media.id
      REMOTION_SERVE_URL     = "https://remotionlambda-uswest2-0g1upoverr.s3.us-west-2.amazonaws.com/sites/zeevee-renderer/index.html"
      REMOTION_FUNCTION_NAME = "remotion-render-4-0-387-mem2048mb-disk2048mb-240sec"
      AWS_REGION_NAME        = var.aws_region
    }
  }

  # Ignore image_uri changes - we'll update via deploy script
  lifecycle {
    ignore_changes = [image_uri]
  }
}

# Add STITCH_FUNCTION_NAME to render_video Lambda
# This is done by updating the existing render_video resource in remotion.tf

# Output the ECR repository URL for the build script
output "ffmpeg_lambda_ecr_url" {
  value = aws_ecr_repository.ffmpeg_lambda.repository_url
}

output "stitch_function_name" {
  value = aws_lambda_function.stitch_segments.function_name
}

