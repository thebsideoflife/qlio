# Whisper transcription (async after upload) and on-demand caption translation

data "archive_file" "transcribe_asset_zip" {
  type        = "zip"
  source_file = "../backend/dist/transcribeAsset.js"
  output_path = "${path.module}/zips/transcribeAsset.zip"
}

resource "aws_lambda_function" "transcribe_asset" {
  filename         = data.archive_file.transcribe_asset_zip.output_path
  function_name    = "${var.project_name}-transcribe-asset"
  role             = aws_iam_role.lambda_role.arn
  handler          = "transcribeAsset.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.transcribe_asset_zip.output_base64sha256
  timeout          = 900
  memory_size      = 3008
  layers           = [aws_lambda_layer_version.ffmpeg.arn]

  ephemeral_storage {
    size = 10240
  }

  # Whisper runs on SporeLabs (POST /v1/audio/transcribe); this Lambda extracts the
  # audio, submits one job for the whole file and polls it, continuing in a fresh
  # invocation when a job outlives this one.
  environment {
    variables = merge(local.sporelabs_env, {
      TABLE_NAME     = aws_dynamodb_table.assets.name
      PROJECTS_TABLE = aws_dynamodb_table.projects.name
      BUCKET_NAME    = aws_s3_bucket.media.id
      FFMPEG_PATH    = "/opt/bin/ffmpeg"
      FFPROBE_PATH   = "/opt/bin/ffprobe"
    })
  }
}

data "archive_file" "translate_captions_zip" {
  type        = "zip"
  source_file = "../backend/dist/translateCaptions.js"
  output_path = "${path.module}/zips/translateCaptions.zip"
}

resource "aws_lambda_function" "translate_captions" {
  filename         = data.archive_file.translate_captions_zip.output_path
  function_name    = "${var.project_name}-translate-captions"
  role             = aws_iam_role.lambda_role.arn
  handler          = "translateCaptions.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.translate_captions_zip.output_base64sha256
  timeout          = 900
  memory_size      = 512

  environment {
    variables = merge(local.sporelabs_env, {
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      ASSETS_TABLE            = aws_dynamodb_table.assets.name
      BUCKET_NAME             = aws_s3_bucket.media.id
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
      TRANSLATE_FUNCTION_NAME = "${var.project_name}-translate-captions"
    })
  }
}

resource "aws_apigatewayv2_integration" "translate_captions" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.translate_captions.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "translate_captions" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /projects/{projectId}/captions/translate"
  target    = "integrations/${aws_apigatewayv2_integration.translate_captions.id}"
}

resource "aws_lambda_permission" "api_gw_translate_captions" {
  statement_id  = "AllowExecutionFromAPIGatewayTranslateCaptions"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.translate_captions.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/projects/*/captions/translate"
}

data "archive_file" "retry_transcription_zip" {
  type        = "zip"
  source_file = "../backend/dist/retryTranscription.js"
  output_path = "${path.module}/zips/retryTranscription.zip"
}

resource "aws_lambda_function" "retry_transcription" {
  filename         = data.archive_file.retry_transcription_zip.output_path
  function_name    = "${var.project_name}-retry-transcription"
  role             = aws_iam_role.lambda_role.arn
  handler          = "retryTranscription.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.retry_transcription_zip.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = {
      TABLE_NAME               = aws_dynamodb_table.assets.name
      BUCKET_NAME              = aws_s3_bucket.media.id
      TRANSCRIBE_FUNCTION_NAME = aws_lambda_function.transcribe_asset.function_name
      API_PASSWORD_SECRET_ARN  = aws_secretsmanager_secret.api_password.arn
    }
  }

  depends_on = [aws_lambda_function.transcribe_asset]
}

resource "aws_apigatewayv2_integration" "retry_transcription" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.retry_transcription.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "retry_transcription" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /assets/{assetId}/transcribe"
  target    = "integrations/${aws_apigatewayv2_integration.retry_transcription.id}"
}

resource "aws_lambda_permission" "api_gw_retry_transcription" {
  statement_id  = "AllowExecutionFromAPIGatewayRetryTranscription"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.retry_transcription.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/assets/*/transcribe"
}
