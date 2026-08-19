#!/bin/bash
# Publish the Remotion Lambda site that burns captions into exports.
# CaptionText lives here — Vercel does not update this bundle.
set -euo pipefail

cd "$(dirname "$0")"
AWS_REGION="${AWS_REGION:-us-west-2}"

npx remotion lambda sites create src/remotion/Root.tsx \
  --site-name=zeevee-renderer \
  --region="$AWS_REGION"
