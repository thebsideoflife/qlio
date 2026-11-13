# ZeeVee Cost Estimate: 1-Hour Microdrama Output

> **Status (Nov 2026):** Historical (Feb 2026). It predates Whisper transcription, SporeLabs and the IQ Agent, so treat the per-video figures as rough.

**Workflow:** Compact Video (50% condensation)  
**Source:** 2-hour video → 1 hour of microdrama output  
**Date:** February 2026

---

## Key Takeaways

| Metric                                          | Cost       |
| ----------------------------------------------- | ---------- |
| **First microdrama from a source video**        | **$10.93** |
| **Each additional microdrama from same source** | **~$2.99** |

The first microdrama includes one-time video indexing costs. Subsequent microdramas from the same source video cost ~73% less since the video only needs to be indexed once.

---

## Executive Summary

| Component                       | First Video | Additional Videos |
| ------------------------------- | ----------- | ----------------- |
| 12Labs (Video Understanding)    | $9.00       | $1.26             |
| Anthropic Claude (AI Reasoning) | $0.35       | $0.35             |
| AWS (Storage & Compute)         | $0.68       | $0.48             |
| Remotion (Video Rendering)      | $0.90       | $0.90             |
| **Total**                       | **$10.93**  | **~$2.99**        |

---

## What Each Step Does

1. **Video Indexing** – AI analyzes the entire video for understanding (one-time)
2. **Scene Detection** – Identifies visual scene changes and transitions (one-time, cached)
3. **Segment Selection** – AI selects the best moments based on narrative value
4. **Framing Analysis** – Determines how to crop each segment for vertical viewing
5. **Rendering** – Produces the finished microdrama with captions

---

## Detailed Cost Breakdown

### 1. TwelveLabs (Video Understanding)

**Pricing Source:** [twelvelabs.io/pricing](https://twelvelabs.io/pricing)

| Operation                          | Rate        | Quantity | First Video | Additional |
| ---------------------------------- | ----------- | -------- | ----------- | ---------- |
| Video Indexing (Pegasus)           | $0.042/min  | 120 min  | $5.04       | $0         |
| Scene Detection (Pegasus Analyze)  | $0.021/min  | 120 min  | $2.52       | $0         |
| Framing Analysis (Pegasus Analyze) | $0.021/min  | 60 min   | $1.26       | $1.26      |
| Infrastructure Fee                 | $0.0015/min | 120 min  | $0.18       | $0         |
| **Subtotal**                       |             |          | **$9.00**   | **$1.26**  |

**Notes:**

- ZeeVee uses Pegasus (video-to-text generation), not Marengo (search/embeddings)
- Indexing and scene detection are one-time per source video (results are cached)
- Framing analysis runs for each new set of output segments

---

### 2. Anthropic Claude (AI Reasoning)

**Pricing Source:** [anthropic.com](https://www.anthropic.com/claude/sonnet)

| Operation                                      | Input Tokens | Output Tokens | Cost      |
| ---------------------------------------------- | ------------ | ------------- | --------- |
| Planning (analyze transcript, select segments) | ~25,000      | ~3,000        | $0.12     |
| Review (verify segment quality)                | ~15,000      | ~1,000        | $0.06     |
| Revision (adjust if needed)                    | ~20,000      | ~3,000        | $0.11     |
| **Subtotal**                                   | ~60,000      | ~7,000        | **$0.35** |

**Token Rates (Claude Sonnet 4.5):**

- Input: $3.00 per 1M tokens
- Output: $15.00 per 1M tokens

This cost applies to each microdrama generated.

---

### 3. AWS (Storage & Compute)

**Pricing Source:** [aws.amazon.com](https://aws.amazon.com/pricing/)

| Operation                   | Rate          | Quantity | First Video | Additional |
| --------------------------- | ------------- | -------- | ----------- | ---------- |
| Source video storage        | $0.023/GB     | 8 GB     | $0.18       | $0         |
| Output video storage        | $0.023/GB     | 4 GB     | $0.09       | $0.09      |
| Download bandwidth          | $0.09/GB      | 4 GB     | $0.36       | $0.36      |
| Lambda compute (processing) | ~$0.00002/sec | Various  | $0.05       | $0.03      |
| **Subtotal**                |               |          | **$0.68**   | **$0.48**  |

**Note:** Lambda compute for additional videos is slightly lower (no video splitting), but still includes segment generation, framing analysis, and render orchestration.

---

### 4. Remotion (Video Rendering)

**Pricing Source:** [remotion.dev/docs/lambda/cost-example](https://remotion.dev/docs/lambda/cost-example)

| Parameter       | Value                 |
| --------------- | --------------------- |
| Output duration | 60 minutes            |
| Resolution      | 1080p vertical (9:16) |
| Estimated rate  | $0.015/min            |
| **Subtotal**    | **$0.90**             |

This cost applies to each microdrama generated.

---

## Cost Breakdown by Category

| Service   | First Video | Share |
| --------- | ----------- | ----- |
| 12Labs    | $9.00       | 82%   |
| Remotion  | $0.90       | 8%    |
| AWS       | $0.68       | 6%    |
| Claude    | $0.35       | 3%    |
| **Total** | **$10.93**  | 100%  |

---

## Volume Estimates

| Scenario                            | Cost                          |
| ----------------------------------- | ----------------------------- |
| 1 microdrama (first from source)    | $10.93                        |
| 2 microdramas from same source      | $10.93 + $2.99 = $13.92       |
| 5 microdramas from same source      | $10.93 + (4 × $2.99) = $22.89 |
| 10 different source videos (1 each) | 10 × $10.93 = $109.30         |

**Note:** Volume discounts from 12Labs are available for high-volume contracts.

---

## Assumptions

- **Source video:** 2 hours of HD content (~8 GB)
- **Output:** 1 hour of condensed microdrama (50% of source)
- **Segments:** ~40 segments averaging 90 seconds each
- **Format:** Vertical video (9:16) with captions at 1080p

---

_Estimate prepared February 2026. Prices subject to change based on vendor pricing updates._
