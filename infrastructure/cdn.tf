# CloudFront CDN for video streaming
# Provides low-latency video delivery with edge caching

# Origin Access Control for secure S3 access
resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "${var.project_name}-media-oac"
  description                       = "OAC for media bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront key pair for signed URLs
resource "aws_cloudfront_public_key" "media" {
  name        = "${var.project_name}-media-key"
  encoded_key = tls_private_key.cloudfront.public_key_pem
}

resource "aws_cloudfront_key_group" "media" {
  name  = "${var.project_name}-media-key-group"
  items = [aws_cloudfront_public_key.media.id]
}

# Generate RSA key pair for CloudFront signing
resource "tls_private_key" "cloudfront" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

# Store private key in Secrets Manager for Lambda access
resource "aws_secretsmanager_secret" "cloudfront_private_key" {
  name = "${var.project_name}-cloudfront-private-key"
}

resource "aws_secretsmanager_secret_version" "cloudfront_private_key" {
  secret_id     = aws_secretsmanager_secret.cloudfront_private_key.id
  secret_string = tls_private_key.cloudfront.private_key_pem
}

# CORS so the editor can fetch thumbnails/poster art into the export zip
resource "aws_cloudfront_response_headers_policy" "media_cors" {
  name    = "${var.project_name}-media-cors"
  comment = "Allow the Qlio editor to download thumbnails into the export package"

  cors_config {
    access_control_allow_credentials = false

    access_control_allow_headers {
      items = ["*"]
    }

    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS"]
    }

    access_control_allow_origins {
      items = ["*"]
    }

    access_control_max_age_sec = 3000
    origin_override            = true
  }
}

# CloudFront distribution
resource "aws_cloudfront_distribution" "media" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.project_name} media CDN"
  default_root_object = ""
  price_class         = "PriceClass_100" # US, Canada, Europe (cheapest)

  origin {
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_id                = "S3-${aws_s3_bucket.media.id}"
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.media.id}"

    # Use signed URLs for all requests
    trusted_key_groups = [aws_cloudfront_key_group.media.id]

    forwarded_values {
      query_string = false
      headers      = ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]

      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 86400    # 1 day
    max_ttl                = 31536000 # 1 year

    # Enable compression for faster delivery
    compress = true
  }

  # Raw uploads (editor preview) — must not compress; browsers use Range requests
  ordered_cache_behavior {
    path_pattern     = "raw/*"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.media.id}"

    trusted_key_groups = [aws_cloudfront_key_group.media.id]

    forwarded_values {
      query_string = false
      headers      = ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers", "Range"]

      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 604800
    max_ttl                = 31536000
    compress               = false
  }

  # Annotated sources (framing analysis copies)
  ordered_cache_behavior {
    path_pattern     = "annotated/*"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.media.id}"

    trusted_key_groups = [aws_cloudfront_key_group.media.id]

    forwarded_values {
      query_string = false
      headers      = ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers", "Range"]

      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 604800
    max_ttl                = 31536000
    compress               = false
  }

  # Thumbnail JPEGs — binary; do not gzip
  ordered_cache_behavior {
    path_pattern               = "thumbnails/*"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "S3-${aws_s3_bucket.media.id}"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.media_cors.id

    trusted_key_groups = [aws_cloudfront_key_group.media.id]

    forwarded_values {
      query_string = false
      headers      = ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]

      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 86400
    max_ttl                = 31536000
    compress               = false
  }

  # Cache behavior for video files - longer cache, byte-range support
  ordered_cache_behavior {
    path_pattern     = "videos/*"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3-${aws_s3_bucket.media.id}"

    trusted_key_groups = [aws_cloudfront_key_group.media.id]

    forwarded_values {
      query_string = false
      headers      = ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers", "Range"]

      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 604800   # 7 days for videos
    max_ttl                = 31536000 # 1 year
    compress               = false    # Don't compress video (already compressed)
  }

  # CORS for video player
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name = "${var.project_name}-media-cdn"
  }
}

# Update S3 bucket policy to allow CloudFront OAC access
resource "aws_s3_bucket_policy" "media_cloudfront" {
  bucket = aws_s3_bucket.media.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontOAC"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.media.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.media.arn
          }
        }
      }
    ]
  })
}

# Outputs for Lambda environment variables
output "cloudfront_distribution_domain" {
  value       = aws_cloudfront_distribution.media.domain_name
  description = "CloudFront distribution domain name"
}

output "cloudfront_key_pair_id" {
  value       = aws_cloudfront_public_key.media.id
  description = "CloudFront key pair ID for signed URLs"
}

output "cloudfront_private_key_secret_arn" {
  value       = aws_secretsmanager_secret.cloudfront_private_key.arn
  description = "ARN of the CloudFront private key secret"
}
