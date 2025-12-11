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

# We don't set the version/value here to keep it out of git.
# User must manually set it in console: aws secretsmanager put-secret-value ...
