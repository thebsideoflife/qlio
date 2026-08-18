export type TranscriptionRunState = {
  pendingTranscriptionVersion?: unknown;
  transcriptionStatus?: unknown;
  transcriptionVersion?: unknown;
  transcriptionUrl?: unknown;
};

export type TranscriptionRunDisposition =
  | "current"
  | "committed"
  | "superseded";

/**
 * Duplicate async Lambda deliveries can observe the same run after another
 * invocation has committed it. That is success, not supersession.
 */
export function classifyTranscriptionRun(
  state: TranscriptionRunState,
  transcriptionVersion: string,
): TranscriptionRunDisposition {
  if (
    state.pendingTranscriptionVersion === transcriptionVersion &&
    state.transcriptionStatus === "pending"
  ) {
    return "current";
  }
  if (
    state.transcriptionVersion === transcriptionVersion &&
    state.transcriptionStatus === "ready"
  ) {
    return "committed";
  }
  return "superseded";
}
