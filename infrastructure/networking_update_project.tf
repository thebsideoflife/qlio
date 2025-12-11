resource "aws_apigatewayv2_integration" "update_project" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.update_project.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "update_project" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "PATCH /projects/{projectId}"
  target    = "integrations/${aws_apigatewayv2_integration.update_project.id}"
}

resource "aws_lambda_permission" "api_gw_update_project" {
  statement_id  = "AllowExecutionFromAPIGatewayUpdateProject"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.update_project.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/projects/*"
}

