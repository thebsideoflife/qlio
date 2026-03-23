#!/bin/bash
# fix-transcript-timing.sh
# Rebuilds transcript from scratch using raw 12Labs data with correct timing
# Usage: ./fix-transcript-timing.sh <asset-id>

set -e

export ASSET_ID=${1:-""}
export BUCKET="zeevee-media-dev"
export DYNAMO_TABLE="zeevee-assets"

if [ -z "$ASSET_ID" ]; then
  echo "Usage: $0 <asset-id>"
  echo "Example: $0 51a093c4-bf51-4c12-a8aa-769b062f3c70"
  exit 1
fi

# Get 12Labs API key from AWS Secrets Manager
echo "Fetching 12Labs API key..."
export TWELVE_LABS_API_KEY=$(aws secretsmanager get-secret-value \
  --secret-id zeevee/12labs-key \
  --query 'SecretString' \
  --output text)

if [ -z "$TWELVE_LABS_API_KEY" ]; then
  echo "Error: Could not fetch 12Labs API key"
  exit 1
fi

echo "=== Rebuilding transcript for asset: $ASSET_ID ==="

# Create temp directory
export TMPDIR=$(mktemp -d)
echo "Working directory: $TMPDIR"

# Cache directory for chunks
export CACHE_DIR="$HOME/.cache/zeevee-chunks"
mkdir -p "$CACHE_DIR"

# Step 1: Get asset metadata from DynamoDB
echo ""
echo "Step 1: Fetching asset metadata from DynamoDB..."
aws dynamodb get-item \
  --table-name "$DYNAMO_TABLE" \
  --key "{\"assetId\": {\"S\": \"$ASSET_ID\"}}" \
  --output json > "$TMPDIR/asset.json"

# Check if chunked
IS_CHUNKED=$(jq -r '.Item.isChunked.BOOL // false' "$TMPDIR/asset.json")
if [ "$IS_CHUNKED" != "true" ]; then
  echo "Error: Asset is not chunked. This script only fixes chunked video transcripts."
  rm -rf "$TMPDIR"
  exit 1
fi

# Extract 12Labs index ID from asset (fall back to known value)
export TWELVE_LABS_INDEX_ID=$(jq -r '.Item.twelveLabsIndexId.S // empty' "$TMPDIR/asset.json")
if [ -z "$TWELVE_LABS_INDEX_ID" ]; then
  export TWELVE_LABS_INDEX_ID="6934df867a1ec630b5fb65bd"
  echo "Using default 12Labs Index ID: $TWELVE_LABS_INDEX_ID"
else
  echo "12Labs Index ID from asset: $TWELVE_LABS_INDEX_ID"
fi

# Extract chunk info with videoIds
echo "Extracting chunk information..."
jq '[.Item.chunks.L[] | {
  chunkIndex: (.M.chunkIndex.N | tonumber),
  s3Key: .M.s3Key.S,
  startOffset: (.M.startOffset.N | tonumber),
  endOffset: (.M.endOffset.N | tonumber),
  duration: (.M.duration.N | tonumber),
  videoId: .M.videoId.S
}] | sort_by(.chunkIndex)' "$TMPDIR/asset.json" > "$TMPDIR/chunks.json"

echo "Chunks found:"
cat "$TMPDIR/chunks.json"

# Step 2-4: Probe durations, fetch transcripts from 12Labs, and rebuild
echo ""
echo "Step 2: Probing chunk durations and fetching transcripts from 12Labs..."

python3 << 'PYTHON_SCRIPT'
import json
import subprocess
import os
import urllib.request
import urllib.error

tmpdir = os.environ['TMPDIR']
bucket = os.environ['BUCKET']
cache_dir = os.environ['CACHE_DIR']
api_key = os.environ['TWELVE_LABS_API_KEY']
index_id = os.environ['TWELVE_LABS_INDEX_ID']

# Load chunks
with open(f'{tmpdir}/chunks.json', 'r') as f:
    chunks = json.load(f)

print(f"Processing {len(chunks)} chunks...")

all_segments = []

for chunk in chunks:
    chunk_index = chunk['chunkIndex']
    s3_key = chunk['s3Key']
    start_offset = chunk['startOffset']
    end_offset = chunk['endOffset']
    expected_duration = chunk['duration']
    video_id = chunk.get('videoId')
    
    print(f"\n{'='*60}")
    print(f"Chunk {chunk_index}:")
    print(f"  S3 key: {s3_key}")
    print(f"  Video ID: {video_id}")
    print(f"  Expected: start={start_offset}s, end={end_offset}s, duration={expected_duration}s")
    
    if not video_id:
        print(f"  WARNING: No videoId, skipping this chunk")
        continue
    
    # Probe actual duration from S3 chunk
    cache_filename = s3_key.replace('/', '_')
    cached_path = f"{cache_dir}/{cache_filename}"
    
    if os.path.exists(cached_path):
        print(f"  Using cached chunk")
    else:
        print(f"  Downloading chunk for probing...")
        subprocess.run([
            'aws', 's3', 'cp',
            f's3://{bucket}/{s3_key}',
            cached_path
        ], check=True, capture_output=True)
    
    result = subprocess.run([
        'ffprobe', '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        cached_path
    ], capture_output=True, text=True, check=True)
    
    actual_duration = float(result.stdout.strip())
    
    # Calculate actual start offset
    # Chunk 0 always starts at 0 (can't go before beginning of video)
    # Other chunks: actualStart = endOffset - actualDuration
    if chunk_index == 0:
        actual_start_offset = 0.0
        print(f"  Chunk 0: actual_start forced to 0")
    else:
        actual_start_offset = end_offset - actual_duration
        print(f"  Actual duration: {actual_duration:.3f}s")
        print(f"  Actual start offset: {actual_start_offset:.3f}s (vs intended {start_offset}s)")
        print(f"  Drift: {start_offset - actual_start_offset:.3f}s")
    
    # Fetch raw transcript from 12Labs (with transcription=true param)
    print(f"  Fetching transcript from 12Labs...")
    url = f"https://api.twelvelabs.io/v1.3/indexes/{index_id}/videos/{video_id}?transcription=true"
    
    req = urllib.request.Request(url, headers={'x-api-key': api_key})
    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  ERROR fetching video info: {e}")
        print(f"  URL was: {url}")
        # Try to read error body
        try:
            error_body = e.read().decode()
            print(f"  Error body: {error_body[:500]}")
        except:
            pass
        continue
    
    # Debug: show available keys
    print(f"  API response keys: {list(data.keys())}")
    
    transcription = data.get('transcription', [])
    if not transcription:
        print(f"  WARNING: No transcription in response for chunk {chunk_index}")
        print(f"  Full response: {json.dumps(data, indent=2)[:500]}...")
        continue
        
    print(f"  Got {len(transcription)} segments from 12Labs")
    
    # Apply actual offset to each segment
    for seg in transcription:
        raw_start = seg.get('start', 0)
        raw_end = seg.get('end', 0)
        
        adjusted_seg = {
            **seg,
            'start': raw_start + actual_start_offset,
            'end': raw_end + actual_start_offset,
            '_chunk': chunk_index,  # Track source for debugging
            '_raw_start': raw_start,
        }
        all_segments.append(adjusted_seg)
    
    print(f"  Applied offset {actual_start_offset:.3f}s to {len(transcription)} segments")

print(f"\n{'='*60}")
print(f"Total segments before dedup: {len(all_segments)}")

# Sort by start time
all_segments.sort(key=lambda x: x['start'])

# Deduplicate overlapping segments
# Chunks overlap by ~30s, so we need to remove duplicates
# Keep the segment that came from the earlier chunk (more reliable timing)
deduped = []
for seg in all_segments:
    if not deduped:
        deduped.append(seg)
        continue
    
    last = deduped[-1]
    # If this segment starts before the last one ends (with 1s tolerance), it's overlap
    if seg['start'] < last['end'] - 1.0:
        # Keep the one from the earlier chunk (lower chunk index)
        if seg.get('_chunk', 999) < last.get('_chunk', 999):
            deduped[-1] = seg  # Replace with earlier chunk's version
        # Otherwise keep existing (from earlier chunk)
        continue
    
    deduped.append(seg)

print(f"Total segments after dedup: {len(deduped)}")

# Remove debugging fields before saving
for seg in deduped:
    seg.pop('_chunk', None)
    seg.pop('_raw_start', None)

# Save rebuilt transcript
with open(f'{tmpdir}/transcript-rebuilt.json', 'w') as f:
    json.dump(deduped, f)

print(f"\nRebuilt transcript saved to {tmpdir}/transcript-rebuilt.json")

# Show sample of timing changes
print("\n=== Sample timing (first 5 segments) ===")
for seg in deduped[:5]:
    print(f"  {seg['start']:.2f}s - {seg['end']:.2f}s: {seg.get('value', seg.get('text', ''))[:50]}")

print("\n=== Sample timing (around chunk boundary ~3270s) ===")
boundary_segs = [s for s in deduped if 3260 <= s['start'] <= 3280]
for seg in boundary_segs[:5]:
    print(f"  {seg['start']:.2f}s - {seg['end']:.2f}s: {seg.get('value', seg.get('text', ''))[:50]}")
PYTHON_SCRIPT

# Step 3: Backup and upload (only if we have segments!)
echo ""
echo "Step 3: Checking rebuilt transcript..."

SEGMENT_COUNT=$(python3 -c "import json; print(len(json.load(open('$TMPDIR/transcript-rebuilt.json'))))")
echo "Rebuilt transcript has $SEGMENT_COUNT segments"

if [ "$SEGMENT_COUNT" -eq 0 ]; then
  echo ""
  echo "ERROR: No segments in rebuilt transcript! NOT uploading."
  echo "The 12Labs API calls failed. Check the errors above."
  echo ""
  echo "Temp files preserved at: $TMPDIR"
  exit 1
fi

echo "Backing up original and uploading rebuilt transcript..."

# Check if original exists
if aws s3 ls "s3://${BUCKET}/transcriptions/${ASSET_ID}.json" > /dev/null 2>&1; then
  aws s3 cp "s3://${BUCKET}/transcriptions/${ASSET_ID}.json" \
    "s3://${BUCKET}/transcriptions/${ASSET_ID}.backup-$(date +%Y%m%d-%H%M%S).json"
  echo "Backup saved"
fi

aws s3 cp "$TMPDIR/transcript-rebuilt.json" \
  "s3://${BUCKET}/transcriptions/${ASSET_ID}.json"
echo "Rebuilt transcript uploaded!"

# Step 4: Update DynamoDB with actual timing
echo ""
echo "Step 4: Updating DynamoDB with actual chunk timing..."

python3 << 'PYTHON_SCRIPT'
import json
import subprocess
import os
from datetime import datetime

tmpdir = os.environ['TMPDIR']
asset_id = os.environ['ASSET_ID']
table = os.environ['DYNAMO_TABLE']
bucket = os.environ['BUCKET']
cache_dir = os.environ['CACHE_DIR']

# Load chunks
with open(f'{tmpdir}/chunks.json', 'r') as f:
    chunks = json.load(f)

# Load original asset
with open(f'{tmpdir}/asset.json', 'r') as f:
    asset = json.load(f)

# Update chunks with actual timing
chunks_list = asset['Item']['chunks']['L']
for chunk_ddb in chunks_list:
    chunk_index = int(chunk_ddb['M']['chunkIndex']['N'])
    end_offset = float(chunk_ddb['M']['endOffset']['N'])
    
    # Get actual duration from cached file
    s3_key = chunk_ddb['M']['s3Key']['S']
    cache_filename = s3_key.replace('/', '_')
    cached_path = f"{cache_dir}/{cache_filename}"
    
    if os.path.exists(cached_path):
        result = subprocess.run([
            'ffprobe', '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            cached_path
        ], capture_output=True, text=True)
        
        if result.returncode == 0:
            actual_duration = float(result.stdout.strip())
            if chunk_index == 0:
                actual_start = 0.0
            else:
                actual_start = end_offset - actual_duration
            
            chunk_ddb['M']['actualDuration'] = {'N': str(actual_duration)}
            chunk_ddb['M']['actualStartOffset'] = {'N': str(actual_start)}

# Update DynamoDB
update_expr = "SET chunks = :chunks, updatedAt = :ua"
expr_values = json.dumps({
    ':chunks': {'L': chunks_list},
    ':ua': {'S': datetime.now().isoformat()}
})

subprocess.run([
    'aws', 'dynamodb', 'update-item',
    '--table-name', table,
    '--key', json.dumps({'assetId': {'S': asset_id}}),
    '--update-expression', update_expr,
    '--expression-attribute-values', expr_values
], check=True)

print("DynamoDB updated with actual chunk timing")
PYTHON_SCRIPT

# Cleanup temp files (keep cache)
rm -rf "$TMPDIR"

echo ""
echo "=== Done! ==="
echo "The transcript has been rebuilt from scratch with correct timing."
echo "Please refresh your browser to see the changes."
