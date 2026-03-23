resource "aws_secretsmanager_secret" "twelve_labs_key" {
  name        = "${var.project_name}/12labs-key"
  description = "API Key for Twelve Labs"
}

resource "aws_secretsmanager_secret" "api_password" {
  name        = "${var.project_name}/api-password"
  description = "Simple password for API protection"
}

resource "aws_secretsmanager_secret" "twelve_labs_signing_secret" {
  name        = "${var.project_name}/12labs-signing-secret"
  description = "Webhook Signing Secret for Twelve Labs"
}

# Reference the Anthropic API key secret (created manually via console/CLI)
# This is a data source since the secret was created outside of Terraform
data "aws_secretsmanager_secret" "anthropic_api_key" {
  name = "${var.project_name}/anthropic-api-key"
}

resource "aws_secretsmanager_secret" "gemini_api_key" {
  name        = "qlio/gemini-api-key"
  description = "API Key for Google Gemini"
}

# We don't set the version/value here to keep it out of git.
# User must manually set it in console: aws secretsmanager put-secret-value ...
