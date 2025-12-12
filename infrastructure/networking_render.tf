# ===== API Gateway Routes for Remotion Rendering =====

# Render Video
resource "aws_apigatewayv2_integration" "render_video" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.render_video.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "render_video" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /projects/{projectId}/render"
  target    = "integrations/${aws_apigatewayv2_integration.render_video.id}"
}

resource "aws_lambda_permission" "api_gw_render_video" {
  statement_id  = "AllowExecutionFromAPIGatewayRenderVideo"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.render_video.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/projects/*/render"
}

# Get Render Status
resource "aws_apigatewayv2_integration" "get_render_status" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.get_render_status.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "get_render_status" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /renders/{jobId}"
  target    = "integrations/${aws_apigatewayv2_integration.get_render_status.id}"
}

resource "aws_lambda_permission" "api_gw_get_render_status" {
  statement_id  = "AllowExecutionFromAPIGatewayGetRenderStatus"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_render_status.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/renders/*"
}
