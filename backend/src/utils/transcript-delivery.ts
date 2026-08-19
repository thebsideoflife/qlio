import { presignS3UriList } from "./s3";
import {
  resolveOriginalTranscriptCandidates,
  type TranscriptSourceParams,
} from "./transcript-source";

export type DeliveredOriginalTranscript = {
  transcriptionUrl: string | null;
  transcriptionCandidates: string[];
};

/** Convert the canonical original-source policy into browser-readable URLs. */
export async function deliverOriginalTranscript(
  params: TranscriptSourceParams,
): Promise<DeliveredOriginalTranscript> {
  const transcriptionCandidates = await presignS3UriList(
    resolveOriginalTranscriptCandidates(params),
  );
  return {
    transcriptionUrl: transcriptionCandidates[0] ?? null,
    transcriptionCandidates,
  };
}
