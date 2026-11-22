# IAM users for people who need scoped AWS access (not application roles).
# IAM user names are account-wide, so only one environment (prod) creates
# them; dev sets create_external_users = false.

moved {
  from = aws_iam_user.jt_white_s3
  to   = aws_iam_user.jt_white_s3[0]
}

moved {
  from = aws_iam_user_policy.jt_white_s3
  to   = aws_iam_user_policy.jt_white_s3[0]
}

resource "aws_iam_user" "jt_white_s3" {
  count = var.create_external_users ? 1 : 0
  name  = "jt-white-s3"
  path  = "/external/"

  tags = {
    Name    = "JT White"
    Purpose = "S3 read/write: media and renders buckets"
  }
}

data "aws_iam_policy_document" "jt_white_s3" {
  statement {
    sid = "MediaBucket"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
      "s3:ListBucketMultipartUploads",
    ]
    resources = [aws_s3_bucket.media.arn]
  }

  statement {
    sid = "MediaObjects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  statement {
    sid = "RendersBucket"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
      "s3:ListBucketMultipartUploads",
    ]
    resources = [aws_s3_bucket.renders.arn]
  }

  statement {
    sid = "RendersObjects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.renders.arn}/*"]
  }
}

resource "aws_iam_user_policy" "jt_white_s3" {
  count  = var.create_external_users ? 1 : 0
  name   = "${var.project_name}-jt-white-s3"
  user   = aws_iam_user.jt_white_s3[0].name
  policy = data.aws_iam_policy_document.jt_white_s3.json
}

output "jt_white_s3_user_name" {
  description = "IAM user name for JT White (create access keys separately)."
  value       = one(aws_iam_user.jt_white_s3[*].name)
}

output "jt_white_s3_user_arn" {
  description = "IAM user ARN for JT White."
  value       = one(aws_iam_user.jt_white_s3[*].arn)
}
