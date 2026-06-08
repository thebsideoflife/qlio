# --- Ensure project cover thumbnails for dashboard (FFmpeg only) ---
data "archive_file" "ensure_asset_project_thumbnails_zip" {
  type        = "zip"
  source_file = "../backend/dist/ensureAssetProjectThumbnails.js"
  output_path = "${path.module}/zips/ensureAssetProjectThumbnails.zip"
}

resource "aws_lambda_function" "ensure_asset_project_thumbnails" {
  filename         = data.archive_file.ensure_asset_project_thumbnails_zip.output_path
  function_name    = "${var.project_name}-ensure-asset-project-thumbnails"
  role             = aws_iam_role.lambda_role.arn
  handler          = "ensureAssetProjectThumbnails.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.ensure_asset_project_thumbnails_zip.output_base64sha256
  timeout          = 300
  memory_size      = 1024
  layers           = [aws_lambda_layer_version.ffmpeg.arn]

  environment {
    variables = {
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      ASSETS_TABLE            = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
      BUCKET_NAME             = aws_s3_bucket.media.bucket
      CLOUDFRONT_DOMAIN                = aws_cloudfront_distribution.media.domain_name
      CLOUDFRONT_KEY_PAIR_ID           = aws_cloudfront_public_key.media.id
      CLOUDFRONT_PRIVATE_KEY_SECRET_ARN = aws_secretsmanager_secret.cloudfront_private_key.arn
      FFMPEG_PATH                      = "/opt/bin/ffmpeg"
    }
  }
}
