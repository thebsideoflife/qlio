resource "aws_apigatewayv2_api" "main" {
  name          = "${var.project_name}-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "OPTIONS", "PATCH"]
    allow_headers = ["*"]
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id = aws_apigatewayv2_api.main.id
  name   = "$default"
  auto_deploy = true
}

# Generate Upload URL (Changed from GET to POST to accept metadata)
resource "aws_apigatewayv2_integration" "generate_upload_url" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.generate_upload_url.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "generate_upload_url" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /upload"
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

# Get Asset
resource "aws_apigatewayv2_integration" "get_asset" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.get_asset.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "get_asset" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /assets/{assetId}"
  target    = "integrations/${aws_apigatewayv2_integration.get_asset.id}"
}

resource "aws_lambda_permission" "api_gw_get_asset" {
  statement_id  = "AllowExecutionFromAPIGatewayGetAsset"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_asset.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/assets/*"
}

# Update Asset
resource "aws_apigatewayv2_integration" "update_asset" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.update_asset.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "update_asset" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "PATCH /assets/{assetId}"
  target    = "integrations/${aws_apigatewayv2_integration.update_asset.id}"
}

resource "aws_lambda_permission" "api_gw_update_asset" {
  statement_id  = "AllowExecutionFromAPIGatewayUpdateAsset"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.update_asset.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/assets/*"
}

# Create Project
resource "aws_apigatewayv2_integration" "create_project" {
  api_id           = aws_apigatewayv2_api.main.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.create_project.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "create_project" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /projects"
  target    = "integrations/${aws_apigatewayv2_integration.create_project.id}"
}

resource "aws_lambda_permission" "api_gw_create_project" {
  statement_id  = "AllowExecutionFromAPIGatewayCreateProject"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.create_project.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/projects"
}

output "api_url" {
  value = aws_apigatewayv2_api.main.api_endpoint
}
