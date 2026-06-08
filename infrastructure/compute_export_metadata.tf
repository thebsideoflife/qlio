# --- Generate Export Metadata (Pegasus 1.5 clip analysis + thumbnails) ---
data "archive_file" "generate_export_metadata_zip" {
  type        = "zip"
  source_file = "../backend/dist/generateExportMetadata.js"
  output_path = "${path.module}/zips/generateExportMetadata.zip"
}

resource "aws_lambda_function" "generate_export_metadata" {
  filename         = data.archive_file.generate_export_metadata_zip.output_path
  function_name    = "${var.project_name}-generate-export-metadata"
  role             = aws_iam_role.lambda_role.arn
  handler          = "generateExportMetadata.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.generate_export_metadata_zip.output_base64sha256
  timeout          = 900
  memory_size      = 1024
  layers           = [aws_lambda_layer_version.ffmpeg.arn]

  environment {
    variables = {
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      ASSETS_TABLE            = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
      SECRET_ARN              = aws_secretsmanager_secret.twelve_labs_key.arn
      TWELVE_LABS_INDEX_ID    = var.twelve_labs_index_id
      BUCKET_NAME             = aws_s3_bucket.media.bucket
      CLOUDFRONT_DOMAIN                = aws_cloudfront_distribution.media.domain_name
      CLOUDFRONT_KEY_PAIR_ID           = aws_cloudfront_public_key.media.id
      CLOUDFRONT_PRIVATE_KEY_SECRET_ARN = aws_secretsmanager_secret.cloudfront_private_key.arn
      FFMPEG_PATH                      = "/opt/bin/ffmpeg"
    }
  }
}
