resource "aws_secretsmanager_secret" "sporelabs_api_key" {
  name        = "${var.project_name}/sporelabs-api-key"
  description = "SporeLabs API key for OpenAI-compatible LLM, Whisper, Gemini and video reframe calls"
}
resource "aws_secretsmanager_secret_version" "sporelabs_api_key" {
  secret_id     = aws_secretsmanager_secret.sporelabs_api_key.id
  secret_string = "REPLACE_ME_PASTE_SPORELABS_KEY"
  lifecycle { ignore_changes = [secret_string] }
}
locals {
  sporelabs_env = {
    SPORELABS_SECRET_ARN = aws_secretsmanager_secret.sporelabs_api_key.arn
    SPORELABS_BASE_URL   = "https://sporelabs.dev/v1"
  }
}

variable "framing_engine" {
  description = "analyze_framing engine: gemini (legacy) or sporelabs (shot-hold service)"
  type        = string
  default     = "sporelabs"
  validation {
    condition     = contains(["gemini", "sporelabs"], var.framing_engine)
    error_message = "framing_engine must be gemini or sporelabs."
  }
}
