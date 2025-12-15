data "archive_file" "update_project_zip" {
  type        = "zip"
  source_file = "../backend/dist/updateProject.js"
  output_path = "${path.module}/zips/updateProject.zip"
}

resource "aws_lambda_function" "update_project" {
  filename         = data.archive_file.update_project_zip.output_path
  function_name    = "${var.project_name}-update-project"
  role             = aws_iam_role.lambda_role.arn
  handler          = "updateProject.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.update_project_zip.output_base64sha256
  timeout          = 30

  environment {
    variables = {
      PROJECTS_TABLE          = aws_dynamodb_table.projects.name
      API_PASSWORD_SECRET_ARN = aws_secretsmanager_secret.api_password.arn
    }
  }
}

