resource "aws_apigatewayv2_integration" "ensure_asset_project_thumbnails" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.ensure_asset_project_thumbnails.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "ensure_asset_project_thumbnails" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /assets/{assetId}/ensure-project-thumbnails"
  target    = "integrations/${aws_apigatewayv2_integration.ensure_asset_project_thumbnails.id}"
}

resource "aws_lambda_permission" "api_gw_ensure_asset_project_thumbnails" {
  statement_id  = "AllowExecutionFromAPIGatewayEnsureAssetProjectThumbnails"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ensure_asset_project_thumbnails.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/assets/*/ensure-project-thumbnails"
}
