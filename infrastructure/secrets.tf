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

# Bearer read key for the public showcase endpoints (qlio-showcase Expo app,
# EXPO_PUBLIC_QLIO_API_KEY). Deliberately separate from api-password so the
# demo app never holds a dashboard credential.
# Value is set out of band so it never lands in git:
#   aws --profile zeevee --region us-west-2 secretsmanager put-secret-value \
#     --secret-id ${var.project_name}/showcase-read-key --secret-string '<random key>'
resource "aws_secretsmanager_secret" "showcase_read_key" {
  name        = "${var.project_name}/showcase-read-key"
  description = "Bearer read key for GET /showcase/catalogue (qlio-showcase app)"
}

resource "aws_secretsmanager_secret" "twelve_labs_signing_secret" {
  name        = "${var.project_name}/12labs-signing-secret"
  description = "Webhook Signing Secret for Twelve Labs"
}

# Anthropic (zeevee/anthropic-api-key, out of band) and Gemini
# (qlio/gemini-api-key) keys are gone: every LLM call goes through SporeLabs
# (sporelabs.tf). Removing gemini_api_key from state schedules its deletion.

# Whisper transcription only, until it moves to SporeLabs. Created out of band:
# aws --profile zeevee --region us-west-2 secretsmanager create-secret \
#   --name zeevee/openrouter-api-key \
#   --secret-string 'sk-or-...'
# Dev reuses prod's secret by setting openrouter_secret_name.
data "aws_secretsmanager_secret" "openrouter_api_key" {
  name = coalesce(var.openrouter_secret_name, "${var.project_name}/openrouter-api-key")
}

# We don't set the version/value here to keep it out of git.
# User must manually set it in console: aws secretsmanager put-secret-value ...
