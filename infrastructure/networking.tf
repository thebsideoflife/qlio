resource "aws_apigatewayv2_api" "main" {
  name          = "${var.project_name}-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "OPTIONS", "PATCH", "DELETE"]
    allow_headers = ["*"]
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  # Generous throttling - prevents runaway loops, won't affect normal use
  default_route_settings {
    throttling_burst_limit = 100 # Max concurrent requests
    throttling_rate_limit  = 200 # Requests per second
  }
}

# Generate Upload Credentials (for multipart uploads)
resource "aws_apigatewayv2_integration" "generate_upload_credentials" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.generate_upload_credentials.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "generate_upload_credentials" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /upload"
  target    = "integrations/${aws_apigatewayv2_integration.generate_upload_credentials.id}"
}

resource "aws_lambda_permission" "api_gw_upload" {
  statement_id  = "AllowExecutionFromAPIGatewayUpload"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.generate_upload_credentials.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/upload"
}

# Process Webhook
resource "aws_apigatewayv2_integration" "process_webhook" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.process_webhook.invoke_arn
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
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.list_assets.invoke_arn
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
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.get_asset.invoke_arn
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
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.update_asset.invoke_arn
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
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.create_project.invoke_arn
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

# Project Ops (Get/Delete)
resource "aws_apigatewayv2_integration" "project_ops" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.project_ops.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "get_project" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /projects/{projectId}"
  target    = "integrations/${aws_apigatewayv2_integration.project_ops.id}"
}

resource "aws_apigatewayv2_route" "delete_project" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "DELETE /projects/{projectId}"
  target    = "integrations/${aws_apigatewayv2_integration.project_ops.id}"
}

resource "aws_lambda_permission" "api_gw_project_ops" {
  statement_id  = "AllowExecutionFromAPIGatewayProjectOps"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.project_ops.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/projects/*"
}

# List Projects
resource "aws_apigatewayv2_integration" "list_projects" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.list_projects.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "list_projects" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /projects"
  target    = "integrations/${aws_apigatewayv2_integration.list_projects.id}"
}

resource "aws_lambda_permission" "api_gw_list_projects" {
  statement_id  = "AllowExecutionFromAPIGatewayListProjects"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.list_projects.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/projects"
}

# Delete Asset
resource "aws_apigatewayv2_integration" "delete_asset" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.delete_asset.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "delete_asset" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "DELETE /assets/{assetId}"
  target    = "integrations/${aws_apigatewayv2_integration.delete_asset.id}"
}

resource "aws_lambda_permission" "api_gw_delete_asset" {
  statement_id  = "AllowExecutionFromAPIGatewayDeleteAsset"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.delete_asset.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/assets/*"
}

# Generate Segments
resource "aws_apigatewayv2_integration" "generate_segments" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.generate_segments.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "generate_segments" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /projects/{projectId}/generate"
  target    = "integrations/${aws_apigatewayv2_integration.generate_segments.id}"
}

resource "aws_lambda_permission" "api_gw_generate_segments" {
  statement_id  = "AllowExecutionFromAPIGatewayGenerateSegments"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.generate_segments.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/projects/*/generate"
}

# Analyze Framing (Smart Autoframing)
resource "aws_apigatewayv2_integration" "analyze_framing" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.analyze_framing.invoke_arn
  payload_format_version = "2.0"
}

# Route with segmentId parameter
resource "aws_apigatewayv2_route" "analyze_framing_segment" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /projects/{projectId}/segments/{segmentId}/analyze-framing"
  target    = "integrations/${aws_apigatewayv2_integration.analyze_framing.id}"
}

# Route without segmentId (for analyzing arbitrary time ranges)
resource "aws_apigatewayv2_route" "analyze_framing_project" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /projects/{projectId}/analyze-framing"
  target    = "integrations/${aws_apigatewayv2_integration.analyze_framing.id}"
}

resource "aws_lambda_permission" "api_gw_analyze_framing" {
  statement_id  = "AllowExecutionFromAPIGatewayAnalyzeFraming"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.analyze_framing.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/projects/*"
}

output "api_url" {
  value = aws_apigatewayv2_api.main.api_endpoint
}
