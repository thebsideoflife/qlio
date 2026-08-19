resource "aws_apigatewayv2_integration" "package_export" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.package_export.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "package_export_post" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /projects/{projectId}/export-package"
  target    = "integrations/${aws_apigatewayv2_integration.package_export.id}"
}

resource "aws_apigatewayv2_route" "package_export_get" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /projects/{projectId}/export-package"
  target    = "integrations/${aws_apigatewayv2_integration.package_export.id}"
}

resource "aws_lambda_permission" "api_gw_package_export" {
  statement_id  = "AllowExecutionFromAPIGatewayPackageExport"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.package_export.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/projects/*/export-package"
}
