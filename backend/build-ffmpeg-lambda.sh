#!/bin/bash
set -e

# Build and push the FFmpeg Lambda Docker image to ECR

# Configuration
AWS_PROFILE="${AWS_PROFILE:-zeevee}"
AWS_REGION="${AWS_REGION:-us-west-2}"
ECR_REPO_NAME="zeevee-ffmpeg-lambda"

echo "Building FFmpeg Lambda Docker image..."

# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --profile "$AWS_PROFILE" --query Account --output text)
ECR_URL="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

echo "ECR URL: $ECR_URL"

# Build the TypeScript first
echo "Building TypeScript..."
npm run build

# Login to ECR
echo "Logging in to ECR..."
aws ecr get-login-password --profile "$AWS_PROFILE" --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# Build Docker image (force linux/amd64 for Lambda compatibility, even on ARM Macs)
# --provenance=false disables attestations that cause OCI manifest format
# (Lambda requires Docker V2 manifest format, not OCI)
echo "Building Docker image..."
docker build --platform linux/amd64 --provenance=false -f Dockerfile.ffmpeg -t "${ECR_REPO_NAME}:latest" .

# Tag for ECR
docker tag "${ECR_REPO_NAME}:latest" "${ECR_URL}:latest"

# Push to ECR
echo "Pushing to ECR..."
docker push "${ECR_URL}:latest"

echo "Done! Image pushed to: ${ECR_URL}:latest"

# Update Lambda functions that use this image
echo "Updating stitch-segments Lambda..."
aws lambda update-function-code \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --function-name "zeevee-stitch-segments" \
  --image-uri "${ECR_URL}:latest" \
  --publish

echo "Updating split-video Lambda..."
aws lambda update-function-code \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --function-name "zeevee-split-video" \
  --image-uri "${ECR_URL}:latest" \
  --publish

echo "Lambda functions updated!"

