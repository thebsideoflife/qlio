# --- Package export zip (scene videos + poster + thumbnails + metadata) ---
data "archive_file" "package_export_zip" {
  type        = "zip"
  source_file = "../backend/dist/packageExport.js"
  output_path = "${path.module}/zips/packageExport.zip"
}

resource "aws_lambda_function" "package_export" {
  filename         = data.archive_file.package_export_zip.output_path
  function_name    = "${var.project_name}-package-export"
  role             = aws_iam_role.lambda_role.arn
  handler          = "packageExport.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.package_export_zip.output_base64sha256
  timeout          = 900
  memory_size      = 2048

  environment {
    variables = {
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      BUCKET_NAME             = aws_s3_bucket.media.bucket
      RENDERS_BUCKET          = aws_s3_bucket.renders.id
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}
