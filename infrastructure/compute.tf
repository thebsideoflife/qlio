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
      "${aws_dynamodb_table.projects.arn}/index/*"
    ]
  }
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.twelve_labs_key.arn,
      aws_secretsmanager_secret.api_password.arn,
      aws_secretsmanager_secret.twelve_labs_signing_secret.arn
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

# Archives
data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "../backend/dist"
  output_path = "${path.module}/lambda.zip"
}

# Lambdas
resource "aws_lambda_function" "generate_upload_credentials" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-generate-upload-credentials"
  role             = aws_iam_role.lambda_role.arn
  handler          = "generateUploadCredentials.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
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

resource "aws_lambda_function" "start_indexing" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-start-indexing"
  role             = aws_iam_role.lambda_role.arn
  handler          = "startIndexing.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  timeout          = 30

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.assets.name
      SECRET_ARN              = aws_secretsmanager_secret.twelve_labs_key.arn
      TWELVE_LABS_INDEX_ID    = var.twelve_labs_index_id
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}

resource "aws_lambda_function" "process_webhook" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-process-webhook"
  role             = aws_iam_role.lambda_role.arn
  handler          = "processWebhook.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  timeout          = 30

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.assets.name
      BUCKET_NAME             = aws_s3_bucket.media.id
      SECRET_ARN              = aws_secretsmanager_secret.twelve_labs_key.arn
      TWELVE_LABS_INDEX_ID    = var.twelve_labs_index_id
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
      SIGNING_SECRET_ARN      = aws_secretsmanager_secret.twelve_labs_signing_secret.arn
    }
  }
}

resource "aws_lambda_function" "list_assets" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-list-assets"
  role             = aws_iam_role.lambda_role.arn
  handler          = "listAssets.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}

resource "aws_lambda_function" "get_asset" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-get-asset"
  role             = aws_iam_role.lambda_role.arn
  handler          = "getAsset.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}

resource "aws_lambda_function" "update_asset" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-update-asset"
  role             = aws_iam_role.lambda_role.arn
  handler          = "updateAsset.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}

resource "aws_lambda_function" "create_project" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-create-project"
  role             = aws_iam_role.lambda_role.arn
  handler          = "createProject.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
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

resource "aws_lambda_function" "project_ops" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-project-ops"
  role             = aws_iam_role.lambda_role.arn
  handler          = "projectOps.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      ASSETS_TABLE            = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}

resource "aws_lambda_function" "delete_asset" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-delete-asset"
  role             = aws_iam_role.lambda_role.arn
  handler          = "deleteAsset.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
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

resource "aws_lambda_function" "list_projects" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-list-projects"
  role             = aws_iam_role.lambda_role.arn
  handler          = "listProjects.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}

resource "aws_lambda_function" "generate_segments" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-generate-segments"
  role             = aws_iam_role.lambda_role.arn
  handler          = "generateSegments.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  timeout          = 300

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

# S3 Notification
resource "aws_lambda_permission" "allow_bucket" {
  statement_id  = "AllowExecutionFromS3Bucket"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.start_indexing.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.media.arn
}

resource "aws_s3_bucket_notification" "bucket_notification" {
  bucket = aws_s3_bucket.media.id

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

  depends_on = [aws_lambda_permission.allow_bucket]
}
