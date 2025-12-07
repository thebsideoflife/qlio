resource "aws_apigatewayv2_api" "main" {
  name          = "${var.project_name}-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["*"]
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id = aws_apigatewayv2_api.main.id
  name   = "$default"
  auto_deploy = true
}

# Generate Upload URL
resource "aws_apigatewayv2_integration" "generate_upload_url" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.generate_upload_url.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "generate_upload_url" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /upload"
  target    = "integrations/${aws_apigatewayv2_integration.generate_upload_url.id}"
}

resource "aws_lambda_permission" "api_gw_upload" {
  statement_id  = "AllowExecutionFromAPIGatewayUpload"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.generate_upload_url.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/upload"
}

# Process Webhook
resource "aws_apigatewayv2_integration" "process_webhook" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.process_webhook.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "process_webhook" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /webhook"
  target    = "integrations/${aws_apigatewayv2_integration.process_webhook.id}"
}

resource "aws_lambda_permission" "api_gw_webhook" {
  statement_id  = "AllowExecutionFromAPIGatewayWebhook"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.process_webhook.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/webhook"
}

# List Assets
resource "aws_apigatewayv2_integration" "list_assets" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.list_assets.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "list_assets" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /assets"
  target    = "integrations/${aws_apigatewayv2_integration.list_assets.id}"
}

resource "aws_lambda_permission" "api_gw_list" {
  statement_id  = "AllowExecutionFromAPIGatewayList"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.list_assets.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/assets"
}

output "api_url" {
  value = aws_apigatewayv2_api.main.api_endpoint
}

