# --- Showcase catalogue (read-only feed for the qlio-showcase Expo app) ---
data "archive_file" "showcase_zip" {
  type        = "zip"
  source_file = "../backend/dist/showcase.js"
  output_path = "${path.module}/zips/showcase.zip"
}

resource "aws_lambda_function" "showcase_catalogue" {
  filename         = data.archive_file.showcase_zip.output_path
  function_name    = "${var.project_name}-showcase-catalogue"
  role             = aws_iam_role.lambda_role.arn
  handler          = "showcase.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.showcase_zip.output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      PROJECTS_TABLE = aws_dynamodb_table.projects.name
      ASSETS_TABLE   = aws_dynamodb_table.assets.name
      # Renders bucket (zeevee-renders-dev) is preferred over Remotion-Lambda keys.
      RENDERS_BUCKET                    = aws_s3_bucket.renders.id
      BUCKET_NAME                       = aws_s3_bucket.media.bucket
      CLOUDFRONT_DOMAIN                 = aws_cloudfront_distribution.media.domain_name
      CLOUDFRONT_KEY_PAIR_ID            = aws_cloudfront_public_key.media.id
      CLOUDFRONT_PRIVATE_KEY_SECRET_ARN = aws_secretsmanager_secret.cloudfront_private_key.arn
      # Dedicated showcase read key — deliberately not API_PASSWORD_SECRET_ARN.
      SHOWCASE_API_KEY_SECRET_ARN = aws_secretsmanager_secret.showcase_read_key.arn
    }
  }
}
