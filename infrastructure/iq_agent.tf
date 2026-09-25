# ============================================================================
# IQ Agent — conversational cutting agent (SPEC-iq-agent.md)
#
# Two Lambdas that never talk to each other directly:
#   - iq-agent-api    fast, synchronous; validates, takes the run lock, kicks
#                     the worker, and serves the event log to the client
#   - iq-agent-worker long-running; runs the agent loop and appends events
#
# They coordinate entirely through two DynamoDB tables.
# ============================================================================

# --- Thread state: one row per project ---------------------------------------
# Conversation, working segments, the run lock, the heartbeat, and the seq
# counter all live here. One row is the whole durability story.
resource "aws_dynamodb_table" "agent_threads" {
  name         = "${var.project_name}-agent-threads"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "projectId"

  attribute {
    name = "projectId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

# --- Event log: append-only, seq-ordered, keyed by project -------------------
# Keyed by project rather than by run so the panel keeps one continuous
# transcript across runs and refreshes. The client polls (projectId, seq > n).
resource "aws_dynamodb_table" "agent_events" {
  name         = "${var.project_name}-agent-events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "projectId"
  range_key    = "seq"

  attribute {
    name = "projectId"
    type = "S"
  }

  attribute {
    name = "seq"
    type = "N"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

resource "aws_iam_role_policy" "agent_tables" {
  name = "${var.project_name}-agent-tables-policy"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:BatchWriteItem"
        ]
        Resource = [
          aws_dynamodb_table.agent_threads.arn,
          aws_dynamodb_table.agent_events.arn,
          "${aws_dynamodb_table.agent_events.arn}/index/*"
        ]
      }
    ]
  })
}

# ============================================================================
# Worker
# ============================================================================

data "archive_file" "iq_agent_worker_zip" {
  type        = "zip"
  source_file = "../backend/dist/iqAgentWorker.js"
  output_path = "${path.module}/zips/iqAgentWorker.zip"
}

resource "aws_lambda_function" "iq_agent_worker" {
  filename         = data.archive_file.iq_agent_worker_zip.output_path
  function_name    = "${var.project_name}-iq-agent-worker"
  role             = aws_iam_role.lambda_role.arn
  handler          = "iqAgentWorker.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.iq_agent_worker_zip.output_base64sha256

  # 15 minutes is the ceiling, not the plan: the loop persists and self-invokes
  # a continuation when less than 150s remains, so a turn is never truncated.
  timeout     = 900
  memory_size = 2048

  # view_frames shells out to FFmpeg to pull stills from the source video.
  layers = [aws_lambda_layer_version.ffmpeg.arn]

  ephemeral_storage {
    size = 2048
  }

  environment {
    variables = merge(local.sporelabs_env, {
      PROJECTS_TABLE                = aws_dynamodb_table.projects.name
      ASSETS_TABLE                  = aws_dynamodb_table.assets.name
      AGENT_THREADS_TABLE           = aws_dynamodb_table.agent_threads.name
      AGENT_EVENTS_TABLE            = aws_dynamodb_table.agent_events.name
      BUCKET_NAME                   = aws_s3_bucket.media.bucket
      SECRET_ARN                    = aws_secretsmanager_secret.twelve_labs_key.arn
      TWELVE_LABS_INDEX_ID          = var.twelve_labs_index_id
      ANALYZE_FRAMING_FUNCTION_NAME = aws_lambda_function.analyze_framing.function_name
      API_PASSWORD_SECRET_ARN       = aws_secretsmanager_secret.api_password.arn
    })
  }
}

# The worker is invoked asynchronously, which retries twice by default. A run
# that hits the 900s ceiling would be re-invoked with the same runId and resume
# alongside its own continuation. The loop fences duplicates with a run epoch;
# this stops Lambda from creating them in the first place.
resource "aws_lambda_function_event_invoke_config" "iq_agent_worker" {
  function_name          = aws_lambda_function.iq_agent_worker.function_name
  maximum_retry_attempts = 0
}

# ============================================================================
# API
# ============================================================================

data "archive_file" "iq_agent_api_zip" {
  type        = "zip"
  source_file = "../backend/dist/iqAgentApi.js"
  output_path = "${path.module}/zips/iqAgentApi.zip"
}

resource "aws_lambda_function" "iq_agent_api" {
  filename         = data.archive_file.iq_agent_api_zip.output_path
  function_name    = "${var.project_name}-iq-agent-api"
  role             = aws_iam_role.lambda_role.arn
  handler          = "iqAgentApi.handler"
  runtime          = "nodejs20.x"
  source_code_hash = data.archive_file.iq_agent_api_zip.output_base64sha256
  timeout          = 15
  memory_size      = 512

  environment {
    variables = {
      PROJECTS_TABLE             = aws_dynamodb_table.projects.name
      ASSETS_TABLE               = aws_dynamodb_table.assets.name
      AGENT_THREADS_TABLE        = aws_dynamodb_table.agent_threads.name
      AGENT_EVENTS_TABLE         = aws_dynamodb_table.agent_events.name
      AGENT_WORKER_FUNCTION_NAME = aws_lambda_function.iq_agent_worker.function_name
      BUCKET_NAME                = aws_s3_bucket.media.bucket
      TWELVE_LABS_INDEX_ID       = var.twelve_labs_index_id
      API_PASSWORD_SECRET_ARN    = aws_secretsmanager_secret.api_password.arn
    }
  }
}

resource "aws_apigatewayv2_integration" "iq_agent_api" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.iq_agent_api.invoke_arn
  payload_format_version = "2.0"
}

locals {
  iq_agent_routes = {
    send_message  = "POST /projects/{projectId}/agent/messages"
    read_events   = "GET /projects/{projectId}/agent/events"
    cancel_run    = "POST /projects/{projectId}/agent/cancel"
    read_prompts  = "GET /projects/{projectId}/agent/prompts"
    write_prompts = "POST /projects/{projectId}/agent/prompts"
  }
}

resource "aws_apigatewayv2_route" "iq_agent" {
  for_each = local.iq_agent_routes

  api_id    = aws_apigatewayv2_api.main.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.iq_agent_api.id}"
}

resource "aws_lambda_permission" "api_gw_iq_agent" {
  statement_id  = "AllowExecutionFromAPIGatewayIQAgent"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.iq_agent_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*/projects/*/agent/*"
}
