# ZeeVee Architecture Report

_"We don't just wrap the LLM - we give it a film degree."_

---

## The Narrative IQ Tech Stack

```mermaid
graph TB
    subgraph ZVProp["ZV Proprietary"]
        subgraph Studio["ZV Narrative IQ Studio"]
            Portal["Management Portal: Uploader, Editor, Asset Manager"]
        end

        subgraph Orch["ZV Orchestration Layer — THE MOAT"]
            SM["Story<br/>Models"]
            PM["Platform<br/>Models"]
            AM["Audience<br/>Models"]
            BM["Business<br/>Models"]
            NIQ["Narrative IQ:<br/>Adaptive Story<br/>Agents"]
        end
    end

    subgraph Leveraged["Leveraged AI Components"]
        FM["Foundation Models"]
        TR["Transcribe"]
        RF["Reframe"]
        CP["Caption"]
        MD["Metadata"]
    end

    subgraph Infra["Enterprise-Grade Infrastructure"]
        AWS["Cloud Platform - AWS<br/>Ingest | Storage | Delivery | Processing"]
    end

    Portal --> SM
    Portal --> PM
    Portal --> AM
    Portal --> BM
    Portal --> NIQ

    SM --> FM
    PM --> TR
    AM --> RF
    BM --> CP
    NIQ --> MD

    FM --> AWS
    TR --> AWS
    RF --> AWS
    CP --> AWS
    MD --> AWS

    style Portal fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style SM fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style PM fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style AM fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style BM fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style NIQ fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style FM fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style TR fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style RF fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style CP fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style MD fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style AWS fill:#4A90A4,stroke:#357082,color:#FFFFFF
```

---

## System Architecture Overview

```mermaid
flowchart TB
    subgraph Frontend["Frontend - React + Remotion"]
        UI["Web Editor"]
        Preview["Real-time Preview"]
        Export["Export Controls"]
    end

    subgraph API["API Gateway"]
        REST["REST Endpoints"]
    end

    subgraph Orchestration["ZV Orchestration Layer"]
        StoryIQ["Story IQ Editor<br/>Narrative Intelligence"]
        Framing["Smart Framing<br/>Subject Tracking"]
        Chunker["Video Chunker<br/>Long-form Handler"]
    end

    subgraph ExtAI["Leveraged AI Services"]
        TL["TwelveLabs Pegasus<br/>Video Understanding"]
        Claude["Claude Sonnet<br/>Creative Reasoning"]
        Remotion["Remotion Lambda<br/>Video Rendering"]
    end

    subgraph Storage["AWS Infrastructure"]
        S3[("S3 Media Storage")]
        DDB[("DynamoDB")]
    end

    UI --> REST
    Preview --> REST
    Export --> REST

    REST --> StoryIQ
    REST --> Framing
    REST --> Chunker

    StoryIQ --> TL
    StoryIQ --> Claude
    Framing --> TL
    Chunker --> TL

    StoryIQ --> S3
    StoryIQ --> DDB
    Framing --> S3
    Chunker --> S3

    Remotion --> S3

    style UI fill:#2E5A88,stroke:#1E3A58,color:#FFFFFF
    style Preview fill:#2E5A88,stroke:#1E3A58,color:#FFFFFF
    style Export fill:#2E5A88,stroke:#1E3A58,color:#FFFFFF
    style REST fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
    style StoryIQ fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Framing fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Chunker fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style TL fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style Claude fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style Remotion fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style S3 fill:#D4A84B,stroke:#B48830,color:#000000
    style DDB fill:#D4A84B,stroke:#B48830,color:#000000
```

---

## Core Workflow: Video to Microdrama

```mermaid
sequenceDiagram
    participant User
    participant ZV as ZV Orchestration
    participant 12L as TwelveLabs
    participant LLM as Claude
    participant SL as SporeLabs
    participant Render as Remotion

    User->>ZV: Upload Video
    ZV->>ZV: Check Duration

    alt Video > 60 min
        ZV->>ZV: Split into Chunks (55min + overlap)
    end

    ZV->>12L: Index Video(s)
    12L-->>ZV: Scenes, Transcript, Metadata

    User->>ZV: Generate TikTok microdrama
    ZV->>12L: Get Scene List with Timestamps
    12L-->>ZV: Grounded Scene Data

    ZV->>LLM: Reason about best segments
    Note over ZV,LLM: Context: Scenes + User Goals
    LLM-->>ZV: Segment Recommendations

    ZV->>ZV: Validate and Filter
    ZV-->>User: Proposed Segments

    User->>ZV: Adjust + Export
    ZV->>ZV: Build 360p frame-exact proxy
    ZV->>SL: Shot-hold reframe (all segments)
    SL-->>ZV: One hold per camera shot

    ZV->>Render: Render with Captions + Framing
    Render-->>User: Final Microdrama
```

---

## The Story IQ Editor: Two-Stage Intelligence Pipeline

```mermaid
flowchart LR
    subgraph Stage1["Stage 1: PERCEIVE - Video Intelligence"]
        Video["Source Video"]
        TL["TwelveLabs<br/>Pegasus"]
        Ground["Ground Truth:<br/>• Scene timestamps<br/>• Transcript<br/>• Topics and Tags"]
    end

    subgraph Stage2["Stage 2: REASON - Narrative Intelligence"]
        Context["Video Context<br/>+ User Goals"]
        Claude["Claude Sonnet"]
        Plan["Segment Plan:<br/>• Start and End times<br/>• Titles<br/>• Reasoning"]
    end

    subgraph Stage3["Stage 3: VALIDATE"]
        Val["Validation:<br/>• Bounds check<br/>• Min duration<br/>• No overlaps"]
        Output["Final Segments<br/>for Microdrama"]
    end

    Video --> TL
    TL --> Ground
    Ground --> Context
    Context --> Claude
    Claude --> Plan
    Plan --> Val
    Val --> Output

    style Video fill:#2E5A88,stroke:#1E3A58,color:#FFFFFF
    style TL fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style Ground fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
    style Context fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Claude fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style Plan fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Val fill:#D4A84B,stroke:#B48830,color:#000000
    style Output fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
```

**Key Design Decision**: Segment recommendations are _grounded_ to actual scene timestamps from video analysis. The language model never hallucinates timestamps—it selects from verified scene data.

---

## Smart Auto-Framing System

```mermaid
flowchart TB
    subgraph Input["Input"]
        Landscape["16:9 Landscape Video"]
        Target["Target: 9:16 or 1:1"]
    end

    subgraph Analysis["Video Intelligence Analysis - per segment"]
        Q1{"Who or what is<br/>the subject?"}
        Q2{"Where are they<br/>in frame?"}
        Q3{"CROP or FIT?"}
    end

    subgraph Decision["Decision"]
        CROP["CROP Mode<br/>Fill frame, track subject"]
        FIT["FIT Mode<br/>Letterbox, show all"]
    end

    subgraph Position["Position Tokens"]
        FL["FAR_LEFT = 0.0"]
        SL["SLIGHT_LEFT = 0.25"]
        C["CENTER = 0.5"]
        SR["SLIGHT_RIGHT = 0.75"]
        FR["FAR_RIGHT = 1.0"]
    end

    subgraph Render["CSS-Based Rendering"]
        CSS["object-fit: cover or contain<br/>object-position: X% Y%"]
    end

    Landscape --> Q1
    Target --> Q1
    Q1 --> Q2
    Q2 --> Q3
    Q3 --> CROP
    Q3 --> FIT
    CROP --> Position
    Position --> CSS
    FIT --> CSS

    style Landscape fill:#2E5A88,stroke:#1E3A58,color:#FFFFFF
    style Target fill:#2E5A88,stroke:#1E3A58,color:#FFFFFF
    style Q1 fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Q2 fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Q3 fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style CROP fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
    style FIT fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
    style FL fill:#D4A84B,stroke:#B48830,color:#000000
    style SL fill:#D4A84B,stroke:#B48830,color:#000000
    style C fill:#D4A84B,stroke:#B48830,color:#000000
    style SR fill:#D4A84B,stroke:#B48830,color:#000000
    style FR fill:#D4A84B,stroke:#B48830,color:#000000
    style CSS fill:#4A90A4,stroke:#357082,color:#FFFFFF
```

**Current engine (`FRAMING_ENGINE=sporelabs`, default)**: `analyzeFraming` builds a 360p, every-frame proxy of the raw master (`proxy/<assetId>.mp4`, fanned out across Lambda slices for long sources) and submits all segments to the SporeLabs shot-hold service. SporeLabs detects camera cuts from pixels and returns one `(zoom, focusX, focusY)` hold per shot, already on the source frame grid; segment bounds are never touched. Long jobs store `framingJob.sporelabsJobId` and continue polling in a fresh invocation. `FRAMING_ENGINE=gemini` restores the legacy per-segment Gemini `TIME|ZOOM` path.

---

## Transparent Chunked Video Processing

```mermaid
flowchart TB
    subgraph Problem["The Problem"]
        Long["Video longer than 60 min"]
        Limit["External API Limit: 60 min max"]
    end

    subgraph Solution["ZV Solution: Transparent Chunking"]
        Split["Split into 55-min chunks<br/>with 30-sec overlap"]
        Index["Index each chunk<br/>in parallel"]
        Wrapper["TwelveLabs Wrapper:<br/>Abstracts chunking"]
    end

    subgraph Magic["The Magic"]
        Adjust["Adjust timestamps<br/>chunk-relative to original"]
        Merge["Merge transcriptions<br/>across chunks"]
        Dedup["Deduplicate<br/>overlap regions"]
    end

    subgraph Result["Result"]
        API["Single unified API<br/>Works like one video"]
    end

    Long --> Split
    Limit --> Split
    Split --> Index
    Index --> Wrapper
    Wrapper --> Adjust
    Wrapper --> Merge
    Wrapper --> Dedup
    Adjust --> API
    Merge --> API
    Dedup --> API

    style Long fill:#C75050,stroke:#A73030,color:#FFFFFF
    style Limit fill:#C75050,stroke:#A73030,color:#FFFFFF
    style Split fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Index fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Wrapper fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Adjust fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
    style Merge fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
    style Dedup fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
    style API fill:#4A90A4,stroke:#357082,color:#FFFFFF
```

**Key Design Decision**: Consumers of the API never need to know if a video was chunked. All timestamps are in the original video's timeline.

---

## Distributed Rendering Pipeline

```mermaid
flowchart LR
    subgraph Input["Input"]
        Job["Render Job"]
        Segs["Segments"]
        Caps["Captions"]
        Frame["Framing Data"]
    end

    subgraph Preprocess["FFmpeg Preprocessing"]
        Stitch["Stitch Segments"]
        Adjust["Adjust Caption Timings"]
    end

    subgraph RemotionRender["Remotion Lambda - Distributed"]
        W1["Lambda Worker 1<br/>frames 0-150"]
        W2["Lambda Worker 2<br/>frames 151-300"]
        WN["Lambda Worker N<br/>..."]
        Combine["Combine Chunks"]
    end

    subgraph Output["Output"]
        Final["Final MP4 or WebM"]
        S3[("S3 Delivery")]
    end

    Job --> Stitch
    Segs --> Stitch
    Caps --> Adjust
    Frame --> Adjust

    Stitch --> W1
    Stitch --> W2
    Stitch --> WN
    Adjust --> W1
    Adjust --> W2
    Adjust --> WN

    W1 --> Combine
    W2 --> Combine
    WN --> Combine

    Combine --> Final
    Final --> S3

    style Job fill:#2E5A88,stroke:#1E3A58,color:#FFFFFF
    style Segs fill:#2E5A88,stroke:#1E3A58,color:#FFFFFF
    style Caps fill:#2E5A88,stroke:#1E3A58,color:#FFFFFF
    style Frame fill:#2E5A88,stroke:#1E3A58,color:#FFFFFF
    style Stitch fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Adjust fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style W1 fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style W2 fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style WN fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style Combine fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
    style Final fill:#D4A84B,stroke:#B48830,color:#000000
    style S3 fill:#D4A84B,stroke:#B48830,color:#000000
```

**Key Design Decision**: ~120 parallel Lambda workers for a 10-minute video. Rendering is massively parallelized for speed.

---

## Data Model (Simplified)

```mermaid
erDiagram
    ASSET ||--o{ PROJECT : "has many"
    ASSET ||--o{ CHUNK : "split into"
    PROJECT ||--o{ SEGMENT : "contains"
    PROJECT ||--o{ RENDER_JOB : "exports to"

    ASSET {
        string assetId PK
        string s3VideoUrl
        float duration
        boolean isChunked
        string status
    }

    CHUNK {
        int chunkIndex
        string s3Key
        float startOffset
        float endOffset
        string videoId
    }

    PROJECT {
        string projectId PK
        string assetId FK
        string title
        json captionSettings
        json metadata
    }

    SEGMENT {
        string id
        float startTime
        float endTime
        string title
        json framing
    }

    RENDER_JOB {
        string jobId PK
        string projectId FK
        string status
        int progress
        string downloadUrl
    }
```

**Terminology:**

- **Asset** = Original uploaded video
- **Project** = A microdrama created from an asset
- **Segment** = A selected portion of the original video
- **Render Job** = An export of a microdrama

---

## Future: Feedback-Driven Learning System

```mermaid
flowchart TB
    subgraph Create["Content Creation"]
        Upload["Upload Video"]
        Generate["Story IQ Generates Segments"]
        Export["Export Microdrama to Platform"]
    end

    subgraph Distribute["Distribution"]
        TikTok["TikTok"]
        Reels["Instagram Reels"]
        Shorts["YouTube Shorts"]
    end

    subgraph Measure["Performance Metrics"]
        Watch["Watch Time %"]
        Engage["Engagement Rate"]
        Share["Share and Save Rate"]
        Drop["Drop-off Points"]
    end

    subgraph Learn["Learning Layer"]
        Collect["Collect Metrics<br/>per Microdrama"]
        Correlate["Correlate with:<br/>• Segment selection<br/>• Framing choices<br/>• Caption style<br/>• Pacing"]
        Model["Update Models:<br/>• Story Models<br/>• Platform Models<br/>• Audience Models"]
    end

    subgraph Improve["Improved Generation"]
        Better["Better Recommendations:<br/>• Scene selection<br/>• Optimal length<br/>• Framing preferences<br/>• Caption timing"]
    end

    Upload --> Generate
    Generate --> Export
    Export --> TikTok
    Export --> Reels
    Export --> Shorts

    TikTok --> Watch
    Reels --> Engage
    Shorts --> Share
    TikTok --> Drop

    Watch --> Collect
    Engage --> Collect
    Share --> Collect
    Drop --> Collect

    Collect --> Correlate
    Correlate --> Model
    Model --> Better
    Better --> Generate

    style Upload fill:#2E5A88,stroke:#1E3A58,color:#FFFFFF
    style Generate fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Export fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
    style TikTok fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style Reels fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style Shorts fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style Watch fill:#D4A84B,stroke:#B48830,color:#000000
    style Engage fill:#D4A84B,stroke:#B48830,color:#000000
    style Share fill:#D4A84B,stroke:#B48830,color:#000000
    style Drop fill:#D4A84B,stroke:#B48830,color:#000000
    style Collect fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Correlate fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Model fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Better fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
```

---

### Feedback Loop: Detailed View

```mermaid
flowchart LR
    subgraph Inputs["Feedback Inputs"]
        API["Platform APIs<br/>TikTok, Meta, YouTube"]
        Manual["Manual Input<br/>Creator feedback"]
        AB["A/B Test Results"]
    end

    subgraph Store["Feedback Store"]
        DB[("Performance Database")]
    end

    subgraph Analysis["Analysis Engine"]
        Patterns["Pattern Detection:<br/>• What scenes perform?<br/>• Optimal segment length?<br/>• Best framing by content?"]
    end

    subgraph Models["Model Updates"]
        Story["Story Models<br/>Hook in first 3s"]
        Platform["Platform Models<br/>TikTok: 15-30s optimal"]
        Audience["Audience Models<br/>Gen Z: fast cuts"]
    end

    subgraph Output["Enhanced Generation"]
        StoryIQ["Story IQ Editor<br/>uses updated context"]
    end

    API --> DB
    Manual --> DB
    AB --> DB

    DB --> Patterns
    Patterns --> Story
    Patterns --> Platform
    Patterns --> Audience

    Story --> StoryIQ
    Platform --> StoryIQ
    Audience --> StoryIQ

    style API fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style Manual fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style AB fill:#4A90A4,stroke:#357082,color:#FFFFFF
    style DB fill:#D4A84B,stroke:#B48830,color:#000000
    style Patterns fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
    style Story fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
    style Platform fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
    style Audience fill:#4A7C59,stroke:#2A5C39,color:#FFFFFF
    style StoryIQ fill:#7B5EA7,stroke:#5D4580,color:#FFFFFF
```

**Vision**: The system learns what works. As creators export microdramas and track performance, the Story IQ Editor gets smarter about what segments to recommend, how to frame them, and what pacing works best for each platform and audience.

---

## Key Design Decisions Summary

| Area                      | Decision                                                        | Rationale                          |
| ------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| **Grounded Intelligence** | Two-stage pipeline: Video Intelligence → Narrative Intelligence | Prevents hallucinated timestamps   |
| **Long Videos**           | Transparent chunking with overlap                               | Handles any length, seamless API   |
| **Auto-Framing**          | Shot-hold: one crop per camera shot (SporeLabs)                 | Smooth, grounded, no model clocks  |
| **Rendering**             | Massively parallel Lambda                                       | Fast exports, scales automatically |
| **Preview**               | CSS-based framing                                               | Instant feedback, no re-encoding   |
| **Caption Timing**        | Adjusted for stitched output                                    | Captions stay synced after editing |

---

## How to Use These Diagrams

1. **Copy the Mermaid code blocks** from this document
2. **Paste into any of these free tools:**

   - [Mermaid Live Editor](https://mermaid.live/) — Best for editing and previewing
   - [Draw.io](https://draw.io/) — Import Mermaid, export to Google Drive
   - [Notion](https://notion.so/) — Paste in code block, select "Mermaid"
   - [GitHub](https://github.com/) — Renders in markdown files automatically

3. **For Google Slides or Docs:**
   - Use Mermaid Live Editor → Export as PNG or SVG
   - Insert image into Google Slides/Docs

---

_Document generated for ZeeVee architecture review._
