data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ===== Upload Role (for browser-based multipart uploads) =====
# This role is assumed by the Lambda and passed to the browser with scoped-down permissions

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "upload_role_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.lambda_role.arn]
    }
  }
}

resource "aws_iam_role" "upload_role" {
  name               = "${var.project_name}-upload-role"
  assume_role_policy = data.aws_iam_policy_document.upload_role_assume.json
}

data "aws_iam_policy_document" "upload_role_policy" {
  statement {
    actions = [
      "s3:PutObject",
      "s3:AbortMultipartUpload"
    ]
    resources = [
      "${aws_s3_bucket.media.arn}/raw/*"
    ]
  }
}

resource "aws_iam_role_policy" "upload_role_policy" {
  name   = "${var.project_name}-upload-role-policy"
  role   = aws_iam_role.upload_role.id
  policy = data.aws_iam_policy_document.upload_role_policy.json
}

resource "aws_iam_role" "lambda_role" {
  name               = "${var.project_name}-lambda-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "lambda_policy" {
  statement {
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:DeleteObject"
    ]
    resources = [
      aws_s3_bucket.media.arn,
      "${aws_s3_bucket.media.arn}/*"
    ]
  }
  statement {
    actions = [
      "dynamodb:PutItem",
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Scan",
      "dynamodb:Query"
    ]
    resources = [
      aws_dynamodb_table.assets.arn,
      "${aws_dynamodb_table.assets.arn}/index/*",
      aws_dynamodb_table.projects.arn,
      "${aws_dynamodb_table.projects.arn}/index/*",
      aws_dynamodb_table.chunk_tasks.arn,
      aws_dynamodb_table.render_jobs.arn,
      "${aws_dynamodb_table.render_jobs.arn}/index/*"
    ]
  }
  # S3 read access for Remotion bucket (presigning download URLs)
  statement {
    actions = ["s3:GetObject"]
    resources = ["arn:aws:s3:::remotionlambda-*/*"]
  }
  # Allow Lambda to invoke other Lambdas (for split -> indexChunks flow)
  statement {
    actions = ["lambda:InvokeFunction"]
    resources = [
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${var.project_name}-*"
    ]
  }
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.twelve_labs_key.arn,
      aws_secretsmanager_secret.api_password.arn,
      aws_secretsmanager_secret.twelve_labs_signing_secret.arn,
      data.aws_secretsmanager_secret.anthropic_api_key.arn,
      aws_secretsmanager_secret.gemini_api_key.arn,
      aws_secretsmanager_secret.cloudfront_private_key.arn
    ]
  }
  statement {
    actions = [
      "bedrock:InvokeModel",
      "aws-marketplace:ViewSubscriptions",
      "aws-marketplace:Subscribe",
      "aws-marketplace:Unsubscribe"
    ]
    resources = ["*"]
  }
  statement {
    actions   = ["sts:AssumeRole"]
    resources = [aws_iam_role.upload_role.arn]
  }
}

resource "aws_iam_role_policy" "lambda_policy" {
  name   = "${var.project_name}-lambda-policy"
  role   = aws_iam_role.lambda_role.id
  policy = data.aws_iam_policy_document.lambda_policy.json
}

# ============================================================================
# SEPARATE ZIP FILES PER LAMBDA - Only changed Lambdas redeploy
# ============================================================================

# --- Upload ---
data "archive_file" "upload_zip" {
  type        = "zip"
  source_file = "../backend/dist/generateUploadCredentials.js"
  output_path = "${path.module}/zips/upload.zip"
}

resource "aws_lambda_function" "generate_upload_credentials" {
  filename         = data.archive_file.upload_zip.output_path
  function_name    = "${var.project_name}-generate-upload-credentials"
  role             = aws_iam_role.lambda_role.arn
  handler          = "generateUploadCredentials.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.upload_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      BUCKET_NAME             = aws_s3_bucket.media.id
      TABLE_NAME              = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
      UPLOAD_ROLE_ARN         = aws_iam_role.upload_role.arn
    }
  }
}

# --- Indexing ---
data "archive_file" "start_indexing_zip" {
  type        = "zip"
  source_file = "../backend/dist/startIndexing.js"
  output_path = "${path.module}/zips/startIndexing.zip"
}

resource "aws_lambda_function" "start_indexing" {
  filename         = data.archive_file.start_indexing_zip.output_path
  function_name    = "${var.project_name}-start-indexing"
  role             = aws_iam_role.lambda_role.arn
  handler          = "startIndexing.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.start_indexing_zip.output_base64sha256
  timeout          = 30

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.assets.name
      CHUNK_TASKS_TABLE       = aws_dynamodb_table.chunk_tasks.name
      SECRET_ARN              = aws_secretsmanager_secret.twelve_labs_key.arn
      TWELVE_LABS_INDEX_ID    = var.twelve_labs_index_id
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
      SPLIT_FUNCTION_NAME     = aws_lambda_function.split_video.function_name
    }
  }

  depends_on = [aws_lambda_function.split_video]
}

# --- Split Video (FFmpeg container for long video splitting) ---
# Note: This reuses the FFmpeg ECR repository from ffmpeg.tf
resource "aws_lambda_function" "split_video" {
  function_name = "${var.project_name}-split-video"
  role          = aws_iam_role.stitch_lambda_role.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.ffmpeg_lambda.repository_url}:latest"

  timeout     = 900  # 15 minutes - video splitting can take time
  memory_size = 3008 # 3GB - FFmpeg needs memory for processing

  ephemeral_storage {
    size = 10240 # 10GB - for downloading and processing videos
  }

  environment {
    variables = {
      TABLE_NAME                  = aws_dynamodb_table.assets.name
      BUCKET_NAME                 = aws_s3_bucket.media.id
      INDEX_CHUNKS_FUNCTION_NAME  = aws_lambda_function.index_chunks.function_name
    }
  }

  # Override the CMD to use splitVideo handler instead of stitchSegments
  image_config {
    command = ["splitVideo.handler"]
  }

  lifecycle {
    ignore_changes = [image_uri]
  }

  depends_on = [aws_lambda_function.index_chunks]
}

# --- Index Chunks (triggers 12labs indexing for all chunks) ---
data "archive_file" "index_chunks_zip" {
  type        = "zip"
  source_file = "../backend/dist/indexChunks.js"
  output_path = "${path.module}/zips/indexChunks.zip"
}

resource "aws_lambda_function" "index_chunks" {
  filename         = data.archive_file.index_chunks_zip.output_path
  function_name    = "${var.project_name}-index-chunks"
  role             = aws_iam_role.lambda_role.arn
  handler          = "indexChunks.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.index_chunks_zip.output_base64sha256
  timeout          = 120

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.assets.name
      CHUNK_TASKS_TABLE       = aws_dynamodb_table.chunk_tasks.name
      BUCKET_NAME             = aws_s3_bucket.media.id
      SECRET_ARN              = aws_secretsmanager_secret.twelve_labs_key.arn
      TWELVE_LABS_INDEX_ID    = var.twelve_labs_index_id
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}

# --- Webhook ---
data "archive_file" "process_webhook_zip" {
  type        = "zip"
  source_file = "../backend/dist/processWebhook.js"
  output_path = "${path.module}/zips/processWebhook.zip"
}

resource "aws_lambda_function" "process_webhook" {
  filename         = data.archive_file.process_webhook_zip.output_path
  function_name    = "${var.project_name}-process-webhook"
  role             = aws_iam_role.lambda_role.arn
  handler          = "processWebhook.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.process_webhook_zip.output_base64sha256
  timeout          = 60

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.assets.name
      CHUNK_TASKS_TABLE       = aws_dynamodb_table.chunk_tasks.name
      BUCKET_NAME             = aws_s3_bucket.media.id
      SECRET_ARN              = aws_secretsmanager_secret.twelve_labs_key.arn
      TWELVE_LABS_INDEX_ID    = var.twelve_labs_index_id
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
      SIGNING_SECRET_ARN      = aws_secretsmanager_secret.twelve_labs_signing_secret.arn
    }
  }
}

# --- Assets CRUD ---
data "archive_file" "list_assets_zip" {
  type        = "zip"
  source_file = "../backend/dist/listAssets.js"
  output_path = "${path.module}/zips/listAssets.zip"
}

resource "aws_lambda_function" "list_assets" {
  filename         = data.archive_file.list_assets_zip.output_path
  function_name    = "${var.project_name}-list-assets"
  role             = aws_iam_role.lambda_role.arn
  handler          = "listAssets.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.list_assets_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME                       = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN          = aws_secretsmanager_secret.api_password.arn
      CLOUDFRONT_DOMAIN                = aws_cloudfront_distribution.media.domain_name
      CLOUDFRONT_KEY_PAIR_ID           = aws_cloudfront_public_key.media.id
      CLOUDFRONT_PRIVATE_KEY_SECRET_ARN = aws_secretsmanager_secret.cloudfront_private_key.arn
    }
  }
}

data "archive_file" "get_asset_zip" {
  type        = "zip"
  source_file = "../backend/dist/getAsset.js"
  output_path = "${path.module}/zips/getAsset.zip"
}

resource "aws_lambda_function" "get_asset" {
  filename         = data.archive_file.get_asset_zip.output_path
  function_name    = "${var.project_name}-get-asset"
  role             = aws_iam_role.lambda_role.arn
  handler          = "getAsset.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.get_asset_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME                       = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN          = aws_secretsmanager_secret.api_password.arn
      CLOUDFRONT_DOMAIN                = aws_cloudfront_distribution.media.domain_name
      CLOUDFRONT_KEY_PAIR_ID           = aws_cloudfront_public_key.media.id
      CLOUDFRONT_PRIVATE_KEY_SECRET_ARN = aws_secretsmanager_secret.cloudfront_private_key.arn
    }
  }
}

data "archive_file" "update_asset_zip" {
  type        = "zip"
  source_file = "../backend/dist/updateAsset.js"
  output_path = "${path.module}/zips/updateAsset.zip"
}

resource "aws_lambda_function" "update_asset" {
  filename         = data.archive_file.update_asset_zip.output_path
  function_name    = "${var.project_name}-update-asset"
  role             = aws_iam_role.lambda_role.arn
  handler          = "updateAsset.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.update_asset_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}

data "archive_file" "delete_asset_zip" {
  type        = "zip"
  source_file = "../backend/dist/deleteAsset.js"
  output_path = "${path.module}/zips/deleteAsset.zip"
}

resource "aws_lambda_function" "delete_asset" {
  filename         = data.archive_file.delete_asset_zip.output_path
  function_name    = "${var.project_name}-delete-asset"
  role             = aws_iam_role.lambda_role.arn
  handler          = "deleteAsset.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.delete_asset_zip.output_base64sha256
  timeout          = 30

  environment {
    variables = {
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      ASSETS_TABLE            = aws_dynamodb_table.assets.name
      SECRET_ARN              = aws_secretsmanager_secret.twelve_labs_key.arn
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}

# --- Projects CRUD ---
data "archive_file" "create_project_zip" {
  type        = "zip"
  source_file = "../backend/dist/createProject.js"
  output_path = "${path.module}/zips/createProject.zip"
}

resource "aws_lambda_function" "create_project" {
  filename         = data.archive_file.create_project_zip.output_path
  function_name    = "${var.project_name}-create-project"
  role             = aws_iam_role.lambda_role.arn
  handler          = "createProject.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.create_project_zip.output_base64sha256
  timeout          = 60

  environment {
    variables = {
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      ASSETS_TABLE            = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
      SECRET_ARN              = aws_secretsmanager_secret.twelve_labs_key.arn
      TWELVE_LABS_INDEX_ID    = var.twelve_labs_index_id
    }
  }
}

data "archive_file" "project_ops_zip" {
  type        = "zip"
  source_file = "../backend/dist/projectOps.js"
  output_path = "${path.module}/zips/projectOps.zip"
}

resource "aws_lambda_function" "project_ops" {
  filename         = data.archive_file.project_ops_zip.output_path
  function_name    = "${var.project_name}-project-ops"
  role             = aws_iam_role.lambda_role.arn
  handler          = "projectOps.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.project_ops_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      PROJECTS_TABLE                   = aws_dynamodb_table.projects.name
      ASSETS_TABLE                     = aws_dynamodb_table.assets.name
      RENDER_JOBS_TABLE                = aws_dynamodb_table.render_jobs.name
      API_PASSWORD_SECRET_ARN          = aws_secretsmanager_secret.api_password.arn
      CLOUDFRONT_DOMAIN                = aws_cloudfront_distribution.media.domain_name
      CLOUDFRONT_KEY_PAIR_ID           = aws_cloudfront_public_key.media.id
      CLOUDFRONT_PRIVATE_KEY_SECRET_ARN = aws_secretsmanager_secret.cloudfront_private_key.arn
    }
  }
}

data "archive_file" "list_projects_zip" {
  type        = "zip"
  source_file = "../backend/dist/listProjects.js"
  output_path = "${path.module}/zips/listProjects.zip"
}

resource "aws_lambda_function" "list_projects" {
  filename         = data.archive_file.list_projects_zip.output_path
  function_name    = "${var.project_name}-list-projects"
  role             = aws_iam_role.lambda_role.arn
  handler          = "listProjects.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.list_projects_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}

# --- Detect Scenes (Async scene detection for long videos) ---
data "archive_file" "detect_scenes_zip" {
  type        = "zip"
  source_file = "../backend/dist/detectScenes.js"
  output_path = "${path.module}/zips/detectScenes.zip"
}

resource "aws_lambda_function" "detect_scenes" {
  filename         = data.archive_file.detect_scenes_zip.output_path
  function_name    = "${var.project_name}-detect-scenes"
  role             = aws_iam_role.lambda_role.arn
  handler          = "detectScenes.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.detect_scenes_zip.output_base64sha256
  timeout          = 900  # 15 minutes - full Lambda max for long videos
  memory_size      = 512

  environment {
    variables = {
      ASSETS_TABLE         = aws_dynamodb_table.assets.name
      SECRET_ARN           = aws_secretsmanager_secret.twelve_labs_key.arn
      TWELVE_LABS_INDEX_ID = var.twelve_labs_index_id
      BUCKET_NAME          = aws_s3_bucket.media.bucket
    }
  }
}

# --- Generate Segments ---
data "archive_file" "generate_segments_zip" {
  type        = "zip"
  source_file = "../backend/dist/generateSegments.js"
  output_path = "${path.module}/zips/generateSegments.zip"
}

resource "aws_lambda_function" "generate_segments" {
  filename         = data.archive_file.generate_segments_zip.output_path
  function_name    = "${var.project_name}-generate-segments"
  role             = aws_iam_role.lambda_role.arn
  handler          = "generateSegments.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.generate_segments_zip.output_base64sha256
  timeout          = 900  # 15 minutes — Pegasus async segmentation can exceed 10m on long sources

  environment {
    variables = {
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      ASSETS_TABLE            = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
      SECRET_ARN              = aws_secretsmanager_secret.twelve_labs_key.arn
      TWELVE_LABS_INDEX_ID    = var.twelve_labs_index_id
      BUCKET_NAME             = aws_s3_bucket.media.bucket
      DETECT_SCENES_FUNCTION        = aws_lambda_function.detect_scenes.function_name
      ANALYZE_FRAMING_FUNCTION_NAME = aws_lambda_function.analyze_framing.function_name
      GEMINI_SECRET_ARN           = aws_secretsmanager_secret.gemini_api_key.arn
      ANTHROPIC_SECRET_ARN        = data.aws_secretsmanager_secret.anthropic_api_key.arn
    }
  }
}

# --- FFmpeg Lambda Layer ---
# Built by running ./build-ffmpeg-layer.sh before tofu apply
resource "aws_lambda_layer_version" "ffmpeg" {
  filename            = "${path.module}/layers/ffmpeg-layer.zip"
  layer_name          = "${var.project_name}-ffmpeg"
  compatible_runtimes = ["nodejs20.x"]
  description         = "Static FFmpeg binary for video segment cutting"
  source_code_hash    = filebase64sha256("${path.module}/layers/ffmpeg-layer.zip")
}

# --- Analyze Framing (Smart Autoframing with Gemini) ---
data "archive_file" "analyze_framing_zip" {
  type        = "zip"
  source_file = "../backend/dist/analyzeFraming.js"
  output_path = "${path.module}/zips/analyzeFraming.zip"
}

resource "aws_lambda_function" "analyze_framing" {
  filename         = data.archive_file.analyze_framing_zip.output_path
  function_name    = "${var.project_name}-analyze-framing"
  role             = aws_iam_role.lambda_role.arn
  handler          = "analyzeFraming.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.analyze_framing_zip.output_base64sha256
  timeout          = 900  # 15 minutes — batch framing can be slow
  memory_size      = 3008 # Max Lambda memory — FFmpeg cuts multiple long segments in parallel
  layers           = [aws_lambda_layer_version.ffmpeg.arn]

  ephemeral_storage {
    size = 4096 # 4GB — for FFmpeg segment clips in /tmp (long segments need space)
  }

  environment {
    variables = {
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      ASSETS_TABLE            = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
      GEMINI_SECRET_ARN       = aws_secretsmanager_secret.gemini_api_key.arn
      BUCKET_NAME             = aws_s3_bucket.media.bucket
    }
  }
}

# ============================================================================
# S3 Notification
# ============================================================================

resource "aws_lambda_permission" "allow_bucket" {
  statement_id  = "AllowExecutionFromS3Bucket"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.start_indexing.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.media.arn
}

resource "aws_s3_bucket_notification" "bucket_notification" {
  bucket = aws_s3_bucket.media.id

  # Raw video uploads
  lambda_function {
    lambda_function_arn = aws_lambda_function.start_indexing.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "raw/"
    filter_suffix       = ".mp4"
  }

  lambda_function {
    lambda_function_arn = aws_lambda_function.start_indexing.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "raw/"
    filter_suffix       = ".mov"
  }

  lambda_function {
    lambda_function_arn = aws_lambda_function.start_indexing.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "raw/"
    filter_suffix       = ".m4v"
  }

  # Chunk uploads (from splitVideo) - trigger indexing via same Lambda
  lambda_function {
    lambda_function_arn = aws_lambda_function.start_indexing.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "chunks/"
    filter_suffix       = ".mp4"
  }

  depends_on = [aws_lambda_permission.allow_bucket]
}
