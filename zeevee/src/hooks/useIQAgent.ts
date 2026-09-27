/**
 * The client half of the agent contract: poll the event log from a cursor,
 * accumulate events, and expose the actions the panel needs.
 *
 * Everything the panel renders derives from the event log, so a refresh, a lost
 * connection, or a second tab all converge on the same view.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelAgentRun,
  fetchAgentEvents,
  sendAgentMessage,
} from "@/services/agentApi";
import type {
  AgentBrief,
  AgentCost,
  AgentEvent,
  AgentEventsResponse,
  AgentLedger,
  AgentRunState,
} from "@/services/agentTypes";
import type { Segment } from "@/store/editorSlice";

/** Poll cadences, in milliseconds. */
const POLL_ACTIVE = 1000;
const POLL_RECENT = 4000;
const POLL_IDLE = 20000;
const POLL_HIDDEN = 15000;
const POLL_ERROR_BASE = 2000;
const POLL_ERROR_MAX = 20000;

/** How long after the last activity we keep polling briskly. */
const RECENT_WINDOW_MS = 60_000;

/** Consecutive poll failures before we tell the user the connection is down. */
const OFFLINE_AFTER_FAILURES = 3;

export interface OpenQuestion {
  questionId: string;
  text: string;
  suggestions: string[];
}

export interface IQAgentState {
  events: AgentEvent[];
  run: AgentRunState | null;
  lastRun: AgentRunState | null;
  ledger: AgentLedger | null;
  cost: AgentCost | null;
  brief: AgentBrief | null;
  openQuestion: OpenQuestion | null;
  queuedMessages: number;
  framingActive: boolean;
  isRunning: boolean;
  loading: boolean;
  offline: boolean;
  sending: boolean;
  sendError: string | null;
  start: (brief: AgentBrief) => Promise<void>;
  send: (text: string, answerTo?: string) => Promise<void>;
  cancel: () => Promise<void>;
  dismissSendError: () => void;
}

function newKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(err: unknown): string {
  const axiosLike = err as {
    response?: { data?: { error?: string; detail?: string }; status?: number };
    message?: string;
  };
  const fromBody = axiosLike?.response?.data?.error;
  if (fromBody) return fromBody;
  if (axiosLike?.response?.status === 401) {
    return "Your session expired. Sign in again and retry.";
  }
  return axiosLike?.message ?? "Something went wrong.";
}

export function useIQAgent(
  projectId: string | undefined,
  onSegments: (segments: Segment[]) => void,
  onProjectTitle?: (title: string) => void,
): IQAgentState {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [snapshot, setSnapshot] = useState<AgentEventsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const cursorRef = useRef(0);
  const lastActivityRef = useRef(Date.now());
  const failuresRef = useRef(0);
  const wakeRef = useRef<(() => void) | null>(null);
  const pokedRef = useRef(false);
  const onSegmentsRef = useRef(onSegments);
  onSegmentsRef.current = onSegments;
  const onProjectTitleRef = useRef(onProjectTitle);
  onProjectTitleRef.current = onProjectTitle;

  const isRunning = snapshot?.run?.status === "running";

  /** Ask the polling loop to fetch immediately instead of waiting out its delay. */
  const poke = useCallback(() => {
    lastActivityRef.current = Date.now();
    // If a request is already in flight there is no timer to cut short, so
    // record the poke and let the loop skip its next wait instead of losing it.
    pokedRef.current = true;
    wakeRef.current?.();
  }, []);

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;
    cursorRef.current = 0;
    failuresRef.current = 0;
    pokedRef.current = false;
    setEvents([]);
    setSnapshot(null);
    setLoading(true);
    setOffline(false);

    const sleep = (ms: number) => {
      if (pokedRef.current) {
        pokedRef.current = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        wakeRef.current = () => {
          clearTimeout(timer);
          wakeRef.current = null;
          pokedRef.current = false;
          resolve();
        };
      });
    };

    const nextDelay = (running: boolean): number => {
      if (failuresRef.current > 0) {
        return Math.min(
          POLL_ERROR_BASE * 2 ** (failuresRef.current - 1),
          POLL_ERROR_MAX,
        );
      }
      if (typeof document !== "undefined" && document.hidden) {
        return running ? POLL_HIDDEN : POLL_IDLE;
      }
      if (running) return POLL_ACTIVE;
      return Date.now() - lastActivityRef.current < RECENT_WINDOW_MS
        ? POLL_RECENT
        : POLL_IDLE;
    };

    const onVisible = () => {
      if (!document.hidden) poke();
    };
    document.addEventListener("visibilitychange", onVisible);

    (async () => {
      let running = false;
      // Renames apply only once history is replayed: on load the project
      // already has its current name, and an old rename must not undo a newer one.
      let caughtUp = false;

      while (!cancelled) {
        try {
          const response = await fetchAgentEvents(projectId, cursorRef.current);
          if (cancelled) return;

          failuresRef.current = 0;
          setOffline(false);

          if (response.events.length > 0) {
            cursorRef.current = response.cursor;
            lastActivityRef.current = Date.now();
            setEvents((prev) => mergeEvents(prev, response.events));

            // Segment updates are applied from the event stream so the timeline
            // moves in step with the transcript the user is reading.
            for (const event of response.events) {
              if (event.type === "state.updated") {
                onSegmentsRef.current(event.segments);
              } else if (event.type === "project.renamed" && caughtUp) {
                onProjectTitleRef.current?.(event.title);
              }
            }
          }

          setSnapshot(response);
          setLoading(false);
          running = response.run?.status === "running";
          if (!response.hasMore) caughtUp = true;

          // A full page means there is more history behind it; keep pulling.
          // The length check keeps a stuck cursor from spinning the loop.
          if (response.hasMore && response.events.length > 0) continue;
        } catch (err) {
          if (cancelled) return;
          failuresRef.current += 1;
          if (failuresRef.current >= OFFLINE_AFTER_FAILURES) {
            setOffline(true);
            setLoading(false);
          }
          console.warn("[IQAgent] poll failed:", errorMessage(err));
        }

        await sleep(nextDelay(running));
      }
    })();

    return () => {
      cancelled = true;
      wakeRef.current?.();
      wakeRef.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId, poke]);

  const openQuestion = useMemo<OpenQuestion | null>(() => {
    const id = snapshot?.openQuestionId;
    if (!id) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === "question.asked" && event.questionId === id) {
        return {
          questionId: id,
          text: event.text,
          suggestions: event.suggestions ?? [],
        };
      }
    }
    return null;
  }, [events, snapshot?.openQuestionId]);

  const framingActive = useMemo(() => {
    if (snapshot?.framing?.status === "running") return true;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === "framing.completed") return false;
      if (event.type === "framing.started" || event.type === "framing.progress") {
        return true;
      }
    }
    return false;
  }, [events, snapshot?.framing?.status]);

  const post = useCallback(
    async (body: Parameters<typeof sendAgentMessage>[1]) => {
      if (!projectId) return;
      setSending(true);
      setSendError(null);
      try {
        // The idempotency key is fixed before the first attempt, so a retry
        // after a network blip cannot start a second run.
        await sendAgentMessage(projectId, body);
        poke();
      } catch (err) {
        setSendError(errorMessage(err));
      } finally {
        setSending(false);
      }
    },
    [projectId, poke],
  );

  const start = useCallback(
    async (brief: AgentBrief) => {
      await post({ brief, isBrief: true, text: "", idempotencyKey: newKey() });
    },
    [post],
  );

  const send = useCallback(
    async (text: string, answerTo?: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      await post({ text: trimmed, answerTo, idempotencyKey: newKey() });
    },
    [post],
  );

  const cancel = useCallback(async () => {
    if (!projectId) return;
    try {
      await cancelAgentRun(projectId);
      poke();
    } catch (err) {
      setSendError(errorMessage(err));
    }
  }, [projectId, poke]);

  return {
    events,
    run: snapshot?.run ?? null,
    lastRun: snapshot?.lastRun ?? null,
    ledger: snapshot?.ledger ?? null,
    cost: snapshot?.cost ?? null,
    brief: snapshot?.brief ?? null,
    openQuestion,
    queuedMessages: snapshot?.queuedMessages ?? 0,
    framingActive,
    isRunning: Boolean(isRunning),
    loading,
    offline,
    sending,
    sendError,
    start,
    send,
    cancel,
    dismissSendError: () => setSendError(null),
  };
}

/** Append by seq, tolerating duplicates from an overlapping cursor. */
function mergeEvents(prev: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  if (prev.length === 0) return incoming;
  const highest = prev[prev.length - 1].seq;
  const fresh = incoming.filter((e) => e.seq > highest);
  return fresh.length === incoming.length
    ? [...prev, ...incoming]
    : [...prev, ...fresh];
}
