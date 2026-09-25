/**
 * IQ Agent tuning constants.
 *
 * These are anti-footgun rails, not budgets. The only hard limits here are the
 * ones the vendor APIs actually impose (Pegasus 4s minimum clip, Marengo 50
 * results per page). Everything else is generous enough that a thorough run
 * never hits it, and produces a warning rather than a refusal when it does.
 */

/** TwelveLabs rejects analysis windows shorter than this. */
export const MIN_CLIP_SEC = 4;

/** Windows longer than this get a "this will be slow" warning, not a refusal. */
export const CLIP_WINDOW_WARN_SEC = 600;

/** Refuse only at the point where the request is obviously a mistake. */
export const MAX_CLIP_WINDOW_SEC = 3600;

export const WATCH_CLIP_TIMEOUT_MS = 240_000;
export const WATCH_CLIP_MAX_ATTEMPTS = 3;

/** A prior watch covering this fraction of the request counts as a repeat. */
export const WATCH_REPEAT_OVERLAP = 0.9;

/** Marengo hard limit. */
export const SEARCH_MAX_LIMIT = 50;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_TIMEOUT_MS = 60_000;

export const FRAMES_PER_CALL = 8;
export const FRAME_MAX_EDGE_PX = 768;
export const FRAME_TIMEOUT_MS = 60_000;

/** Transcript reads truncate by size, not by clock time. */
export const TRANSCRIPT_MAX_CHARS = 60_000;

/** Tool-use iterations per run before the agent is asked to wrap up. */
export const MAX_ITERATIONS = 60;
export const ITERATIONS_WARNING_AT = 10;

/** Clarifying questions per run, so the agent cannot stall on interrogation. */
export const MAX_ASKS_PER_RUN = 3;

/**
 * Coverage gate. An unexamined, uncut stretch longer than the floor blocks
 * finish_turn. Clearing it is cheap — one wide read_transcript covers most
 * sources — so the floor can be tight where a transcript exists.
 */
export const BLIND_SPOT_FLOOR_SEC = 120;
export const BLIND_SPOT_FLOOR_LONG_SEC = 300;
export const BLIND_SPOT_LONG_FRACTION = 0.02;
/**
 * No transcript means every look costs Pegasus minutes rather than a free read,
 * so the floor is both much higher and scaled by length — a three-hour source
 * with no dialogue track cannot be swept at the same resolution as a
 * forty-minute one inside a single run's step budget.
 */
export const BLIND_SPOT_FLOOR_UNAIDED_SEC = 600;
export const BLIND_SPOT_UNAIDED_FRACTION = 0.08;
/**
 * Escape hatch. The gate is otherwise unconditional, but a run that cannot
 * satisfy it must still end rather than burn every remaining step arguing.
 */
export const MAX_BLIND_SPOT_REFUSALS = 3;

/**
 * Search circuit breaker. A query is unproductive when almost every window it
 * returns was already returned by an earlier query — the sign of rephrasing in
 * circles rather than of searching somewhere new.
 */
export const SEARCH_UNPRODUCTIVE_WARN_AT = 3;
export const SEARCH_UNPRODUCTIVE_STOP_AT = 5;
/** Two hits this close together are the same moment found twice. */
export const SEARCH_HIT_SAME_WINDOW_SEC = 5;
/** Below this share of previously unseen hits, a query told us nothing new. */
export const SEARCH_NOVELTY_FLOOR = 0.2;

/** How much of the timeline one viewed frame is credited with showing. */
export const FRAME_EXAMINE_PAD_SEC = 5;

/** Verbatim turns kept in context before older ones are compacted. */
export const TURN_WINDOW = 8;

/** Compaction escalates once the assembled context passes this estimate. */
export const CONTEXT_SOFT_TOKEN_CAP = 120_000;

export const MAX_OUTPUT_TOKENS = 8192;
export const MODEL_TEMPERATURE = 0.4;

export const MODEL_TIMEOUT_MS = 300_000;
export const MODEL_MAX_ATTEMPTS = 4;

/** Worker writes a heartbeat this often; a run silent for DEAD_RUN_MS is reaped. */
export const HEARTBEAT_MS = 20_000;
export const DEAD_RUN_MS = 90_000;

/** Persist and self-invoke a continuation when less than this remains. */
export const CONTINUATION_RESERVE_MS = 150_000;

/**
 * Wrapping up costs more than another loop iteration: delivery metadata is
 * several model calls plus one FFmpeg frame extract per segment. When finish
 * lands with less than this on the clock, the whole wrap-up moves to a fresh
 * invocation rather than being started on time it cannot finish in.
 */
export const FINALIZE_RESERVE_MS = 300_000;

/** Thread rows expire after 90 days; event rows after 30. */
export const THREAD_TTL_DAYS = 90;
export const EVENT_TTL_DAYS = 30;

/** Events returned per page from the read endpoint. */
export const EVENTS_PAGE_LIMIT = 200;

/** How long the poll endpoint mirrors an auto-framing job before giving up. */
export const FRAMING_MIRROR_MAX_MS = 20 * 60 * 1000;
