#!/bin/bash
# Build FFmpeg Lambda Layer
# Downloads a static FFmpeg binary and packages it for Lambda Layer use.
# The binary will be available at /opt/bin/ffmpeg inside Lambda.

set -euo pipefail

LAYER_DIR="infrastructure/layers/ffmpeg"
OUTPUT_ZIP="infrastructure/layers/ffmpeg-layer.zip"
FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
ARCHIVE="/tmp/ffmpeg-layer.tar.xz"
# johnvansickle static builds are ~40MB compressed; reject HTML/error bodies early.
MIN_ARCHIVE_BYTES=$((20 * 1024 * 1024))

# Clean previous builds
rm -rf "$LAYER_DIR" "$OUTPUT_ZIP"
mkdir -p "$LAYER_DIR/bin"

is_xz_archive() {
  local file=$1
  local magic
  magic=$(dd if="$file" bs=6 count=1 status=none | od -An -tx1 | tr -d ' \n')
  [[ "$magic" == "fd377a585a00" ]]
}

download_ffmpeg_archive() {
  local attempt
  for attempt in 1 2 3; do
    echo "Downloading static FFmpeg build (attempt ${attempt}/3)..."
    rm -f "$ARCHIVE"
    if curl -fSL --retry 3 --retry-delay 2 --connect-timeout 30 --max-time 600 \
      "$FFMPEG_URL" -o "$ARCHIVE"; then
      :
    else
      echo "  curl failed on attempt ${attempt}"
      continue
    fi

    local size
    size=$(wc -c < "$ARCHIVE" | tr -d ' ')
    if [ "$size" -lt "$MIN_ARCHIVE_BYTES" ]; then
      echo "  archive too small (${size} bytes); expected at least ${MIN_ARCHIVE_BYTES}"
      continue
    fi
    if ! is_xz_archive "$ARCHIVE"; then
      echo "  download is not an xz archive (got ${size} bytes)"
      continue
    fi
    echo "  downloaded ${size} bytes"
    return 0
  done
  echo "Failed to download a valid FFmpeg archive from ${FFMPEG_URL}" >&2
  exit 1
}

download_ffmpeg_archive

echo "Extracting FFmpeg..."
rm -rf /tmp/ffmpeg-*-amd64-static
tar -xf "$ARCHIVE" -C /tmp
cp /tmp/ffmpeg-*-amd64-static/ffmpeg "$LAYER_DIR/bin/ffmpeg"
cp /tmp/ffmpeg-*-amd64-static/ffprobe "$LAYER_DIR/bin/ffprobe"
chmod +x "$LAYER_DIR/bin/ffmpeg" "$LAYER_DIR/bin/ffprobe"
if command -v strip >/dev/null 2>&1; then
  strip "$LAYER_DIR/bin/ffmpeg" "$LAYER_DIR/bin/ffprobe" 2>/dev/null || true
fi
rm -rf "$ARCHIVE" /tmp/ffmpeg-*-amd64-static

echo "Creating layer zip..."
cd "$LAYER_DIR"
zip -r "../../layers/ffmpeg-layer.zip" bin/
cd - >/dev/null

rm -rf "$LAYER_DIR"

echo "Layer built: $OUTPUT_ZIP"
ls -lh "$OUTPUT_ZIP"
