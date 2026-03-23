#!/bin/bash
# Generate an annotated version of a video with crop guide lines for AI framing analysis.
# The annotated video has colored vertical lines showing where each zoom level crops:
#   RED = TIGHT, YELLOW = MEDIUM, GREEN = WIDE
# Plus a subtle dark tint outside the TIGHT region.
#
# Usage: ./annotate-video.sh <asset-id>
# Example: ./annotate-video.sh 0f3e37a4-78ca-4d8a-a047-09d9b6d8f28e

set -euo pipefail

ASSET_ID="${1:?Usage: ./annotate-video.sh <asset-id>}"
BUCKET="zeevee-media-dev"
PROFILE="zeevee"
REGION="us-west-2"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${SCRIPT_DIR}/output"
mkdir -p "$OUTPUT_DIR"

SRC_KEY="raw/${ASSET_ID}.mp4"
DST_KEY="annotated/${ASSET_ID}.mp4"
TMP_SRC="/tmp/framing-src-${ASSET_ID}.mp4"
TMP_DST="${OUTPUT_DIR}/annotated-${ASSET_ID}.mp4"

if [ -f "$TMP_SRC" ]; then
  echo "Source already exists at $TMP_SRC, skipping download."
else
  echo "Downloading s3://${BUCKET}/${SRC_KEY}..."
  aws s3 cp "s3://${BUCKET}/${SRC_KEY}" "$TMP_SRC" --profile "$PROFILE" --region "$REGION"
fi

# Crop guide lines for 9:16 target.
# Uses iw/ih expressions so it works at any resolution.
# Left boundary at zoom z: z*(iw - ih*9/16)/2
FILTER=$(cat <<'FILTER_EOF'
scale=854:480,
drawbox=x=0:y=0:w='(iw-ih*9/16)/2':h=ih:color=black@0.25:t=fill,
drawbox=x='(iw+ih*9/16)/2':y=0:w='(iw-ih*9/16)/2':h=ih:color=black@0.25:t=fill,
drawbox=x='(iw-ih*9/16)/2':y=0:w=3:h=ih:color=red@0.9:t=fill,
drawbox=x='(iw+ih*9/16)/2':y=0:w=3:h=ih:color=red@0.9:t=fill,
drawbox=x='(iw-ih*9/16)/4':y=0:w=2:h=ih:color=yellow@0.8:t=fill,
drawbox=x='iw-(iw-ih*9/16)/4':y=0:w=2:h=ih:color=yellow@0.8:t=fill,
drawbox=x='(iw-ih*9/16)/8':y=0:w=2:h=ih:color=green@0.7:t=fill,
drawbox=x='iw-(iw-ih*9/16)/8':y=0:w=2:h=ih:color=green@0.7:t=fill
FILTER_EOF
)

# Remove newlines from filter
FILTER=$(echo "$FILTER" | tr -d '\n' | tr -s ' ')

echo "Re-encoding with crop guide lines (480p, ultrafast)..."
ffmpeg -i "$TMP_SRC" \
  -vf "$FILTER" \
  -c:v libx264 -preset fast -crf 26 \
  -an \
  -y "$TMP_DST"

echo ""
echo "Original: $(du -h "$TMP_SRC" | cut -f1)"
echo "Annotated: $(du -h "$TMP_DST" | cut -f1)"

echo ""
echo "Uploading to s3://${BUCKET}/${DST_KEY}..."
aws s3 cp "$TMP_DST" "s3://${BUCKET}/${DST_KEY}" --profile "$PROFILE" --region "$REGION"

rm -f "$TMP_SRC"

echo ""
echo "Done! The Lambda will automatically use the annotated version for framing analysis."
echo "Preview locally: open \"$TMP_DST\""
