import { JockeyAgentsClient } from "../../jockey-agents-api";
import type { NarrativeBrief } from "./types";

/**
 * Narrative brief via TwelveLabs Agents API (jockey1.0 + knowledge store).
 */
export async function preprocessNarrativeBriefFromAgents(opts: {
  agentsApiKey: string;
  twelveLabsAssetId: string;
  purpose: "compact_video" | "episode_recap";
  title: string;
  durationSec: number;
  targetRuntimeSec: number;
  userInstructions?: string;
  /** Reuse store from a prior eval step */
  knowledgeStoreId?: string;
}): Promise<{ brief: NarrativeBrief; storeId: string }> {
  const client = new JockeyAgentsClient({ apiKey: opts.agentsApiKey });

  let storeId = opts.knowledgeStoreId;
  if (!storeId) {
    const ctx = await client.ensureKnowledgeStoreForAsset(opts.twelveLabsAssetId);
    storeId = ctx.storeId;
  }

  console.log(`[Jockey/Agents] Generating narrative brief (store ${storeId})`);
  const brief = await client.generateNarrativeBrief({
    storeId,
    purpose: opts.purpose,
    title: opts.title,
    durationSec: opts.durationSec,
    targetRuntimeSec: opts.targetRuntimeSec,
    userInstructions: opts.userInstructions,
  });

  return { brief, storeId };
}
