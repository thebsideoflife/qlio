/**
 * TwelveLabs Agents API (v1.3) client for jockey1.0 Responses.
 * @see Jockey-docs.md Quickstart
 */

import type { NarrativeBrief } from "./storyiq/jockey/types";
import { NarrativeBriefSchema } from "./storyiq/jockey/types";

const DEFAULT_BASE_URL = "https://api.twelvelabs.io/v1.3";

export interface JockeyAgentsClientOptions {
  apiKey: string;
  baseUrl?: string;
  pollIntervalMs?: number;
}

export interface KnowledgeStoreContext {
  storeId: string;
  itemId: string;
  assetId: string;
}

interface AgentsResponseBody {
  id?: string;
  status?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { message?: string };
}

const NARRATIVE_BRIEF_JSON_SCHEMA = {
  type: "object",
  properties: {
    logline: { type: "string" },
    arcs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          beats: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                approximateStartSec: { type: "number" },
                approximateEndSec: { type: "number" },
                narrativeRole: {
                  type: "string",
                  enum: [
                    "setup",
                    "escalation",
                    "pivot",
                    "payoff",
                    "main_story",
                    "secondary_story",
                  ],
                },
                characters: { type: "array", items: { type: "string" } },
                dialogForward: { type: "boolean" },
                producerTheme: { type: "string" },
              },
              required: [
                "id",
                "label",
                "approximateStartSec",
                "approximateEndSec",
                "narrativeRole",
                "characters",
                "dialogForward",
              ],
            },
          },
        },
        required: ["name", "beats"],
      },
    },
    recapBeats: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          approximateStartSec: { type: "number" },
          approximateEndSec: { type: "number" },
          narrativeRole: { type: "string" },
          characters: { type: "array", items: { type: "string" } },
          dialogForward: { type: "boolean" },
        },
      },
    },
    producerNotes: { type: "string" },
    targetRuntimeSec: { type: "number" },
  },
  required: ["logline", "arcs", "producerNotes", "targetRuntimeSec"],
};

const SEGMENTS_JSON_SCHEMA = {
  type: "object",
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          startTime: { type: "number" },
          endTime: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          keep: { type: "boolean" },
          narrativeRole: { type: "string" },
        },
        required: ["startTime", "endTime", "title", "description", "keep"],
      },
    },
    logline: { type: "string" },
  },
  required: ["segments"],
};

export class JockeyAgentsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;

  constructor(options: JockeyAgentsClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { "x-api-key": this.apiKey };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `[Agents] ${method} ${path} → ${res.status}: non-JSON body`,
      );
    }

    if (!res.ok) {
      throw new Error(
        `[Agents] ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`,
      );
    }

    return data as T;
  }

  /** Smoke test — list knowledge stores or create a minimal store probe. */
  async ping(): Promise<{ ok: boolean; storeCount?: number }> {
    const data = await this.request<{ data?: unknown[] }>(
      "GET",
      "/knowledge-stores?page=1&page_size=1",
    );
    return { ok: true, storeCount: data.data?.length ?? 0 };
  }

  async getAssetStatus(assetId: string): Promise<string> {
    const data = await this.request<{ status: string }>(
      "GET",
      `/assets/${assetId}`,
    );
    return data.status;
  }

  async waitForAssetReady(assetId: string, maxWaitMs = 3_600_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const status = await this.getAssetStatus(assetId);
      if (status === "ready") return;
      if (status === "failed") {
        throw new Error(`[Agents] Asset ${assetId} processing failed`);
      }
      console.log(`[Agents] Asset ${assetId} status: ${status}, waiting...`);
      await sleep(this.pollIntervalMs);
    }
    throw new Error(`[Agents] Asset ${assetId} not ready after ${maxWaitMs}ms`);
  }

  /**
   * Upload video to Agents API from a public/presigned URL.
   * Required when the Jockey API key cannot read org-indexed asset ids.
   */
  async uploadAssetFromUrl(
    videoUrl: string,
    maxWaitMs = 3_600_000,
  ): Promise<string> {
    const form = new FormData();
    form.append("method", "url");
    form.append("url", videoUrl);

    const res = await fetch(`${this.baseUrl}/assets`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`[Agents] POST /assets → ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = JSON.parse(text) as { _id: string };
    console.log(`[Agents] Uploaded asset ${data._id}, waiting for ready...`);
    await this.waitForAssetReady(data._id, maxWaitMs);
    return data._id;
  }

  async createKnowledgeStore(name: string, ingestionDescription?: string): Promise<string> {
    const payload: Record<string, unknown> = { name };
    if (ingestionDescription) {
      payload.ingestion_config = {
        enrichment_config: {
          type: "description",
          description: ingestionDescription,
        },
      };
    }

    const data = await this.request<{ _id: string }>("POST", "/knowledge-stores", payload);
    return data._id;
  }

  async addAssetToStore(storeId: string, assetId: string): Promise<string> {
    const data = await this.request<{ _id: string }>(
      "POST",
      `/knowledge-stores/${storeId}/items`,
      { asset_id: assetId },
    );
    return data._id;
  }

  async getItemStatus(
    storeId: string,
    itemId: string,
  ): Promise<string> {
    const data = await this.request<{ status: string }>(
      "GET",
      `/knowledge-stores/${storeId}/items/${itemId}`,
    );
    return data.status;
  }

  async waitForItemReady(
    storeId: string,
    itemId: string,
    maxWaitMs = 3_600_000,
  ): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const status = await this.getItemStatus(storeId, itemId);
      if (status === "ready") return;
      if (status === "failed") {
        throw new Error(`[Agents] Knowledge store item ${itemId} failed indexing`);
      }
      console.log(`[Agents] Item ${itemId} status: ${status}, waiting...`);
      await sleep(this.pollIntervalMs);
    }
    throw new Error(`[Agents] Item ${itemId} not ready after ${maxWaitMs}ms`);
  }

  async ensureKnowledgeStoreForAsset(
    twelveLabsAssetId: string,
    opts?: {
      storeName?: string;
      ingestionDescription?: string;
      maxWaitMs?: number;
    },
  ): Promise<KnowledgeStoreContext> {
    const storeName =
      opts?.storeName ??
      `qlio-eval-${twelveLabsAssetId.slice(0, 8)}-${Date.now()}`;
    const storeId = await this.createKnowledgeStore(
      storeName,
      opts?.ingestionDescription ??
        "Extract narrative arcs, character names, dialog-forward moments, and story beats with timestamps.",
    );
    console.log(`[Agents] Created knowledge store ${storeId}`);
    const itemId = await this.addAssetToStore(storeId, twelveLabsAssetId);
    console.log(`[Agents] Added asset ${twelveLabsAssetId} as item ${itemId}`);
    await this.waitForItemReady(storeId, itemId, opts?.maxWaitMs);
    console.log(`[Agents] Item ${itemId} ready`);
    return { storeId, itemId, assetId: twelveLabsAssetId };
  }

  async createStructuredResponse<T>(opts: {
    storeId: string;
    prompt: string;
    instructions?: string;
    schemaName: string;
    schema: Record<string, unknown>;
    sessionId?: string;
  }): Promise<T> {
    const body: Record<string, unknown> = {
      model: "jockey1.0",
      input: [{ type: "message", role: "user", content: opts.prompt }],
      knowledge_store_id: opts.storeId,
      text: {
        format: {
          type: "json_schema",
          name: opts.schemaName,
          schema: opts.schema,
        },
      },
    };
    if (opts.instructions) body.instructions = opts.instructions;
    if (opts.sessionId) body.session_id = opts.sessionId;

    const result = await this.request<AgentsResponseBody>("POST", "/responses", body);

    if (result.status === "failed") {
      throw new Error(
        `[Agents] Response failed: ${result.error?.message ?? "unknown"}`,
      );
    }

    const text = extractResponseText(result);
    if (!text) {
      throw new Error("[Agents] Empty response text");
    }

    return JSON.parse(text) as T;
  }

  async generateNarrativeBrief(opts: {
    storeId: string;
    purpose: "compact_video" | "episode_recap";
    title: string;
    durationSec: number;
    targetRuntimeSec: number;
    userInstructions?: string;
  }): Promise<NarrativeBrief> {
    const purposeBlock =
      opts.purpose === "episode_recap"
        ? "Produce exactly 4–6 ordered recap beats in recapBeats for a 'Previously on…' tone."
        : "Name narrative arcs when the producer names themes. Prefer dialog-forward beats.";

    const prompt = [
      `Video: "${opts.title}"`,
      `Duration: ${Math.round(opts.durationSec)}s`,
      `Purpose: ${opts.purpose}`,
      `Target runtime: ~${Math.round(opts.targetRuntimeSec)}s`,
      opts.userInstructions
        ? `Producer instructions: ${opts.userInstructions}`
        : "",
      purposeBlock,
      "Use only timestamps you can infer from indexed video content. Beats must span the full timeline for long-form content.",
    ]
      .filter(Boolean)
      .join("\n");

    const instructions =
      "You are a narrative editor for video compaction. Return structured story beats with approximate timestamps in seconds.";

    const raw = await this.createStructuredResponse<unknown>({
      storeId: opts.storeId,
      prompt,
      instructions,
      schemaName: "narrative_brief",
      schema: NARRATIVE_BRIEF_JSON_SCHEMA,
    });

    return NarrativeBriefSchema.parse(raw);
  }

  async generateSegmentsDirect(opts: {
    storeId: string;
    purpose: "compact_video" | "episode_recap";
    title: string;
    durationSec: number;
    targetRuntimeSec: number;
    userInstructions?: string;
  }): Promise<{
    segments: Array<{
      startTime: number;
      endTime: number;
      title: string;
      description: string;
      keep: boolean;
      narrativeRole?: string;
    }>;
    logline?: string;
  }> {
    const recapRules =
      opts.purpose === "episode_recap"
        ? "Return 4–6 kept segments totaling ~60–90s."
        : `Return kept segments totaling ~${Math.round(opts.targetRuntimeSec)}s from ${Math.round(opts.durationSec)}s source.`;

    const prompt = [
      `Select editorial segments for "${opts.title}" (${Math.round(opts.durationSec)}s).`,
      `Purpose: ${opts.purpose}.`,
      recapRules,
      "Distribute selections across the FULL timeline — include early, middle, and late story.",
      opts.userInstructions ? `Producer: ${opts.userInstructions}` : "",
      "Set keep=true only for segments that belong in the final cut.",
    ]
      .filter(Boolean)
      .join("\n");

    return this.createStructuredResponse({
      storeId: opts.storeId,
      prompt,
      instructions:
        "You are a video editor selecting timestamped segments. Return precise start/end times in seconds on the source video timeline.",
      schemaName: "segment_selection",
      schema: SEGMENTS_JSON_SCHEMA,
    });
  }
}

function extractResponseText(result: AgentsResponseBody): string | undefined {
  for (const output of result.output ?? []) {
    if (output.type !== "message") continue;
    for (const content of output.content ?? []) {
      if (content.text) return content.text;
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
