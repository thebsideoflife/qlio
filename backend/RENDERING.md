# Video Rendering Architecture

## Overview

The video rendering system uses **Remotion Lambda** for serverless video composition and rendering. The architecture is **asynchronous** - rendering happens in background Lambda workers while the API provides status updates via polling.

## Architecture Flow

```
┌─────────────┐     POST /render      ┌──────────────┐
│   Frontend  │ ───────────────────> │ renderVideo  │
│             │                       │   Lambda     │
└─────────────┘                       └──────────────┘
      │                                      │
      │                                      ├─> Fetch Project
      │                                      ├─> Fetch Asset
      │                                      ├─> Generate Presigned URL (12h)
      │                                      │
      │                                      v
      │                               ┌──────────────┐
      │                               │   DynamoDB   │
      │                               │  (Create job │
      │                               │ status=pending)│
      │                               └──────────────┘
      │                                      │
      │                                      v
      │                               ┌──────────────────┐
      │                               │ Remotion Lambda  │
      │  202 {jobId, renderId}        │renderMediaOnLambda│
      │ <──────────────────────────── │ (returns renderId)│
      │                               └──────────────────┘
      │                                      │
      │                                      │ (Async rendering
      │                                      │  happens here)
      │                                      │
      ├─── Poll GET /renders/{jobId} ───>   │
      │                                      │
      │                               ┌──────────────┐
      │                               │getRenderStatus│
      │                               │   Lambda     │
      │                               └──────────────┘
      │                                      │
      │                                      ├─> Read job from DynamoDB
      │                                      │
      │                                      v
      │                               ┌──────────────────┐
      │                               │ getRenderProgress│
      │  {status, progress: 45%}      │  (Remotion API)  │
      │ <──────────────────────────── │                  │
      │                               └──────────────────┘
      │                                      │
      │                                      ├─> Update DynamoDB progress
      │                                      │
      │ (Poll every 2-10s)                   │
      │                                      │
      ├─── Poll GET /renders/{jobId} ───>   │
      │                                      │
      │                               (Render completes)
      │                                      │
      │  {status: completed,                 ├─> Mark completed in DynamoDB
      │   downloadUrl: presignedS3Url}       │
      │ <──────────────────────────── └──────────────────┘
      │
      └─── Download from S3
```

## Status Lifecycle

### Status States

1. **pending** - Job created, waiting to start
2. **rendering** - Actively rendering in Remotion Lambda
3. **completed** - Render finished, video available
4. **failed** - Render failed or timed out

### State Transitions

```
pending ──> rendering ──> completed
                │
                └──> failed (timeout after 6 hours)
```

### Important Notes

- `renderMediaOnLambda()` **returns immediately** with a `renderId` - it does NOT wait for completion
- Progress is tracked by polling `getRenderProgress()` API in `getRenderStatus` Lambda
- Frontend should poll every 2-10 seconds with exponential backoff
- Renders timeout after 6 hours and are marked as failed

## Key Components

### 1. renderVideo Lambda

**File**: `backend/src/handlers/renderVideo.ts`

**Purpose**: Initiates the render job

**Flow**:
1. Authenticate user
2. Fetch project and asset from DynamoDB
3. Generate presigned S3 URL (12-hour expiration)
4. Create render job in DynamoDB (status: pending)
5. Call `renderMediaOnLambda()` - **returns immediately**
6. Update job to status: rendering with `renderId`
7. Return 202 response to frontend

**Environment Variables**:
- `RENDER_JOBS_TABLE` - DynamoDB table for job tracking
- `PROJECTS_TABLE` - Projects metadata
- `ASSETS_TABLE` - Asset/video metadata
- `REMOTION_SERVE_URL` - Remotion site bundle URL
- `REMOTION_FUNCTION_NAME` - Remotion Lambda function name
- `AWS_REGION_NAME` - AWS region

### 2. getRenderStatus Lambda

**File**: `backend/src/handlers/getRenderStatus.ts`

**Purpose**: Tracks render progress and provides download URLs

**Flow**:
1. Authenticate user
2. Fetch job from DynamoDB
3. **Check timeout** (> 6 hours = mark failed)
4. If status is "rendering":
   - Call `getRenderProgress()` with `renderId`
   - If `done: true`:
     - Update DynamoDB to status: completed
     - Store `outputFile` URL
   - Else:
     - Update progress percentage
5. If status is "completed":
   - Generate presigned download URL (1-hour expiration)
6. Return status and download URL

**Environment Variables**:
- `RENDER_JOBS_TABLE` - Job tracking table
- `REMOTION_FUNCTION_NAME` - For getRenderProgress API
- `AWS_REGION_NAME` - AWS region

### 3. CaptionedVideo Component

**File**: `zeevee/src/remotion/CaptionedVideo.tsx`

**Purpose**: Remotion composition that renders video with captions

**Input Props**:
- `videoUrl` - Presigned S3 URL to source video
- `segments[]` - Array of {startTime, endTime} for clips
- `captions[]` - Caption lines with word-level timing
- `captionSettings` - Styling (font, color, position, etc.)

**Validation**:
- Checks if `videoUrl` is empty/undefined
- Shows error screen if video URL missing
- Logs all props for debugging

## Presigned URL Management

### Source Video URL (Input)

- **Generated in**: `renderVideo.ts` via `presignS3Uri()`
- **Expiration**: 12 hours
- **Why**: Remotion Lambda needs to download video; long renders need long URLs
- **Risk**: Very long renders (>12 hours) will fail
- **Mitigation**: Monitor CloudWatch for 403 errors

### Rendered Video URL (Output)

- **Generated in**: `getRenderStatus.ts`
- **Expiration**: 1 hour
- **Format**: `renders/{renderId}/out.{mp4|webm}`
- **Extension**: Matches `outputFormat` from request
- **Security**: Presigned for secure access

## Common Issues & Troubleshooting

### Issue: "No src was passed to OffthreadVideo"

**Cause**: `videoUrl` is empty or undefined in Remotion props

**Check**:
1. CloudWatch logs for `renderVideo` Lambda - look for "Generated presigned video URL"
2. Verify asset has `s3VideoUrl` field in DynamoDB
3. Check if presignS3Uri returned null (permission issues)

**Fix**: Ensure asset upload completed and `s3VideoUrl` was saved

### Issue: Render stays "rendering" forever

**Causes**:
1. Remotion Lambda failed silently
2. Network issues between Lambdas
3. Invalid input props

**Check**:
1. CloudWatch logs for Remotion Lambda function
2. Check `folderInS3Console` link from initial response
3. Verify timeout detection (should fail after 6 hours)

**Fix**: 
- Check Remotion Lambda permissions
- Verify input props match composition schema
- Look for errors in CloudWatch

### Issue: Download URL returns 404

**Causes**:
1. File extension mismatch (mp4 vs webm)
2. Render hasn't actually completed yet
3. Wrong bucket/key construction

**Check**:
1. Verify `outputFormat` matches actual file extension
2. Check if file exists in S3 console at `renders/{renderId}/`
3. Compare `outputFile` from getRenderProgress with constructed URL

**Fix**:
- Ensure `outputFormat` stored in job matches reality
- Use `outputFile` from Remotion API directly

### Issue: Presigned URL expired

**For source video**:
- Default 12-hour expiration should handle most cases
- For very long videos, consider alternative architecture

**For download**:
- 1-hour expiration is intentional for security
- Frontend should request new URL if expired
- Users should download promptly

## Monitoring & Debugging

### CloudWatch Log Groups

1. `/aws/lambda/zeevee-render-video` - Render job creation
2. `/aws/lambda/zeevee-get-render-status` - Progress tracking
3. `/aws/lambda/remotion-render-*` - Actual rendering (Remotion-managed)

### Key Log Searches

**Find render start**:
```
"Starting Remotion Lambda render" jobId=<JOB_ID>
```

**Track progress**:
```
"Checking render progress" renderId=<RENDER_ID>
```

**Find completion**:
```
"Render * completed! Output:"
```

**Find failures**:
```
ERROR "Remotion render failed"
```

### DynamoDB Queries

**Get job status**:
```bash
aws dynamodb get-item \
  --table-name zeevee-render-jobs \
  --key '{"jobId": {"S": "YOUR_JOB_ID"}}'
```

**List recent jobs**:
```bash
aws dynamodb scan \
  --table-name zeevee-render-jobs \
  --filter-expression "createdAt > :timestamp" \
  --expression-attribute-values '{":timestamp": {"S": "2024-01-01T00:00:00Z"}}'
```

## Performance Tuning

### Remotion Lambda Configuration (Optimized for 10-min videos)

Deploy with these settings:
```bash
npx remotion lambda functions deploy \
  --memory=2048 \
  --disk=2048 \
  --timeout=240 \
  --architecture=arm64 \
  --region=us-west-2
```

| Setting | Value | Rationale |
|---------|-------|-----------|
| Memory | 2048 MB | Sweet spot - higher rarely speeds up, lower risks crashes |
| Disk | 2048 MB | Handles large source files without "No space left" errors |
| Timeout | 240 sec | 4 minutes per chunk prevents zombie processes |
| Architecture | arm64 | ~20% cheaper than x86, same performance |

### Code Configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| framesPerLambda | 150 | Creates ~120 workers for 10-min video (18,000 frames / 150) |
| concurrencyPerLambda | 1 | Avoids memory leaks and timeouts |

With framesPerLambda=150, you can render ~6-8 videos simultaneously without hitting the 1,000 Lambda concurrency limit.

### Cost Optimization

- Use "draft" quality for previews (faster, cheaper)
- "standard" for normal exports
- "high" only when needed (slower, more expensive)

**Note**: Quality parameter currently not implemented - all renders use default

### Region Co-location (Critical)

All resources MUST be in the same AWS region (us-west-2):
- S3 buckets (media, renders)
- Remotion Lambda function
- Other Lambda functions

Cross-region data transfer adds latency and costs.

### Polling Optimization

Frontend uses exponential backoff:
- Start: 2 seconds
- Max: 10 seconds
- Formula: `Math.min(2000 * Math.pow(1.5, pollCount), 10000)`

## Future Improvements

1. **Dynamic duration calculation** - Calculate from segments instead of hardcoded 60 minutes
2. **Quality parameter integration** - Pass quality settings to Remotion
3. **Composition validation** - Call `getCompositionsOnLambda()` before rendering
4. **Webhook notifications** - Push updates instead of polling
5. **Resume capability** - Handle Lambda timeouts gracefully
6. **Multi-region support** - Distribute rendering across regions

## API Reference

### POST /projects/{projectId}/render

Starts a new render job.

**Request**:
```json
{
  "segments": [{"id": "seg1", "startTime": 0, "endTime": 10, "title": "Intro"}],
  "captions": [{"id": "cap1", "startTime": 0, "endTime": 5, "text": "Hello", "words": [...]}],
  "captionSettings": {"enabled": true, "style": {...}},
  "outputFormat": "mp4",
  "quality": "standard"
}
```

**Response 202**:
```json
{
  "jobId": "uuid",
  "status": "rendering",
  "renderId": "remotion-render-id",
  "message": "Render started successfully"
}
```

### GET /renders/{jobId}

Gets current render status and progress.

**Response 200**:
```json
{
  "jobId": "uuid",
  "projectId": "proj-uuid",
  "status": "rendering",
  "progress": 45,
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:05:00Z",
  "downloadUrl": null
}
```

**Response 200 (completed)**:
```json
{
  "jobId": "uuid",
  "projectId": "proj-uuid",
  "status": "completed",
  "progress": 100,
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:10:00Z",
  "completedAt": "2024-01-01T00:10:00Z",
  "downloadUrl": "https://s3.amazonaws.com/...?presigned"
}
```

## Security Considerations

1. **Presigned URLs** - All S3 access uses temporary presigned URLs
2. **Authentication** - All endpoints require API password header
3. **CORS** - Configured for frontend access
4. **TTL** - Render jobs auto-expire after 7 days (DynamoDB TTL)
5. **Privacy** - Remotion renders set to "public" but S3 bucket should restrict access

## Testing Checklist

Before deploying changes:

- [ ] Short video (< 1 min) renders successfully
- [ ] Long video (> 5 min) doesn't timeout presigned URL
- [ ] WebM format generates correct file extension
- [ ] Progress updates correctly during render
- [ ] Download URL works after completion
- [ ] Timeout detection triggers after 6 hours
- [ ] Failed renders update status correctly
- [ ] CORS headers present on all responses
- [ ] CloudWatch logs contain expected messages
- [ ] Multiple concurrent renders don't interfere

