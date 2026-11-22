#!/bin/bash
# Publish the Remotion Lambda site that burns captions into exports.
# CaptionText lives here — Vercel does not update this bundle.
#
# Usage: ./deploy-remotion-site.sh [prod|dev]   (default: prod)
# The site name must match remotion_site_name in infrastructure/envs/<env>.tfvars.
set -euo pipefail

cd "$(dirname "$0")"
AWS_REGION="${AWS_REGION:-us-west-2}"
DEPLOY_ENV="${1:-${DEPLOY_ENV:-prod}}"

case "$DEPLOY_ENV" in
  prod) SITE_NAME="zeevee-renderer" ;;
  dev) SITE_NAME="qlio-dev-renderer" ;;
  *)
    echo "Unknown environment: '$DEPLOY_ENV' (use prod or dev)" >&2
    exit 1
    ;;
esac

echo "Publishing Remotion site '$SITE_NAME' ($DEPLOY_ENV)"
npx remotion lambda sites create src/remotion/Root.tsx \
  --site-name="$SITE_NAME" \
  --region="$AWS_REGION"
