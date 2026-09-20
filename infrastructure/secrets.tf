resource "aws_secretsmanager_secret" "twelve_labs_key" {
  name        = "${var.project_name}/12labs-key"
  description = "API Key for Twelve Labs"
}

# Personal Twelve Labs key (e.g. Jockey/Agents beta on individual account).
# Org key remains ${var.project_name}/12labs-key. Set the value in Secrets Manager console or:
# aws secretsmanager put-secret-value --secret-id ${var.project_name}/coleman-jockey-12labs-key --secret-string 'tlk_...'
resource "aws_secretsmanager_secret" "coleman_jockey_twelve_labs_key" {
  name        = "${var.project_name}/coleman-jockey-12labs-key"
  description = "Personal Twelve Labs API key for Jockey/agents (coleman); not org key"
}

resource "aws_secretsmanager_secret_version" "coleman_jockey_twelve_labs_key" {
  secret_id     = aws_secretsmanager_secret.coleman_jockey_twelve_labs_key.id
  secret_string = "REPLACE_ME_PASTE_YOUR_PERSONAL_TL_KEY"

  lifecycle {
    ignore_changes = [secret_string]
  }
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

# Created out of band (same pattern as Anthropic):
# aws --profile zeevee --region us-west-2 secretsmanager create-secret \
#   --name zeevee/openrouter-api-key \
#   --secret-string 'sk-or-...'
data "aws_secretsmanager_secret" "openrouter_api_key" {
  name = "${var.project_name}/openrouter-api-key"
}

resource "aws_secretsmanager_secret" "sporelabs_api_key" {
  name        = "${var.project_name}/sporelabs-api-key"
  description = "SporeLabs API key for OpenAI-compatible LLM, Whisper, and Gemini calls"
}

resource "aws_secretsmanager_secret_version" "sporelabs_api_key" {
  secret_id     = aws_secretsmanager_secret.sporelabs_api_key.id
  secret_string = "REPLACE_ME_PASTE_SPORELABS_KEY"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

locals {
  sporelabs_env = {
    SPORELABS_SECRET_ARN = aws_secretsmanager_secret.sporelabs_api_key.arn
    SPORELABS_BASE_URL   = "https://sporelabs.dev/v1"
  }
}
