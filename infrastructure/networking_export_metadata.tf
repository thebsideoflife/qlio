# ===== Export Metadata API =====

resource "aws_apigatewayv2_integration" "generate_export_metadata" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.generate_export_metadata.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "generate_export_metadata" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /projects/{projectId}/export-metadata"
  target    = "integrations/${aws_apigatewayv2_integration.generate_export_metadata.id}"
}

resource "aws_lambda_permission" "api_gw_generate_export_metadata" {
  statement_id  = "AllowExecutionFromAPIGatewayGenerateExportMetadata"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.generate_export_metadata.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/projects/*/export-metadata"
}
