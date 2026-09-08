# ===== Showcase Catalogue API =====
# Read-only catalogue for the qlio-showcase Expo app. Auth is a dedicated
# Bearer read key (SHOWCASE_API_KEY_SECRET_ARN), not the dashboard x-api-password.

resource "aws_apigatewayv2_integration" "showcase_catalogue" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.showcase_catalogue.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "showcase_catalogue" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /showcase/catalogue"
  target    = "integrations/${aws_apigatewayv2_integration.showcase_catalogue.id}"
}

resource "aws_lambda_permission" "api_gw_showcase_catalogue" {
  statement_id  = "AllowExecutionFromAPIGatewayShowcaseCatalogue"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.showcase_catalogue.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/showcase/catalogue"
}
