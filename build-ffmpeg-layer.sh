#!/bin/bash
# Build FFmpeg Lambda Layer
# Downloads a static FFmpeg binary and packages it for Lambda Layer use.
# The binary will be available at /opt/bin/ffmpeg inside Lambda.

set -euo pipefail

LAYER_DIR="infrastructure/layers/ffmpeg"
OUTPUT_ZIP="infrastructure/layers/ffmpeg-layer.zip"

# Clean previous builds
rm -rf "$LAYER_DIR" "$OUTPUT_ZIP"
mkdir -p "$LAYER_DIR/bin"

echo "Downloading static FFmpeg build..."
curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o /tmp/ffmpeg-layer.tar.xz
tar -xf /tmp/ffmpeg-layer.tar.xz -C /tmp
cp /tmp/ffmpeg-*-amd64-static/ffmpeg "$LAYER_DIR/bin/ffmpeg"
cp /tmp/ffmpeg-*-amd64-static/ffprobe "$LAYER_DIR/bin/ffprobe"
chmod +x "$LAYER_DIR/bin/ffmpeg" "$LAYER_DIR/bin/ffprobe"
rm -rf /tmp/ffmpeg-layer.tar.xz /tmp/ffmpeg-*-amd64-static

echo "Creating layer zip..."
cd "$LAYER_DIR"
zip -r "../../layers/ffmpeg-layer.zip" bin/
cd -

rm -rf "$LAYER_DIR"

echo "Layer built: $OUTPUT_ZIP"
ls -lh "$OUTPUT_ZIP"
