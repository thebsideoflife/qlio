# SPEC — IQ Agent: a conversational cutting agent to replace the Jockey "Enhanced Cut" flow

Status: **Draft for approval**
Supersedes: `SPEC-jockey-v2-loop.md`, `SPEC-jockey-v3-self-directed-cuts.md`, `SPEC-jockey-compact-recap.md`
Owner: TBD · Target: replace `jockeyEnabled` path end-to-end

---

## 1. What this is

Today "Enhanced Cut" is a one-shot black box. The user fills in the IQ panel, hits Generate, stares at a spinner for 3–10 minutes with a 30-second blind delay at the front, and gets a segment list they can only fix by hand. The model doing the cutting is TwelveLabs `jockey1.0` behind a JSON-schema request — we cannot see its reasoning, cannot steer it, and cannot ask it to revise.

This spec replaces that with **our own agent**: Claude Sonnet (originally 4.5; Sonnet 5.5 via SporeLabs since 2026-10) as the reasoning core, TwelveLabs Marengo + Pegasus 1.5 + the transcript + extracted frames as its senses, and a small set of well-designed tools for editing the cut. The interaction becomes a conversation in the IQ panel — live prose, visible tool calls, a running statistics box, and genuine back-and-forth. The user can say "the third segment drags, tighten it" and the agent will go look and fix it.

Three things drive every decision below:

1. **The duration math must be impossible to ignore.** This is the client's #1 complaint. The fix is not a better prompt — it is making the arithmetic a *tool result* the model receives after every single edit, and rendering the same numbers to the user.
2. **Pegasus must never watch the whole video.** Pegasus 1.5 bills by video-seconds processed and video content consumes the context window. Every clip-watching call is time-ranged, capped, cached, and metered.
3. **The run is durable; the client is only a reader of it.** Spam, refresh, dropped Wi-Fi, and closed laptops must not corrupt or lose work.

---

## 2. Research findings

### 2.1 What exists today

**Generation flow.** `POST /projects/{id}/generate` (`backend/src/handlers/generateSegments.ts`) writes `generationJob = {status:"pending"}` onto the project item and self-invokes with `InvocationType: "Event"`. The worker half runs StoryIQ, writes `segments` wholesale to DynamoDB, kicks off framing, and marks `completed`. The frontend calls `pollGenerationStatus` which waits **30 seconds blind**, then polls `GET /projects/{id}/job` every 10s for up to 15 minutes.

**The pipeline underneath.** `generateWithStoryIQ` routes to one of three paths. With `jockeyEnabled` and `JOCKEY_V3_SELF_DIRECTED_ENABLED`, it uses `generateSegmentsWithJockeyV3` — the TwelveLabs Agents API (`jockey1.0`) with a `json_schema` response format, up to 3 passes, where failed validation is fed back as typed issues (`duration_band`, `quartile_coverage`, `seam_cut`, …). Otherwise it falls through to Pegasus async segmentation.

**Only one status value is ever emitted.** `GenerationStatusCallback` is typed `(status: "generating") => Promise<void>`. That is the entire reason the progress UI is a single spinner string — the pipeline has nothing else to report.

### 2.2 Capabilities we have but do not use

| Capability | Status | Why it matters here |
|---|---|---|
| **Marengo semantic search** | **Completely unused.** No `client.search.create` call anywhere in the repo. | This is the cheapest, fastest way to get *grounded timestamps*. It is the single biggest missing primitive. |
| **Pegasus 1.5 time-ranged analysis** | Used in only 2 of 3 call sites | `TwelveLabsWrapper.analyze()` — the general-purpose method — **never passes a time range** and always sends the whole video. |
| **Pegasus 1.5 reference images** | Unused | `prompt_v2.media_sources` accepts up to 4 images. |
| **Claude vision** | **Never used.** No image content block is constructed anywhere in `backend/src`. | Claude can look at extracted frames directly. |
| **Word-level transcript** | Used as flat text | `transcriptions/{assetId}.json` is **word-level** with per-word `start`/`end`. Free, instant, and precise enough for the agent to inspect a candidate cut edge on demand. |
| **`extractFrameToS3`** | Used only for UI thumbnails | Streams from a presigned URL, single ffmpeg frame grab. Cheap and fast. Reusable as the agent's eyes. |
| **Scene cache** | Orphaned | `backend/src/handlers/detectScenes.ts` was deleted in `fcdac31`; `infrastructure/compute.tf:473` still deploys a stale May-dated `dist/detectScenes.js`. Nothing reads or writes the cache in current source. |

### 2.3 Verified API facts (from the vendored SDK and docs)

`twelvelabs-js@1.2.4` is already a dependency. Confirmed against `backend/node_modules/twelvelabs-js`:

```ts
// api/client/requests/AnalyzeRequest.d.ts — time range IS supported
interface Raw {
  model_name?: "pegasus1.2" | "pegasus1.5";
  video_id?: string | null;
  video?: VideoContext.Raw | null;      // url | asset_id | base64_string
  prompt?: string | null;
  prompt_v2?: AnalyzePromptV2.Raw | null;  // up to 4 reference images
  temperature?: number | null;             // default 0.2
  response_format?: SyncResponseFormat.Raw | null;  // json_schema
  max_tokens?: number | null;              // max 4096 on this field
  start_time?: number | null;              // ← REQUIRES pegasus1.5
  end_time?: number | null;
}
```

- `start_time`/`end_time` **require `model_name: "pegasus1.5"`**. The clip must be **at least 4 seconds**. Values are absolute timestamps against the video's internal metadata.
- Sync `analyze` supports videos **up to 1 hour**; Pegasus 1.5 handles up to 2 hours via the async task endpoint.
- Pegasus 1.5 has a **shared 261,120-token context window** covering video content, audio transcription, prompt text, reference images, and the response. TwelveLabs' own guidance for reducing input cost is, verbatim: *"Use `start_time` and `end_time` to analyze a portion of the video."*
- Billing is by video duration processed. **Time-ranging is both a cost control and a context control.**
- Marengo: `client.search.create({ indexId, queryText, searchOptions: ["visual"|"audio"|"transcription"], operator, pageLimit ≤ 50, filter, groupBy })` returns `SearchItem[]` with `start`, `end`, `videoId`, `rank` (1 = most relevant), `thumbnailUrl`, `transcription`. The `filter` field accepts a stringified JSON object and supports `{"id": ["videoId1", "videoId2"]}` — which is how we scope search to one asset and its chunks.

### 2.4 Infrastructure constraints

- API Gateway is **HTTP API v2**, every integration `AWS_PROXY` with **no `timeout_milliseconds` set → the 30s default, which is also the hard ceiling.** Every request must finish inside 30s, which rules out both SSE and long-polling on this API.
- **No `aws_lambda_function_url` exists anywhere**, and none is added by this spec. Response streaming would have required one.
- **`bedrock:InvokeModel` is granted on `"*"`.** `bedrock:InvokeModelWithResponseStream` is a distinct action and is not granted — one of several reasons the design uses non-streaming `InvokeModel`, which needs no IAM change.
- No SQS, EventBridge, Step Functions, WebSocket API, or DynamoDB Streams anywhere. Async orchestration is S3 notifications plus direct `lambda:InvokeFunction`.
- `lambda:InvokeFunction` is scoped to `zeevee-*` — new functions must keep the prefix.
- DynamoDB actions are enumerated **per table ARN**; new tables must be added to the policy. `BatchWriteItem` and `TransactWriteItems` are absent entirely.
- Two tables already use TTL with an attribute literally named `expiresAt`. Follow that convention.
- Auth is a shared-password map: `x-api-password` header → `{password: userId}` JSON in Secrets Manager. **`checkAuth` returns `null` immediately when `event.headers` is undefined**, which is what lets async self-invokes run unauthenticated.

### 2.5 Bugs to fix rather than port

1. **Stale generation jobs are never reaped.** `getProjectJobStatus.ts:130` checks for statuses `["pending","analyzing"]`, but a generation job in flight is `"generating"`. A crashed job stays `"generating"` forever and every future page load re-enters the resume path.
2. **`POST /generate` has no in-flight check.** It unconditionally overwrites `generationJob` and fires another Lambda. Two tabs silently clobber each other. (Framing does this correctly with a 409.)
3. **Autosave races generation.** `syncMiddleware` PATCHes `segments` from Redux every 10s. If the user nudges a segment during a run, the next tick overwrites whatever the server just wrote.
4. **No cancel exists** for generation or framing.
5. **`zeevee-generate-segments` runs at the default 128 MB** with a 900s timeout, which is the likely cause of the OOM failures the 15-minute stale check was written to paper over.

---

## 3. Design principles

Following `.cursor/rules/12-factor-agents.md`:

| Factor | How it lands here |
|---|---|
| 2 — Own your prompts | All prompts in `backend/src/services/iq-agent/prompts.ts`, versioned with a `PROMPT_VERSION` constant stamped onto every run. |
| 3 — Tools are JSON and code | `tools.ts` holds the JSON schemas; `executor.ts` is a plain `switch`. No framework. |
| 4 — Manage context explicitly | Context is *assembled* per call from curated parts, never appended blindly. Live state is re-rendered fresh each turn so history can be compacted aggressively. |
| 5 — Own your control flow | Explicit `prompt → parse → switch → execute → loop` in `loop.ts`. No agent framework, no `while(true)` inside a vendor SDK. |
| 6 — Stateless agents | The worker holds nothing across invocations. Every turn rehydrates from DynamoDB, so a run can be paused, resumed, or continued in a fresh Lambda. |
| 7 — Separate business from execution state | `segments` + budget (business) live on the project; run status, cursor, retry counts (execution) live on the run item. |
| 8 — Contact humans as first-class | `ask_user` is a real tool that suspends the run, not an error path. |
| 11 — Explicit error handling | Tool failures return structured `{ok:false, code, message, hint}` to the model rather than throwing. |
| 12 — Find the bleeding edge | Duration adherence is exactly the 70–80%-reliable behavior. We fix it with a deterministic ledger fed back on every mutation and a guarded finish — not with prompt pleading. |

**The one non-negotiable:** the user's IQ panel selections are a **brief**, not a workflow. They are injected as context labelled as defaults. A conversational instruction always overrides them.

---

## 4. Architecture

```
┌──────────────── Browser ────────────────┐
│  IQ Agent panel (chat + budget bar)     │
│  adaptive poll loop, seq cursor         │
└───┬─────────────────────────┬───────────┘
    │ POST message            │ GET events?afterSeq=N
    │                         │ (adaptive 1s → 5s)
    ▼                         ▼
┌──────────────────────────────────────────┐
│ zeevee-iq-agent-api   (30s, 512MB)       │
│  enqueue + lock + 202 · read events      │
│  cancel · reap dead runs                 │
└──────┬────────────────────────▲──────────┘
       │ Invoke "Event"         │ Query(runId, seq > N)
       ▼                        │
┌──────────────────────────────────────────┐
│ zeevee-iq-agent-worker (900s, 2048MB)    │
│  loop: assemble ctx → Claude             │
│        → parse → switch → execute tool   │
│        → append events → repeat          │
│  self-continues if < 120s remaining      │
└───┬─────────┬──────────┬─────────┬───────┘
    │         │          │         │
 Marengo   Pegasus1.5  S3/ffmpeg  DynamoDB
 (search)  (ranged)    frames+    (events,
                       transcript  segments)
```

**Two processes, one contract.** The worker never observes the client; it appends to a seq-ordered event log and runs to completion regardless of who is watching. The client polls that log from a cursor. Everything the UI renders is derived from it.

This decoupling is what makes the durability requirements fall out for free rather than needing their own machinery. Page refresh, dropped Wi-Fi, a second tab, and closing the laptop are all the same situation from the server's point of view: nobody is reading right now, and when someone does, they will ask for everything after seq N.

### 4.1 New Lambda functions

| Function | Package | Timeout | Memory | Purpose |
|---|---|---|---|---|
| `zeevee-iq-agent-api` | zip | 30s | 512 | Enqueue messages, acquire run lock, read events, cancel, reap |
| `zeevee-iq-agent-worker` | zip | 900s | 2048 | The agent loop |

Both keep the `zeevee-` prefix so the existing `lambda:InvokeFunction` policy covers them. Both sit on the existing HTTP API v2 — **no Lambda Function URL, no new public surface, no new auth path.**

### 4.2 Why polling, not streaming

An earlier draft specced SSE over a Lambda Function URL with `RESPONSE_STREAM`. We rejected it. It would have required a new public endpoint with its own CORS and its own auth workaround (`EventSource` cannot set headers, so the password would ride in a query string), a third Lambda, client reconnect-and-replay logic, heartbeat handling to detect dead connections, and a polling fallback anyway for when SSE fails. That is a lot of new failure surface for one benefit: prose appearing token-by-token instead of paragraph-by-paragraph.

That benefit is smaller here than it looks. In a typical run the agent alternates short prose blocks (2–5 sentences, ~3s to generate) with tool calls that take 2–60s. **Tool time dominates wall-clock, and tool events are what the user actually wants to watch.** Adaptive polling delivers those within a second or two of them happening, which is the entire perceived difference.

So: the worker calls Bedrock with plain `InvokeModel`, writes one `message.assistant` event per prose block, and the client polls. If we later want progressive prose, we can switch the worker to `InvokeModelWithResponseStream` and emit partial `message.assistant` updates into the same event log — **no client, transport, or infrastructure change required.** The event log design keeps that door open.

---

## 5. Data model

### 5.1 `zeevee-agent-threads` (new)

One thread per project — the conversation survives across runs.

- Hash key: `projectId` (S). No range key. `PAY_PER_REQUEST`. TTL on `expiresAt`.

| Attribute | Type | Notes |
|---|---|---|
| `projectId` | S | |
| `assetId` | S | denormalized |
| `activeRunId` | S? | **the lock.** Absent = idle |
| `runSeq` | N | monotonic run counter |
| `brief` | M | last IQ panel selections |
| `messages` | L | curated turn window (see §7.2) |
| `summary` | S | rolling summary of compacted turns |
| `toolLedger` | L | compact digests of older tool calls |
| `workingSet` | M | `{segments: [...], version: N}` — the agent's authoritative cut |
| `ledger` | M | last computed budget snapshot |
| `costMeter` | M | `{pegasusSeconds, searches, frames, tokensIn, tokensOut, usd}` |
| `pendingMessages` | L | queued user messages awaiting a turn boundary |
| `promptVersion` | S | |
| `expiresAt` | N | epoch seconds, 90 days |

**400 KB item limit.** Compaction (§7.2) keeps this bounded. If `messages` + `workingSet` exceed 300 KB, the oldest turns spill to `s3://{media}/agent/{projectId}/history/{runId}.json` and are replaced by a summary line. Full fidelity always remains in the events table.

### 5.2 `zeevee-agent-events` (new)

Append-only. The single source of truth for the UI.

- Hash key: `runId` (S), Range key: `seq` (N). `PAY_PER_REQUEST`. TTL on `expiresAt` (30 days).
- GSI `ProjectIdIndex`: hash `projectId`, range `createdAt` — for "what was the last run on this project."

Reads are always `Query(runId, seq > afterSeq)`, which makes resume trivial and cheap.

### 5.3 Event types

```ts
type AgentEvent =
  | { type: "run.started";      runId: string; trigger: "initial" | "followup" }
  | { type: "message.user";     text: string; brief?: Brief }
  | { type: "message.assistant"; text: string }          // one per prose block
  | { type: "tool.started";     callId: string; name: ToolName; input: unknown; label: string }
  | { type: "tool.progress";    callId: string; note: string }
  | { type: "tool.finished";    callId: string; ok: boolean; summary: string; digest: unknown; ms: number }
  | { type: "state.updated";    segments: Segment[]; ledger: Ledger; cost: CostMeter }
  | { type: "question.asked";   questionId: string; text: string; suggestions?: string[] }
  | { type: "run.awaiting_input" }
  | { type: "framing.started" | "framing.progress" | "framing.completed"; completed?: number; total?: number }
  | { type: "run.completed";    summary: string }
  | { type: "run.failed";       code: string; message: string; retryable: boolean }
  | { type: "run.cancelled" };
```

Every event carries `seq`, `runId`, `ts`. Events are written one at a time as they occur — no batching or coalescing is needed, because the worker emits on the order of tens of events per run rather than hundreds of token deltas.

`tool.started` is written **before** the tool executes, not after. That is what lets the UI show *Watching 6:52–8:58…* with a spinner during a 40-second Pegasus call instead of going silent. Long-running tools may emit `tool.progress` (for example, per-chunk on a split `watch_clip`).

### 5.4 What does *not* change

`project.segments` remains the canonical thing the editor renders and the renderer consumes. The agent's `workingSet` is committed to `project.segments` at each `state.updated`. No new segment schema.

---

## 6. The toolset

Eight tools. Deliberately small. Grouped into *perceive* and *act*, with cost tiers stated to the model.

### 6.1 Perception

#### `search_video` — Marengo. Tier: cheap. Use first, use often.

```json
{
  "name": "search_video",
  "description": "Semantic search over the video for moments matching a natural-language query. Returns ranked clips with real timestamps. This is your cheapest and fastest way to find candidate moments — prefer it over watch_clip for discovery. Run several queries with different phrasings to map the video before you start cutting.",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Natural language, e.g. 'two characters arguing in a car'. Max 500 tokens." },
      "modalities": {
        "type": "array",
        "items": { "enum": ["visual", "audio", "transcription"] },
        "description": "Default ['visual','transcription']."
      },
      "operator": { "enum": ["or", "and"], "description": "Default 'or'." },
      "limit": { "type": "integer", "maximum": 50, "description": "Default 10." },
      "timeRange": {
        "type": "object",
        "properties": { "start": {"type":"number"}, "end": {"type":"number"} },
        "description": "Optional. Restrict results to this window of the source timeline."
      }
    },
    "required": ["query"]
  }
}
```

Implementation: `client.search.create({ indexId, queryText, searchOptions, operator, pageLimit, filter: JSON.stringify({id: videoIds}) })`. For chunked assets, `videoIds` is every chunk's `videoId`, and each result's `start`/`end` is mapped back to the source timeline via `chunk.actualStartOffset ?? chunk.startOffset`. `timeRange` is applied as a post-filter. Results are truncated to `limit` and returned as a compact table (rank, start, end, duration, transcription snippet ≤140 chars).

#### `read_transcript` — Tier: free. S3 only.

```json
{
  "name": "read_transcript",
  "description": "Read the spoken dialogue for a time range. Free and instant — use it liberally to understand what is said, verify a cut lands between sentences, and check that a segment opens and closes cleanly.",
  "input_schema": {
    "type": "object",
    "properties": {
      "start": { "type": "number" },
      "end": { "type": "number" },
      "granularity": { "enum": ["sentences", "words"], "description": "Default 'sentences'. Use 'words' only when checking a precise cut edge." }
    },
    "required": ["start", "end"]
  }
}
```

Reads `transcriptions/{assetId}.json`. The stored file is word-level; `sentences` groups words using the existing `groupWordsIntoCaptions` break rules (gap > 0.3s, ≥ 8 words, or > 3s). Range is capped at 900s per call; longer requests are truncated with an explicit note. Returns `[m:ss] text` lines plus, at the boundaries, the nearest speech gaps — so the model can see where a clean edge would be.

#### `watch_clip` — Pegasus 1.5. **Tier: EXPENSIVE. Always time-ranged.**

```json
{
  "name": "watch_clip",
  "description": "Watch a specific window of the video and answer a question about it. This is your only way to see motion, performance, and visual detail — but it is by far the most expensive tool, billed by the number of video-seconds you watch. Always watch the narrowest window that answers your question. Never try to watch the whole video: use search_video to find candidates first, then watch only the windows that matter.",
  "input_schema": {
    "type": "object",
    "properties": {
      "start": { "type": "number" },
      "end": { "type": "number", "description": "Window must be >= 4s and <= 600s." },
      "question": { "type": "string", "description": "What you want to know about this window." }
    },
    "required": ["start", "end", "question"]
  }
}
```

Implementation calls `client.analyze({ modelName: "pegasus1.5", videoId, prompt, startTime, endTime, maxTokens: 1024, temperature: 0.2 })`.

**There is no per-run spend cap.** A hard cap risks cutting off a legitimately thorough run mid-thought. Instead we prevent waste structurally — the failure mode we are defending against is *redundant and pathological* calls, not *many* calls. Rules enforced **in code, never by prompt**:

- `start`/`end` are **required**. There is no code path that calls Pegasus without a range. This is the single most important cost control and it is a type-level guarantee, not a convention.
- Window `< 4s` → rejected with a structured error (TwelveLabs minimum).
- Window `> MAX_CLIP_WINDOW_SEC` (default 900) → rejected with a hint to split the request. This is a footgun rail against "watch the whole video," not a budget — it is generous enough that no reasonable single question hits it.
- **Result cache.** Key `sha256(assetId|start|end|normalizedQuestion)` at `s3://{media}/agent/clip-cache/{assetId}/{hash}.json`, scoped to the asset and shared across runs and threads. A hit is free and instant. Follow-up turns re-examine the same segments constantly, so this is the highest-leverage cost control after time-ranging.
- **Overlap-aware repeat detection.** Before calling, we check the run's call history for a prior `watch_clip` whose window covers ≥ 90% of the requested one. On a match the tool returns the earlier answer annotated `"You already watched this window — here is what you found. Ask a different question or widen the window if you need more."` This catches the specific failure the cache misses: the agent re-watching the same moment with a slightly reworded question.
- **Per-call timeout** of 180s (Pegasus sync analyze on a windowed clip is normally well under this). On timeout the tool returns `{ok:false, code:"timeout", hint:"Try a narrower window."}` — a structured result the model can act on, never a thrown exception that kills the turn.
- **Rate-limit handling.** 429 → bounded backoff (3 attempts, honoring `retry-after`), then a structured error suggesting cheaper tools. Never an unbounded retry loop.
- **Chunked assets.** An absolute range is mapped to the chunk containing it and converted to chunk-local offsets, clamped by `pegasusIndexedVideoDurationSec(chunk)`. A range spanning two chunks is split into two calls and the answers concatenated with their absolute ranges labelled.

Every result carries `videoSecondsWatched` for this call plus the run's running total. The meter is **advisory** — it informs the model and the user, and it never blocks a call. Making spend visible is what keeps it sane; the cap was solving a problem the cache and repeat-detection solve better.

#### `view_frames` — Claude's own eyes. Tier: cheap.

```json
{
  "name": "view_frames",
  "description": "Extract still frames from the video and look at them yourself. Use this to check framing, confirm a hard cut at a boundary, identify who is on screen, or judge visual quality. Much cheaper than watch_clip, but static — it shows you composition, not motion.",
  "input_schema": {
    "type": "object",
    "properties": {
      "timestamps": {
        "type": "array",
        "items": { "type": "number" },
        "description": "Explicit timestamps in seconds. Max 6 per call."
      },
      "purpose": { "type": "string", "description": "What you are checking for." }
    },
    "required": ["timestamps", "purpose"]
  }
}
```

Implementation reuses `extractFrameToS3` (presigned-URL streaming, `-vframes 1 -q:v 2`), writes to `s3://{media}/agent/frames/{assetId}/{ts}.jpg`, downscales to ≤ 768px on the long edge, and returns the frames **as Anthropic image content blocks** in the tool result:

```ts
{ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }
```

This is new for this codebase — nothing currently sends images to Claude. Cap 6 frames/call and 40 frames/run. Frames are cached by `(assetId, roundedTs)`.

> **Note on the FFmpeg layer:** `view_frames` needs `/opt/bin/ffmpeg`, so `zeevee-iq-agent-worker` must attach `aws_lambda_layer_version.ffmpeg` (the same layer `analyze-framing` uses).

### 6.2 Action

#### `edit_segments` — the only mutation tool. **Returns the ledger.**

This is the most important tool in the spec. It is a *batch* operation so the model can express a coherent revision in one step, and it *always* returns the recomputed budget.

```json
{
  "name": "edit_segments",
  "description": "Add, remove, or adjust segments in the cut. Every call returns the full recomputed budget — segment count, total duration, distance from target, and any violations. Read that budget carefully: it is the ground truth on whether your cut meets the requirements. Batch related changes into a single call.",
  "input_schema": {
    "type": "object",
    "properties": {
      "ops": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "op": { "enum": ["add", "remove", "update"] },
            "segmentId": { "type": "string", "description": "Required for remove/update." },
            "start": { "type": "number" },
            "end": { "type": "number" },
            "title": { "type": "string", "description": "<=10 words, WHO does WHAT. No 'Part N'." },
            "description": { "type": "string", "description": "One sentence on why this moment earns its place." }
          },
          "required": ["op"]
        }
      },
      "rationale": { "type": "string", "description": "One line on what this batch accomplishes." }
    },
    "required": ["ops"]
  }
}
```

**Guardrails applied server-side before the ledger is computed.** These enforce *structural integrity only* — they never second-guess an editorial choice:

1. **Clamping** to `[0, videoDuration]`.
2. **Overlap rejection.** An op that would overlap an existing segment is rejected with the conflicting id, not silently merged.
3. **Ordering.** Result is always sorted chronologically.
4. **Partial application.** Valid ops apply; invalid ops come back in `rejected[]` with reasons. The turn is never wasted.

**Boundary timing is the agent's job, not the code's.** Pegasus produces timestamps for exactly this purpose and we trust them. There is no automatic snapping to word ends, scene changes, or anything else — that would be complexity we do not have today and it would fight the model. Note that a scene frequently does not end on the last word (a held reaction shot, a musical sting), so mechanical word-snapping would actively make some cuts worse.

If the agent wants to refine an edge, it has everything it needs to do so deliberately: `read_transcript` with `granularity: "words"` shows exactly where speech starts and stops, and `view_frames` shows what is on screen at a candidate boundary. The system prompt mentions this as an available technique, not a required step. We can revisit automatic snapping later once we see where real cuts actually land.

Result shape — note that the budget is unavoidable:

```json
{
  "ok": true,
  "applied": [{"op":"add","segmentId":"seg_7","start":412.0,"end":538.5}],
  "rejected": [{"op":"add","reason":"overlap","conflictsWith":"seg_3"}],
  "ledger": { /* see §7 */ }
}
```

#### `check_budget` — read-only. Tier: free.

Returns the current segment table and the same ledger without mutating. Lets the agent orient at the start of a follow-up turn, or sanity-check before finishing.

#### `ask_user` — 12-factor #8.

```json
{
  "name": "ask_user",
  "description": "Ask the producer a clarifying question when a genuine editorial decision is theirs to make — competing interpretations of the brief, a tradeoff you cannot resolve, or missing context about the title. Do NOT use this for things you can determine yourself by looking at the video. Asking suspends your run until they reply.",
  "input_schema": {
    "type": "object",
    "properties": {
      "question": { "type": "string" },
      "suggestions": {
        "type": "array", "items": { "type": "string" },
        "description": "2-4 short suggested answers rendered as one-click chips. Optional."
      }
    },
    "required": ["question"]
  }
}
```

Emits `question.asked` + `run.awaiting_input`, releases the lock, persists state, and returns. The user's reply starts a new run on the same thread. Rate-limited to 2 per run so the agent cannot stall on interrogation.

#### `finish_turn`

```json
{
  "name": "finish_turn",
  "description": "End your turn. Call this when the cut satisfies the brief and the budget, or when you have answered the producer's question. Summarize what you did and flag anything you were unsure about.",
  "input_schema": {
    "type": "object",
    "properties": {
      "summary": { "type": "string", "description": "2-3 sentences for the producer." },
      "concerns": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["summary"]
  }
}
```

**Guarded finish.** If `finish_turn` is called while the ledger has blocking violations (out of duration band, per-segment bound breaches, overlaps), the tool returns `{ok:false, code:"unresolved_violations", ledger}` and the loop continues — **once**. On the second attempt the finish is allowed but the concerns are recorded and surfaced to the user. This directly targets "models ignore the duration instructions" without risking an infinite loop.

---

## 7. The Budget Ledger — the answer to the duration problem

### 7.1 Shape

Recomputed deterministically after every mutation and attached to `edit_segments`, `check_budget`, and every `state.updated` event.

```ts
interface Ledger {
  videoDuration: number;
  segmentCount: number;
  totalDuration: number;

  target: {
    seconds: number | null;        // from targetPercent, or format default
    band: [number, number];        // ±5% for compact, format-specific otherwise
    status: "under" | "within" | "over" | "no_target";
    delta: number;                 // signed seconds from target
    deltaPercent: number;
  };

  perSegment: {
    min: number; max: number;      // the user's bounds
    violations: Array<{ segmentId: string; title: string; duration: number;
                        bound: "min" | "max"; limit: number; delta: number }>;
  };

  overlaps: Array<{ a: string; b: string; seconds: number }>;

  coverage: {
    quartiles: [number, number, number, number];  // segments per quarter of source
    largestGap: { start: number; end: number; seconds: number } | null;
    spreadWarning: string | null;  // e.g. "no segments in the final quarter"
  };

  blocking: string[];              // human-readable, empty == clean
}
```

### 7.2 Why this works when prompts do not

The failure mode today is that the model proposes a cut list and *never learns* what the arithmetic came out to — nothing recomputes and tells it. Three changes fix that:

1. **The feedback is unavoidable.** The ledger is the return value of the only mutation tool. There is no way to edit without seeing the consequence, in the same turn, in structured form.
2. **The finish is guarded.** `finish_turn` refuses once while violations are blocking, with the specific numbers attached.
3. **The user sees the identical numbers.** The budget bar in the UI renders the same `Ledger` object. Agent and producer are looking at one dashboard, so disagreements become visible instantly rather than at export time.

Additionally the system prompt states the arithmetic explicitly and instructs the agent to call `check_budget` before proposing a plan and after every batch of edits.

Note what this section deliberately does *not* do: it does not constrain *which* moments the agent picks or *where* it places boundaries. The ledger governs arithmetic and structure only. Editorial judgment stays with the model, which is the whole point of giving it good tools.

### 7.3 Context assembly (12-factor #4)

The context sent to Claude on each iteration is **assembled**, never appended:

| Block | Content | Caching |
|---|---|---|
| 1. System | Role, tool cost tiers, editorial rules, output rules. Static per `PROMPT_VERSION`. | `cache_control: ephemeral` breakpoint |
| 2. Brief | IQ panel selections + video facts (title, duration, chunk layout). Labelled *defaults the producer can override in conversation*. | cached |
| 3. **Live state** | Current segment table (id, start, end, duration, title) + full `Ledger` + `CostMeter`. **Regenerated fresh every iteration.** | not cached |
| 4. History | Rolling `summary` + last `N=6` turns verbatim | |
| 5. Tool ledger | Older tool calls compacted to one line each: `search_video("car argument") → 8 clips, best 412-538s` | |
| 6. Current turn | The live message + tool results so far | |

**The key move:** because block 3 is always fresh and authoritative, the agent never needs history to know the current state of the cut. That lets us compact blocks 4 and 5 hard without losing correctness. Old tool results (especially long transcript reads and Pegasus answers) are replaced by their digests after 2 turns; images are dropped from history after the turn in which they were viewed.

Budget: soft cap 120k tokens. On exceed, compaction escalates — first drop old images, then old tool result bodies, then summarize turns older than the window.

---

## 8. The agent loop

`backend/src/services/iq-agent/loop.ts`. Explicit state machine, no framework.

```
rehydrate(threadId) → assembleContext() → callClaude()
   → emit message.assistant for each prose block
   → on tool_use block:
        emit tool.started → switch(name) → execute → emit tool.finished
        if mutation → recompute ledger → commit → emit state.updated
   → heartbeat
   → if stop_reason == "tool_use"  → loop
   → if ask_user                   → suspend, release lock, emit awaiting_input
   → if finish_turn                → drain pendingMessages? loop : complete
   → if cancelRequested            → emit run.cancelled, release lock
   → if iterations > MAX (24)      → force summarize + complete
   → if remainingTime < 120s       → persist, self-invoke continuation, return
```

**Continuation.** Because the agent is stateless and all state is externalized, hitting the 15-minute Lambda ceiling is not a failure — the worker persists, self-invokes with `{isContinuation: true, runId}`, and the new invocation rehydrates and carries on. The event log is continuous, so the client never notices; its cursor just keeps advancing.

**Model.** *(Superseded: every model call now goes through SporeLabs, pinned to `anthropic/claude-sonnet-5.5` — see `backend/src/services/sporelabs.ts`. Original plan follows.)* `us.anthropic.claude-sonnet-4-5-20250929-v1:0` via Bedrock `InvokeModel` (already the model used in `claude-brief.ts`, and already covered by the existing `bedrock:InvokeModel` grant — **no IAM change needed**). Falls back to the Anthropic SDK with `ANTHROPIC_SECRET_ARN` on Bedrock throttling, the same dual-path pattern `export-metadata-enrich.ts` already uses.

**Retries.** Bedrock throttling → exponential backoff (1s, 2s, 4s, 8s), max 4 attempts. Tool errors are *not* retried by code; they are returned to the model as structured errors so it can adapt (12-factor #11).

### 8.1 The initial turn

When the user hits Generate, the API composes a first user message from the brief and **shows it in the thread** (the user explicitly wants the prompt visible — this is where we differ from Cursor). It is rendered as an expandable "Brief" card, collapsed to one line by default.

The brief instructs the agent, in essence: orient with `search_video` and `check_budget` first, form a plan, state it in prose, verify candidates with the cheap tools, use `watch_clip` only where it changes a decision, build the cut with `edit_segments`, and land inside the band before finishing. It is guidance, not a script — the agent chooses its own path, and a user instruction overrides any of it.

---

## 9. Durability, concurrency, and safety

This section addresses the explicit requirement: spam, refresh, dropped internet.

### 9.1 Spammed messages

- Every send carries a client-generated `idempotencyKey` (UUID). The API does a conditional `PutItem` on the key; a duplicate returns the original `{runId, seq}` with `200` instead of starting new work.
- **Run lock.** Starting a run is a conditional update: `attribute_not_exists(activeRunId)`. Exactly one run per project can be active.
- If a run is already active, the message is **appended to `pendingMessages`** and returns `202 {queued: true, activeRunId}`. The worker drains the queue at the next turn boundary (after `finish_turn`, before completing). This mirrors Cursor's "type while it works" behavior and means user input is never dropped.
- The composer disables the send button only during the network round-trip, not for the whole run.

### 9.2 The polling loop

One loop, in `useAgentPoll.ts`. It replaces the five near-duplicate polling implementations scattered across the frontend today.

```
GET /projects/{id}/agent/events?afterSeq=<cursor>&limit=200
  → { events[], lastSeq, runStatus, suggestedPollMs, hasMore }
```

**Adaptive interval.** The goal is fast updates when something is happening and near-silence when nothing is.

| Situation | Interval |
|---|---|
| Just posted a message | immediate, then 700ms for the first 3 polls |
| Active run, events arriving | **1s** |
| Active run, 3 consecutive empty polls | 2s |
| Active run, 6+ consecutive empty polls (long tool call) | 4s, capped at **5s** |
| `hasMore: true` (catching up after a gap) | immediate next poll, no delay |
| Run terminal, or no active run | **stop entirely** |
| Tab hidden | **stop entirely** |
| Network error | backoff 1s → 2s → 4s → … capped at 30s |

Any non-empty response resets the interval to 1s. ±15% jitter is applied so multiple tabs do not synchronize.

**Stop when idle** is the single most important rule. Today the editor runs `syncMiddleware` plus up to four framing pollers on fixed intervals whether or not anything is happening. Here, the moment a run reaches a terminal state the loop stops and does not restart until the user sends a message. An idle project makes zero requests.

**Tab visibility.** `document.visibilityState === "hidden"` pauses polling; `visibilitychange` back to visible triggers an immediate catch-up poll. A backgrounded tab during a 10-minute run costs nothing and catches up instantly on focus.

**Server-suggested pacing.** The response carries `suggestedPollMs`, which the client honors as a floor. The API knows things the client does not — for example, that the worker started a `watch_clip` 4 seconds ago and nothing will happen for a while, so it can suggest 4s and cut the request count on the slowest part of a run. This keeps pacing logic server-side where it can evolve without a frontend deploy.

**Cost sanity.** A 5-minute run at a ~1.5s average is roughly 200 requests, each a single DynamoDB `Query` on a hash+range key. That is negligible against the existing 10-second autosave loop, and idle projects now poll less than they do today.

**Long-polling was considered and rejected.** Holding the request server-side for ~25s would cut request count and deliver events instantly, but it burns Lambda duration on every quiet second, adds concurrency pressure, and sits uncomfortably close to the hard 30s API Gateway ceiling. Short adaptive polling is simpler and fast enough.

### 9.3 Page refresh

- Nothing about the run lives in browser memory that matters. On mount the client calls `GET /projects/{id}/agent/thread`, which returns thread state, `activeRunId`, and `lastSeq`.
- It then polls from `afterSeq=0` (full replay, paging via `hasMore`) and the transcript rebuilds exactly.
- Because the log is append-only and seq-ordered, replay is deterministic. **There is no separate resume code path** — resume is the normal path with a different cursor. That is the main reason today's three hand-rolled resume effects in `Editor.tsx` disappear.

### 9.4 Dropped internet

- The worker never observes the client, so a dead connection has no effect on the run.
- Failed polls back off to a 30s cap and surface a non-blocking *Reconnecting…* banner. On success the client requests everything after its last cursor and catches up in one or two pages.
- There is no connection state to manage, no heartbeat to interpret, and no reconnect handshake — the request is stateless, so "recovering from a dropped connection" is just "the next poll succeeds."

### 9.5 Crash detection

- The worker writes `lastHeartbeatAt` on the run item every 15s and before and after every tool call.
- A run whose heartbeat is older than **90 seconds** is dead. Any reader reaps it: marks it `failed` with `code: "worker_died"`, appends `run.failed`, and clears `activeRunId` so the project is usable again.
- Reaping happens inside the events endpoint, which the client is already calling every second or two during a run. The check therefore runs constantly with no extra requests and no scheduled job.
- This replaces the current 15-minute stale check and, unlike it, **covers every status** — fixing bug §2.5.1 by construction.

### 9.6 Cancel

`POST /projects/{id}/agent/runs/{runId}/cancel` sets `cancelRequested: true`. The worker checks it between iterations and before each tool call, appends `run.cancelled`, commits whatever segments it had already applied (edits are never rolled back — partial progress is real progress), and clears the lock. The client sees the cancellation on its next poll, within about a second.

### 9.7 The autosave race

Fixed explicitly:

- While `activeRunId` is set, `syncMiddleware` **suspends syncing `segments`** (title, captions, and framing settings still sync). The server is the sole writer of segments during a run.
- Each `state.updated` event dispatches `setSegments` on the client, which by existing design does **not** mark the project dirty. No write-back loop.
- On `run.completed` / `run.failed` / `run.cancelled`, normal autosave resumes.
- Manual edits made during a run are not lost: the composer surfaces "you edited segments while the agent was working" and the next turn's live-state block reflects whatever is actually on the project, so the agent sees the user's changes.

---

## 10. Autoframing

Requirement: framing must always happen, regardless of what the user does.

- The `autoFrame` toggle stays in the panel (it is a real pipeline concern, not a prompt concern).
- Framing is **not an agent tool** — it is a deterministic post-run step, so it cannot be forgotten by a model. When a run reaches a terminal state with `autoFrame` on and segments changed, the worker invokes `zeevee-analyze-framing` with `isDirectBatchStart: true`, exactly as `generateSegments.ts:657` does today.
- **Diff-based.** Only segments whose `startTime`/`endTime` changed are re-framed. Untouched segments keep their existing keyframes. This is a significant speedup over today's re-frame-everything behavior on follow-up turns, which matters a lot now that turns are frequent.
- Framing progress is mirrored into the event log (`framing.started` / `framing.progress` / `framing.completed`) so the UI shows it in the same thread rather than through a fourth parallel polling loop.
- The existing `applyFramingUpdates` staleness guard (`atStartTime`/`atEndTime`) is retained and is the right model — if the agent moved a segment while framing was in flight, the stale result is discarded.
- If a new run starts while framing is running, framing is left to finish; its results apply only to segments the new run has not touched.

---

## 11. API surface

Four routes, all on the existing HTTP API v2, all plain JSON, all authenticated by the existing `x-api-password` header via `checkAuth`. No new public surface and no new auth path.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/projects/{projectId}/agent/thread` | Thread state, `activeRunId`, `lastSeq`, segments, ledger |
| `POST` | `/projects/{projectId}/agent/messages` | `202 {runId, seq, queued}`. Body: `{text, brief?, idempotencyKey, answerTo?}` |
| `GET` | `/projects/{projectId}/agent/events?afterSeq=N&limit=200` | see below |
| `POST` | `/projects/{projectId}/agent/runs/{runId}/cancel` | `200` |

The events endpoint is the workhorse:

```jsonc
{
  "events": [ /* seq-ordered, exclusive of afterSeq */ ],
  "lastSeq": 214,
  "hasMore": false,          // true when truncated by limit — poll again immediately
  "runStatus": "running",    // running | awaiting_input | completed | failed | cancelled | idle
  "activeRunId": "run_...",
  "suggestedPollMs": 1000    // server-side pacing hint (§9.2)
}
```

It is a single `Query(runId, seq > afterSeq)` plus the heartbeat reap check (§9.5). Add all four routes with the standard three-resource pattern at `networking.tf:229-248`.

---

## 12. Frontend UX

The IQ panel (right sidebar, `activeTab === "ai"`, 420px) becomes a chat surface. Keep the existing visual language: `bg-muted/50` headers, blue accent, `text-xs font-semibold uppercase tracking-wider` section labels.

```
┌──────────────────────────────────────┐
│ ✨ IQ Editor              [⋯] [↻]    │
├──────────────────────────────────────┤
│ ▸ Setup · TV · Mobile · Compact ·    │  ← collapsed IQ controls
│   60–180s · Auto-frame on            │     (expands to today's panel)
├──────────────────────────────────────┤
│                                      │
│  ▸ Brief: Cut a compact microseries… │  ← the visible initial prompt
│                                      │
│  I'll start by mapping the episode   │  ← assistant prose
│  and finding the main story beats.   │     (arrives per block)
│                                      │
│  ┌────────────────────────────────┐  │  ← THE ACTIVITY BOX
│  │ ⚡ Working                      │  │     live counters, collapsed
│  │ 14 tools · 6 searches ·        │  │
│  │ 8 clips · 22 min watched ·     │  │
│  │ 31 frames                   ▸  │  │
│  └────────────────────────────────┘  │
│                                      │
│  I've built a 12-segment cut. Two    │
│  segments run slightly long — want   │
│  me to tighten them or leave them?   │
│                                      │
├──────────────────────────────────────┤
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░  31:04 / 30:00 ⚠  │  ← BUDGET BAR (pinned)
│ 12 segments · 2 over max                │
├──────────────────────────────────────┤
│ [ Ask for a change…          ] [ ⏹ ] │
└──────────────────────────────────────┘
```

### 12.1 The activity box

The "small box below which lists out the summary statistics." One card per assistant turn, appearing under the prose.

**Collapsed** (default): a single status line plus a live counter row — tool calls, searches, clips watched, video-minutes analyzed, frames viewed, segments added/removed/adjusted. Numbers tick up in real time. When the turn ends it settles into `✓ Done · 14 tools · 22 min analyzed · 2m 41s`.

**Expanded**: a vertical timeline of tool calls, each one row — icon, label, duration, and outcome summary. Rows expand individually to show the full input and result. Consecutive calls to the same tool group into one collapsible row (`🔍 6 searches`). Frames viewed render as a thumbnail strip, which is genuinely useful — the user sees what the agent saw.

Tool labels are written for humans, not developers: `search_video` → *Searching for "car argument"*; `watch_clip` → *Watching 6:52–8:58*; `read_transcript` → *Reading dialogue 6:52–8:58*; `view_frames` → *Looking at 4 frames*; `edit_segments` → *Added 3 segments, removed 1*.

### 12.2 The budget bar

Pinned above the composer, always visible, driven by the `Ledger`. A horizontal bar showing total duration against the target band — green inside the band, amber outside, with the band edges marked. Below it: segment count and a violation chip (`2 over max`) that opens a popover listing the offending segments, each clickable to select it in the timeline.

This is the client's obsession made ambient. They should never have to ask "does this add up."

### 12.3 Questions

`question.asked` renders an inline card with the question text and any `suggestions` as one-click chips. Clicking a chip or typing a reply posts a message with `answerTo: questionId`. The composer autofocuses.

### 12.4 Other details

- **No blind waiting.** The first `tool.started` event lands within a second or two of hitting Generate, so the panel is alive almost immediately. Compare to today's 30-second blank spinner.
- **Prose arrives per block**, not per token. Because a `tool.started` event is written *before* each tool runs, the gap between prose blocks is filled with a live "Watching 6:52–8:58…" row rather than dead air.
- **Stop** button replaces send while running.
- Segments update live in the timeline as `state.updated` arrives — the user watches the cut assemble.
- A thin *Reconnecting…* banner appears after two consecutive failed polls. Non-blocking, since the run continues regardless.
- The Setup section collapses after the first send but stays editable; changing it mid-conversation posts a system-ish message (*Brief updated: format → Episode Recap*) so the agent sees it.
- **Optimistic echo.** The user's own message renders instantly on send, before the POST resolves, and reconciles when it appears in the event log.

---

## 13. Infrastructure changes

Deliberately small. No Function URL, no new IAM actions, no new public surface.

```hcl
# 1. Two new DynamoDB tables (PAY_PER_REQUEST, TTL on expiresAt)
aws_dynamodb_table.agent_threads   # hash: projectId
aws_dynamodb_table.agent_events    # hash: runId, range: seq, GSI ProjectIdIndex

# 2. Two new Lambdas, both prefixed zeevee-
aws_lambda_function.iq_agent_api      # 30s,  512MB
aws_lambda_function.iq_agent_worker   # 900s, 2048MB, layers = [ffmpeg]

# 3. IAM — ONE change to zeevee-lambda-policy
#    Add the two new table ARNs (+ /index/*) to the existing DynamoDB statement.
#    bedrock:InvokeModel is already granted on "*" — no Bedrock change needed,
#    because we use InvokeModel, not InvokeModelWithResponseStream.

# 4. Four new HTTP API routes + integrations + lambda permissions
#    (follow the exact 3-resource pattern at networking.tf:229-248)
```

**Worker memory.** 2048 MB, not the 128 MB that `zeevee-generate-segments` runs at today. Frame extraction and base64 image handling need it, and the current under-provisioning is the likely root of the OOM failures the stale-job check exists to mask.

**Deploy.** Unchanged: `./deploy.sh` from repo root, AWS profile `zeevee`, region `us-west-2`. Frontend ships via Vercel on merge to `main`. Note that `deploy.sh` does not build the ffmpeg *layer* — if the layer zip is missing, run `./build-ffmpeg-layer.sh` first.

### 13.1 Delete the Pegasus scene-detection system

This is dead weight that also happens to be a deploy hazard, and the new agent has no use for it. Remove all of it:

| What | Where |
|---|---|
| `aws_lambda_function.detect_scenes` + `data.archive_file.detect_scenes_zip` | `infrastructure/compute.tf:472-497` |
| `DETECT_SCENES_FUNCTION` env var | `infrastructure/compute.tf:523` |
| `detectScenes()`, `detectScenesForEntireVideo()`, the scene prompt, `getSceneCacheFromS3()`, `writeSceneCache()` | `backend/src/services/twelvelabs.ts` |
| `SceneBreak`, `SceneDetail`, `SceneDetectionResult`, `SceneCache*` types | `backend/src/services/twelvelabs.ts:191+` |
| `SceneDetectionPendingError` | `backend/src/services/storyiq/types.ts:257` |
| Stale `backend/dist/detectScenes.js` artifact | delete from disk |
| `scene-cache/` S3 prefix | one-time `aws s3 rm s3://zeevee-media-dev/scene-cache/ --recursive` |

Why this is safe: `backend/src/handlers/detectScenes.ts` **was already deleted** in commit `fcdac31`. The Terraform resource archives a stale May-dated `dist/detectScenes.js` that `npm run build` can no longer regenerate, so the deployed Lambda has been running months-old code that nothing invokes. Because `esbuild` does not clean `outdir`, a clean checkout plus `npm run build` would fail `tofu apply` today — removing this fixes that latent break.

Also check `backend/dist/` for three other orphans with no source: `setProjectThumbnail.js`, `setSegmentThumbnail.js`, `stitchSegments.js`.

---

## 14. Code layout

```
backend/src/services/iq-agent/
  loop.ts          # control flow state machine — prompt→parse→switch→execute→loop
  context.ts       # context assembly + compaction (§7.3)
  prompts.ts       # ALL prompts, PROMPT_VERSION constant
  tools.ts         # JSON schemas only
  executor.ts      # switch: name → handler
  ledger.ts        # deterministic budget computation (pure, unit-testable)
  events.ts        # append/query the event log, seq allocation, batching
  thread.ts        # thread rehydrate/persist, lock acquire/release, reaping
  cost.ts          # meter + per-run caps
  tools/
    search.ts      # Marengo + chunk timestamp mapping
    transcript.ts  # ranged reads, sentence grouping
    watchClip.ts   # Pegasus 1.5 ranged + cache + chunk splitting
    frames.ts      # ffmpeg extract → base64 image blocks
    edit.ts        # edit_segments + guardrails
backend/src/handlers/
  iqAgentApi.ts    # thread, messages, events, cancel
  iqAgentWorker.ts

zeevee/src/components/editor/iq-agent/
  IQAgentPanel.tsx      # replaces MicroseriesGenerator as the "ai" tab
  SetupSection.tsx      # the collapsed IQ controls (reuses today's components)
  MessageThread.tsx
  ActivityBox.tsx       # the summary-statistics box
  BudgetBar.tsx
  QuestionCard.tsx
  Composer.tsx
zeevee/src/hooks/
  useAgentPoll.ts       # adaptive poll loop, seq cursor, visibility, backoff (§9.2)
zeevee/src/store/
  agentSlice.ts         # thread state derived from events
```

`ledger.ts` is a pure function with no I/O — it gets unit tests in the existing `npm test` chain alongside `test:jockey-coverage`. So does the chunk-timestamp mapping in `tools/search.ts` and `tools/watchClip.ts`, which is the subtlest logic in the whole feature.

---

## 15. Rollout

| Phase | Deliverable | Verifiable by |
|---|---|---|
| 0 | Two tables, two Lambdas, IAM table ARNs. Delete the scene-detection system (§13.1). | `tofu apply` clean from a fresh `npm run build` |
| 1 | Agent core + all 8 tools + ledger, driven by a CLI script (`npm run iq:eval`) against a known asset. No UI. | Segment quality + duration adherence vs. the Jockey baseline |
| 2 | Event log, API routes, worker durability (lock, heartbeat, reap, continuation, cancel) | Kill the worker mid-run; confirm reap and clean restart |
| 3 | Frontend: `useAgentPoll`, thread, activity box, budget bar, questions | Refresh mid-run, kill Wi-Fi mid-run, spam send, background the tab |
| 4 | Autoframing integration, diff-based reframe, hide the legacy paths | Side-by-side against Jockey on the eval suite |

### 15.1 Legacy paths: keep the code, hide the doors

Both existing generation paths stay in the codebase and stay deployable. Neither is deleted in this project.

- **Jockey v3** (`jockey-v3-pipeline.ts`, `jockey-pipeline.ts`, `jockey-agents-api.ts`, the `jockey/` directory) — code untouched, env flags `JOCKEY_COMPACT_RECAP_ENABLED` / `JOCKEY_V3_SELF_DIRECTED_ENABLED` left as they are.
- **Pegasus-only** (`pegasus-pipeline.ts` and friends) — code untouched. It still serves `highlights` and `full_video`, which are out of scope here.

What changes is only what the UI *offers*. The "Enhanced Cut" toggle is removed from the panel; `compact_video` and `episode_recap` route to the IQ Agent. `POST /projects/{id}/generate` and its `jockeyEnabled` flag remain live and functional for scripts, evals, and manual rollback — they simply have no UI entry point.

Rollback is therefore a frontend-only change plus flipping `IQ_AGENT_ENABLED=false`, with no backend redeploy and no data migration. Revisit deletion in a later cleanup once the agent has real production mileage.

**Eval.** Extend `backend/src/scripts/jockey-eval-suite/` with the same assets so the comparison is apples to apples. Track: duration-band adherence rate, per-segment bound violations, quartile coverage, Pegasus video-seconds per run, cache hit rate, redundant-call rate, wall-clock to first token, wall-clock to completion, and cost per run.

---

## 16. Acceptance criteria

**Duration adherence** (the client's headline metric)
- [ ] Total duration lands inside the target band on ≥ 90% of runs without user intervention
- [ ] Zero per-segment min/max violations at `finish_turn`, or they are explicitly surfaced as concerns
- [ ] The user can see total-vs-target at all times without expanding anything
- [ ] Zero overlapping segments, ever (structurally impossible via `edit_segments`)
- [ ] Boundary quality is at or above the current Jockey baseline on spot-check, using Pegasus timings as-is

**Cost**
- [ ] No Pegasus call in the agent path omits a time range — enforced in code and covered by a unit test
- [ ] Repeat `watch_clip` on the same window is a cache hit and charges nothing
- [ ] A near-duplicate window (≥ 90% overlap) with a reworded question returns the prior answer instead of re-billing
- [ ] No tool can spin: every failure mode returns a structured error with a hint, and retries are bounded
- [ ] Video-seconds watched is visible to both the model and the user throughout the run

**Durability**
- [ ] Refresh mid-run: transcript rebuilds exactly, polling resumes from cursor, no duplicate work
- [ ] Airplane-mode for 60s mid-run: backs off, recovers on reconnect, replays every missed event, run unaffected
- [ ] Ten rapid sends: one run, ten queued messages, zero duplicates
- [ ] `kill -9` the worker: run marked failed within 90s, project immediately usable
- [ ] Cancel stops within one tool call and preserves edits already applied
- [ ] Autosave never overwrites agent-written segments

**Polling behavior**
- [ ] An idle project with no active run issues **zero** requests
- [ ] A hidden tab issues zero requests and catches up fully on focus
- [ ] Events surface within ~1s while a run is actively producing them
- [ ] A 5-minute run stays under ~250 event requests
- [ ] Exactly one poll loop exists in the frontend for agent runs (the five duplicated framing pollers are consolidated or removed)

**Experience**
- [ ] First visible activity in the panel within 5 seconds (today: 30 seconds of nothing)
- [ ] Every tool call visible with a human-readable label
- [ ] Follow-up edits ("tighten segment 3") work without regenerating from scratch
- [ ] The agent asks a clarifying question when the brief is genuinely ambiguous
- [ ] Autoframing completes after every run where segments changed and the toggle is on

---

## 17. Decisions (resolved)

These were reviewed and settled. Recorded here so the implementing agent does not relitigate them.

1. **Transport → adaptive polling. No streaming.** An earlier draft specced SSE over a Lambda Function URL; it was cut because the new failure surface (public endpoint, query-string auth, reconnect and heartbeat logic, a third Lambda, plus a polling fallback anyway) outweighed the benefit of token-by-token prose. Tool time dominates a run, not prose generation, so adaptive polling delivers nearly the same perceived responsiveness with far less to go wrong. See §4.2 for the reasoning and §9.2 for the loop design. The event log keeps the upgrade path open if we ever want it.

2. **Concurrent sends → queue,** Cursor-style. The worker drains `pendingMessages` at the next turn boundary. User input is never dropped.

3. **Boundary timing → trust Pegasus.** No automatic snapping to word ends, scene changes, or anything else. Producing usable timestamps is what Pegasus is for, and mechanical snapping would make some cuts worse, since scenes routinely do not end on the last word. The agent may refine an edge itself via `read_transcript` (word granularity) or `view_frames` if it judges that worthwhile. Revisit snapping later once we have evidence from real cuts.

4. **Scene detection → deleted.** Remove the whole Pegasus scene-detection system per §13.1. It is already orphaned, it is a deploy hazard, and the new toolset makes it unnecessary.

5. **Pegasus spend → no cap.** Waste is prevented structurally instead: mandatory time ranges, a cross-run result cache, overlap-aware repeat detection, per-call timeouts, bounded retries, and an advisory meter visible to both the model and the user. A hard cap would truncate legitimately thorough runs while doing nothing about the actual failure mode, which is redundant calls.

6. **Legacy paths → kept but hidden.** Jockey v3 and the Pegasus-only route stay in the codebase and stay deployable; only their UI entry points go away. See §15.1. Rollback is a frontend change plus one env flag.

### Still open (non-blocking, decide during Phase 1)

- **`view_frames` caps.** Currently 6 per call, 40 per run. These are anti-footgun rails on context size, not cost, and are cheap to tune once we see how the agent actually uses vision.
- **Guarded-finish strictness.** `finish_turn` currently refuses once on blocking violations, then allows the finish with recorded concerns. If duration adherence still misses the 90% bar in eval, raise it to two refusals before revisiting the prompt.
- **Overall guidance philosophy.** The system prompt should stay loose — describe the tools, their cost tiers, and the goal, then get out of the way. If eval shows the agent under-exploring, add capability hints rather than workflow steps.
