resource "aws_s3_bucket" "media" {
  bucket = "${var.project_name}-media-${var.stage}"
}

resource "aws_s3_bucket_accelerate_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  status = "Enabled"
}

resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "POST", "GET", "HEAD", "DELETE"]
    allowed_origins = ["*"] # In prod, restrict to domain
    expose_headers  = ["ETag", "x-amz-server-side-encryption", "x-amz-request-id", "x-amz-id-2"]
    max_age_seconds = 3000
  }
}

# Notification is circular dependency if defined here with Lambda not yet existing.
# Will define it in compute.tf or use aws_s3_bucket_notification resource after lambda is defined.

resource "aws_dynamodb_table" "assets" {
  name         = "${var.project_name}-assets"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "assetId"

  attribute {
    name = "assetId"
    type = "S"
  }

  attribute {
    name = "twelveLabsTaskId"
    type = "S"
  }

  global_secondary_index {
    name            = "TaskIdIndex"
    hash_key        = "twelveLabsTaskId"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "projects" {
  name         = "${var.project_name}-projects"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "projectId"

  attribute {
    name = "projectId"
    type = "S"
  }

  attribute {
    name = "assetId"
    type = "S"
  }

  global_secondary_index {
    name            = "AssetIdIndex"
    hash_key        = "assetId"
    projection_type = "ALL"
  }
}
