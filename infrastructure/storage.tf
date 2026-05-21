resource "aws_s3_bucket" "media" {
  bucket = "${var.project_name}-media-${var.stage}"
}

# Block all public access - content is served via CloudFront signed URLs only
resource "aws_s3_bucket_public_access_block" "media" {
  bucket = aws_s3_bucket.media.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
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

# Auto-cleanup temporary files to prevent cost accumulation
resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  # Stitched videos are intermediate artifacts - delete after 1 day
  rule {
    id     = "cleanup-stitched"
    status = "Enabled"

    filter {
      prefix = "stitched/"
    }

    expiration {
      days = 1
    }
  }

  # Render outputs - user should download promptly, delete after 1 day
  rule {
    id     = "cleanup-renders"
    status = "Enabled"

    filter {
      prefix = "renders/"
    }

    expiration {
      days = 1
    }
  }

  # Chunk files are only needed during indexing - delete after 7 days
  rule {
    id     = "cleanup-chunks"
    status = "Enabled"

    filter {
      prefix = "chunks/"
    }

    expiration {
      days = 7
    }
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

# Lookup table for chunk task IDs to asset mapping
# This enables efficient webhook handling for chunked videos
resource "aws_dynamodb_table" "chunk_tasks" {
  name         = "${var.project_name}-chunk-tasks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "taskId"

  attribute {
    name = "taskId"
    type = "S"
  }

  # TTL to auto-cleanup old entries (tasks are only needed during indexing)
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}
