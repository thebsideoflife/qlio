#!/bin/bash
set -e

# ZeeVee Full Deployment Script
# Usage: ./deploy.sh [--skip-docker]
#
# Options:
#   --skip-docker    Skip building/pushing the FFmpeg Docker image (faster for non-stitch changes)

SKIP_DOCKER=false
for arg in "$@"; do
  case $arg in
    --skip-docker)
      SKIP_DOCKER=true
      shift
      ;;
  esac
done

echo "========================================"
echo "  ZeeVee Deployment"
echo "========================================"
echo ""

# Configuration
AWS_PROFILE="${AWS_PROFILE:-zeevee}"
AWS_REGION="${AWS_REGION:-us-west-2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Optional OpenTofu variables file (override path with INFRA_TFVARS)
INFRA_TFVARS="${INFRA_TFVARS:-$SCRIPT_DIR/infrastructure/terraform.tfvars}"
TOFU_VAR_ARGS=()
if [ -f "$INFRA_TFVARS" ]; then
  TOFU_VAR_ARGS=(-var-file="$INFRA_TFVARS")
fi

cd "$SCRIPT_DIR"

# Step 1: Build backend
echo "[1/4] Building backend..."
cd backend
npm run build
./package-render.sh
cd ..
echo "✓ Backend built"
echo ""

# Step 2: Check if ECR exists (for FFmpeg Lambda)
echo "[2/4] Checking infrastructure..."
cd infrastructure

# Create zips directory if it doesn't exist
mkdir -p zips

ECR_EXISTS=$(aws ecr describe-repositories --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --repository-names "zeevee-ffmpeg-lambda" 2>/dev/null && echo "yes" || echo "no")

if [ "$ECR_EXISTS" = "no" ]; then
  echo "  ECR repository doesn't exist, creating it first..."
  tofu apply "${TOFU_VAR_ARGS[@]}" -target=aws_ecr_repository.ffmpeg_lambda -target=aws_ecr_lifecycle_policy.ffmpeg_lambda -auto-approve
  echo "  ✓ ECR repository created"
fi
cd ..
echo "✓ Infrastructure checked"
echo ""

# Step 3: Build and push Docker image (if needed)
if [ "$SKIP_DOCKER" = true ]; then
  echo "[3/4] Skipping Docker build (--skip-docker flag)"
else
  echo "[3/4] Building FFmpeg Lambda Docker image..."
  cd backend
  
  # Check if image needs to be built (ECR is empty or we want to force rebuild)
  ACCOUNT_ID=$(aws sts get-caller-identity --profile "$AWS_PROFILE" --query Account --output text)
  ECR_URL="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/zeevee-ffmpeg-lambda"
  
  # Login to ECR
  aws ecr get-login-password --profile "$AWS_PROFILE" --region "$AWS_REGION" | \
    docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com" 2>/dev/null
  
  # Check if image exists
  IMAGE_EXISTS=$(aws ecr describe-images --profile "$AWS_PROFILE" --region "$AWS_REGION" \
    --repository-name "zeevee-ffmpeg-lambda" --image-ids imageTag=latest 2>/dev/null && echo "yes" || echo "no")
  
  if [ "$IMAGE_EXISTS" = "no" ]; then
    echo "  Building Docker image (this may take a few minutes on first run)..."
    docker build --platform linux/amd64 -f Dockerfile.ffmpeg -t "zeevee-ffmpeg-lambda:latest" .
    docker tag "zeevee-ffmpeg-lambda:latest" "${ECR_URL}:latest"
    docker push "${ECR_URL}:latest"
    echo "  ✓ Docker image pushed to ECR"
  else
    echo "  Docker image already exists in ECR (use --rebuild-docker to force)"
  fi
  cd ..
fi
echo ""

# Step 4: Apply all infrastructure
echo "[4/4] Applying infrastructure..."
cd infrastructure
tofu apply "${TOFU_VAR_ARGS[@]}" -auto-approve
cd ..
echo "✓ Infrastructure deployed"
echo ""

echo "========================================"
echo "  Deployment Complete!"
echo "========================================"
echo ""
echo "API URL: https://4bvanrvph5.execute-api.us-west-2.amazonaws.com"
echo ""

# ============================================================================
# OPERATIONS REFERENCE
# ============================================================================
#
# Scene Detection Commands:
# -------------------------
# Scene detection runs automatically on first segment generation, but you can
# trigger it manually or clear caches as needed.
#
# Trigger scene detection for an asset:
#   aws lambda invoke \
#     --function-name zeevee-detect-scenes \
#     --invocation-type Event \
#     --cli-binary-format raw-in-base64-out \
#     --payload '{"assetId": "YOUR_ASSET_ID"}' \
#     /dev/null
#
# Clear scene cache for a single asset:
#   aws s3 rm s3://${BUCKET}/scene-cache/${ASSET_ID}.json
#
# Clear ALL scene caches (do this before deploying SceneBreak schema changes):
#   aws s3 rm s3://zeevee-assets/scene-cache/ --recursive
#
# Check scene cache status:
#   aws s3 cp s3://zeevee-assets/scene-cache/${ASSET_ID}.json - | jq .
#
# View Lambda logs:
#   aws logs tail /aws/lambda/zeevee-detect-scenes --follow
#   aws logs tail /aws/lambda/zeevee-generate-segments --follow
#
# ============================================================================

