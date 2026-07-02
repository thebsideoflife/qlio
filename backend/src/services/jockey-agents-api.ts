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

  async getAssetStatus(assetId: string): Promise<string> {
    const data = await this.request<{ status: string }>(
      "GET",
      `/assets/${assetId}`,
    );
    return data.status;
  }

  /** List all Agents API assets (paginated). */
  async listAssets(): Promise<
    Array<{ _id: string; filename?: string; status?: string }>
  > {
    const all: Array<{ _id: string; filename?: string; status?: string }> = [];
    let page = 1;
    while (true) {
      const data = await this.request<{
        data?: Array<{ _id: string; filename?: string; status?: string }>;
        page_info?: { total_page?: number };
      }>("GET", `/assets?page=${page}&page_limit=50`);
      all.push(...(data.data ?? []));
      const totalPage = data.page_info?.total_page ?? 1;
      if (page >= totalPage) break;
      page++;
    }
    return all;
  }

  async listKnowledgeStores(): Promise<
    Array<{ _id: string; name?: string; item_count?: number }>
  > {
    const all: Array<{ _id: string; name?: string; item_count?: number }> = [];
    let page = 1;
    while (true) {
      const data = await this.request<{
        data?: Array<{ _id: string; name?: string; item_count?: number }>;
        page_info?: { total_page?: number };
      }>("GET", `/knowledge-stores?page=${page}&page_size=50`);
      all.push(...(data.data ?? []));
      const totalPage = data.page_info?.total_page ?? 1;
      if (page >= totalPage) break;
      page++;
    }
    return all;
  }

  async findKnowledgeStoreByName(
    name: string,
  ): Promise<{ _id: string; name?: string } | undefined> {
    const stores = await this.listKnowledgeStores();
    return stores.find((s) => s.name === name);
  }

  async knowledgeStoreExists(storeId: string): Promise<boolean> {
    try {
      await this.request("GET", `/knowledge-stores/${storeId}`);
      return true;
    } catch {
      return false;
    }
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
   * Start Agents asset ingest from URL — returns immediately; TwelveLabs fetches from S3.
   */
  async beginUploadFromUrl(videoUrl: string): Promise<string> {
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
    console.log(`[Agents] Started ingest for asset ${data._id}`);
    return data._id;
  }

  /**
   * Upload video to Agents API from a public/presigned URL.
   * Required when the Jockey API key cannot read org-indexed asset ids.
   */
  async uploadAssetFromUrl(
    videoUrl: string,
    maxWaitMs = 3_600_000,
  ): Promise<string> {
    const assetId = await this.beginUploadFromUrl(videoUrl);
    console.log(`[Agents] Waiting for asset ${assetId} to be ready...`);
    await this.waitForAssetReady(assetId, maxWaitMs);
    return assetId;
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

  async beginKnowledgeStoreForAsset(
    twelveLabsAssetId: string,
    opts?: {
      storeName?: string;
      ingestionDescription?: string;
    },
  ): Promise<KnowledgeStoreContext> {
    const storeName =
      opts?.storeName ??
      `qlio-eval-${twelveLabsAssetId.slice(0, 8)}-${Date.now()}`;
    const ingestionDescription =
      opts?.ingestionDescription ??
      "Extract narrative arcs, character names, dialog-forward moments, and story beats with timestamps.";

    let storeId: string;
    const existing = await this.findKnowledgeStoreByName(storeName);
    if (existing) {
      storeId = existing._id;
      console.log(`[Agents] Reusing knowledge store ${storeId} (${storeName})`);
    } else {
      storeId = await this.createKnowledgeStore(storeName, ingestionDescription);
      console.log(`[Agents] Created knowledge store ${storeId}`);
    }

    const itemId = await this.addAssetToStore(storeId, twelveLabsAssetId);
    console.log(`[Agents] Queued asset ${twelveLabsAssetId} as item ${itemId}`);
    return { storeId, itemId, assetId: twelveLabsAssetId };
  }

  async ensureKnowledgeStoreForAsset(
    twelveLabsAssetId: string,
    opts?: {
      storeName?: string;
      ingestionDescription?: string;
      maxWaitMs?: number;
    },
  ): Promise<KnowledgeStoreContext> {
    const ctx = await this.beginKnowledgeStoreForAsset(twelveLabsAssetId, opts);
    await this.waitForItemReady(ctx.storeId, ctx.itemId, opts?.maxWaitMs);
    console.log(`[Agents] Item ${ctx.itemId} ready`);
    return ctx;
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
