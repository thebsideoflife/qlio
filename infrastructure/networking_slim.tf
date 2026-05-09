# Slim polling endpoints - lightweight status-only responses for efficient polling

# ============================================================================
# LIST ASSETS STATUS - Slim version without presigned URLs
# ============================================================================

data "archive_file" "list_assets_status_zip" {
  type        = "zip"
  source_file = "../backend/dist/listAssetsStatus.js"
  output_path = "${path.module}/zips/listAssetsStatus.zip"
}

resource "aws_lambda_function" "list_assets_status" {
  filename         = data.archive_file.list_assets_status_zip.output_path
  function_name    = "${var.project_name}-list-assets-status"
  role             = aws_iam_role.lambda_role.arn
  handler          = "listAssetsStatus.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.list_assets_status_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.assets.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}

resource "aws_apigatewayv2_integration" "list_assets_status" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.list_assets_status.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "list_assets_status" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /assets/status"
  target    = "integrations/${aws_apigatewayv2_integration.list_assets_status.id}"
}

resource "aws_lambda_permission" "api_gw_list_assets_status" {
  statement_id  = "AllowExecutionFromAPIGatewayListAssetsStatus"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.list_assets_status.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/assets/status"
}

# ============================================================================
# GET PROJECT JOB STATUS - Slim version for job polling
# ============================================================================

data "archive_file" "get_project_job_status_zip" {
  type        = "zip"
  source_file = "../backend/dist/getProjectJobStatus.js"
  output_path = "${path.module}/zips/getProjectJobStatus.zip"
}

resource "aws_lambda_function" "get_project_job_status" {
  filename         = data.archive_file.get_project_job_status_zip.output_path
  function_name    = "${var.project_name}-get-project-job-status"
  role             = aws_iam_role.lambda_role.arn
  handler          = "getProjectJobStatus.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.get_project_job_status_zip.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}

resource "aws_apigatewayv2_integration" "get_project_job_status" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.get_project_job_status.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "get_project_job_status" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /projects/{projectId}/job"
  target    = "integrations/${aws_apigatewayv2_integration.get_project_job_status.id}"
}

resource "aws_lambda_permission" "api_gw_get_project_job_status" {
  statement_id  = "AllowExecutionFromAPIGatewayGetProjectJobStatus"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.get_project_job_status.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/projects/*/job"
}
