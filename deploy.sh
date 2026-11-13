#!/bin/bash
set -e

# ZeeVee Full Deployment Script
# Usage: ./deploy.sh [--env prod|dev] [--skip-docker | --stitch-only]
#
# Options:
#   --env ENV        Environment to deploy: prod (default) or dev.
#                    Each one has its own OpenTofu workspace, settings file
#                    (infrastructure/envs/ENV.tfvars) and resource names.
#   --skip-docker    Skip building/pushing the FFmpeg Docker image (faster for non-stitch changes)
#   --stitch-only    Build and deploy only the FFmpeg cutting Lambda image

SKIP_DOCKER=false
STITCH_ONLY=false
DEPLOY_ENV="${DEPLOY_ENV:-prod}"
while [ $# -gt 0 ]; do
  arg="$1"
  case $arg in
    --env)
      DEPLOY_ENV="${2:-}"
      shift 2
      continue
      ;;
    --env=*)
      DEPLOY_ENV="${arg#--env=}"
      shift
      continue
      ;;
    --skip-docker)
      SKIP_DOCKER=true
      shift
      ;;
    --stitch-only)
      STITCH_ONLY=true
      shift
      ;;
    *)
      echo "Unknown deploy option: $arg" >&2
      exit 1
      ;;
  esac
done

# Per-environment settings. PROJECT_NAME must match project_name in the
# environment's tfvars file, because it prefixes every resource name.
case "$DEPLOY_ENV" in
  prod)
    TOFU_WORKSPACE="default"
    PROJECT_NAME="zeevee"
    ;;
  dev)
    TOFU_WORKSPACE="dev"
    PROJECT_NAME="qlio-dev"
    ;;
  *)
    echo "Unknown environment: '$DEPLOY_ENV' (use prod or dev)" >&2
    exit 1
    ;;
esac
if [ "$SKIP_DOCKER" = true ] && [ "$STITCH_ONLY" = true ]; then
  echo "--skip-docker and --stitch-only cannot be used together" >&2
  exit 1
fi

echo "========================================"
echo "  ZeeVee Deployment: $DEPLOY_ENV"
echo "========================================"
echo ""

# Configuration
AWS_PROFILE="${AWS_PROFILE:-zeevee}"
AWS_REGION="${AWS_REGION:-us-west-2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Environment settings file, then an optional local override file
# (override path with INFRA_TFVARS; local files are gitignored).
TOFU_VAR_ARGS=(-var-file="$SCRIPT_DIR/infrastructure/envs/$DEPLOY_ENV.tfvars")
INFRA_TFVARS="${INFRA_TFVARS:-$SCRIPT_DIR/infrastructure/terraform.tfvars}"
if [ -f "$INFRA_TFVARS" ]; then
  TOFU_VAR_ARGS+=(-var-file="$INFRA_TFVARS")
fi

cd "$SCRIPT_DIR"

# Point OpenTofu at this environment's state before anything touches it.
# Always select explicitly: the selected workspace persists in .terraform/,
# so a dev deploy must never leave the next prod deploy pointing at dev.
echo "Selecting OpenTofu workspace '$TOFU_WORKSPACE'..."
if [ "$TOFU_WORKSPACE" = "default" ]; then
  tofu -chdir=infrastructure workspace select default
else
  tofu -chdir=infrastructure workspace select -or-create "$TOFU_WORKSPACE"
fi
CURRENT_WORKSPACE="$(tofu -chdir=infrastructure workspace show)"
if [ "$CURRENT_WORKSPACE" != "$TOFU_WORKSPACE" ]; then
  echo "Expected workspace '$TOFU_WORKSPACE' but OpenTofu is on '$CURRENT_WORKSPACE'" >&2
  exit 1
fi
echo ""

# Step 1: Build backend
echo "[1/4] Building backend..."
cd backend
npm run build
if [ "$STITCH_ONLY" = false ]; then
  ./package-render.sh
fi
cd ..
echo "✓ Backend built"
echo ""

# Step 2: Check if ECR exists (for FFmpeg Lambda)
echo "[2/4] Checking infrastructure..."
cd infrastructure

# Create zips directory if it doesn't exist
mkdir -p zips

ECR_EXISTS=$(aws ecr describe-repositories --profile "$AWS_PROFILE" --region "$AWS_REGION" \
  --repository-names "${PROJECT_NAME}-ffmpeg-lambda" 2>/dev/null && echo "yes" || echo "no")

if [ "$ECR_EXISTS" = "no" ]; then
  if [ "$STITCH_ONLY" = true ]; then
    echo "  FFmpeg ECR repository is missing; run the full deployment first" >&2
    exit 1
  fi
  echo "  ECR repository doesn't exist, creating it first..."
  tofu apply "${TOFU_VAR_ARGS[@]}" -target=aws_ecr_repository.ffmpeg_lambda -target=aws_ecr_lifecycle_policy.ffmpeg_lambda -auto-approve
  echo "  ✓ ECR repository created"
  if [ "$SKIP_DOCKER" = true ]; then
    # A brand-new repository has no image, and the FFmpeg Lambdas can't be
    # created without one, so the first deploy of an environment builds it.
    echo "  New ECR repository: building the FFmpeg image despite --skip-docker"
    SKIP_DOCKER=false
  fi
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
  
  ACCOUNT_ID=$(aws sts get-caller-identity --profile "$AWS_PROFILE" --query Account --output text)
  ECR_URL="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${PROJECT_NAME}-ffmpeg-lambda"
  
  # Login to ECR
  aws ecr get-login-password --profile "$AWS_PROFILE" --region "$AWS_REGION" | \
    docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com" 2>/dev/null

  echo "  Building Docker image..."
  docker build --platform linux/amd64 --provenance=false -f Dockerfile.ffmpeg -t "${PROJECT_NAME}-ffmpeg-lambda:latest" .
  docker tag "${PROJECT_NAME}-ffmpeg-lambda:latest" "${ECR_URL}:latest"
  docker push "${ECR_URL}:latest"
  echo "  ✓ Docker image pushed to ECR"

  FUNCTION_NAMES=("${PROJECT_NAME}-stitch-segments")
  if [ "$STITCH_ONLY" = false ]; then
    FUNCTION_NAMES+=("${PROJECT_NAME}-split-video")
  fi
  for FUNCTION_NAME in "${FUNCTION_NAMES[@]}"; do
    if ! aws lambda get-function --profile "$AWS_PROFILE" --region "$AWS_REGION" \
      --function-name "$FUNCTION_NAME" >/dev/null 2>&1; then
      # First deploy of an environment: tofu apply below creates the
      # function from the image that was just pushed.
      echo "  ${FUNCTION_NAME} does not exist yet; tofu apply will create it"
      continue
    fi
    echo "  Updating ${FUNCTION_NAME}..."
    aws lambda update-function-code \
      --profile "$AWS_PROFILE" \
      --region "$AWS_REGION" \
      --function-name "$FUNCTION_NAME" \
      --image-uri "${ECR_URL}:latest" \
      --publish >/dev/null
    aws lambda wait function-updated \
      --profile "$AWS_PROFILE" \
      --region "$AWS_REGION" \
      --function-name "$FUNCTION_NAME"
  done
  echo "  ✓ FFmpeg Lambda functions updated"
  cd ..
fi
echo ""

if [ "$STITCH_ONLY" = true ]; then
  echo "Cutting Lambda deployed; skipping unrelated Lambda packages and infrastructure"
  exit 0
fi

# Step 4: Apply all infrastructure
echo "[4/4] Applying infrastructure..."
if [ ! -f infrastructure/layers/ffmpeg-layer.zip ]; then
  echo "  FFmpeg layer zip missing; building layer..."
  bash ./build-ffmpeg-layer.sh
fi
cd infrastructure
tofu apply "${TOFU_VAR_ARGS[@]}" -auto-approve
cd ..
echo "✓ Infrastructure deployed"
echo ""

echo "========================================"
echo "  Deployment Complete: $DEPLOY_ENV"
echo "========================================"
echo ""
echo "API URL: $(tofu -chdir=infrastructure output -raw api_url 2>/dev/null || echo '(run: tofu -chdir=infrastructure output api_url)')"
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
