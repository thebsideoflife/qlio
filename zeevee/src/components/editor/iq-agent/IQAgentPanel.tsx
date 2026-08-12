/**
 * The IQ Editor panel: a conversation with the agent that is cutting the video.
 *
 * Layout, top to bottom — inputs, the thread, then the composer.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircle,
  ArrowUp,
  CircleSlash,
  Loader2,
  RotateCw,
  Sparkles,
  Wand2,
  WifiOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentThread } from "./AgentThread";
import { BriefControls } from "./BriefControls";
import { PromptsEditor } from "./PromptsEditor";
import { STAGE_LABELS, type AgentBrief } from "@/services/agentTypes";
import type { IQAgentState } from "@/hooks/useIQAgent";
import {
  setGenerationMetadata,
  updateGenerationMetadata,
  type GenerationMetadata,
} from "@/store/editorSlice";

const RETRY_MESSAGE =
  "Pick up where you left off and keep going with what you already have.";

function briefToMetadata(brief: AgentBrief): GenerationMetadata {
  return {
    userPrompt: brief.userPrompt ?? null,
    purpose: brief.format ?? null,
    format: brief.format ?? null,
    assetType: brief.assetType ?? null,
    platform: brief.platform ?? null,
    minSegmentDuration: brief.minSegmentDuration ?? null,
    maxSegmentDuration: brief.maxSegmentDuration ?? null,
    targetPercent: brief.targetPercent ?? null,
  };
}

export interface IQAgentPanelProps {
  projectId: string;
  agent: IQAgentState;
  savedInputs?: GenerationMetadata | null;
  autoFrameEnabled: boolean;
  onAutoFrameChange: (enabled: boolean) => void;
  targetAspectRatio: string;
  onPlatformChange?: (platform: string) => void;
}

export function IQAgentPanel({
  projectId,
  agent,
  savedInputs,
  autoFrameEnabled,
  onAutoFrameChange,
  targetAspectRatio,
  onPlatformChange,
}: IQAgentPanelProps) {
  const dispatch = useDispatch();
  const [inputs, setInputs] = useState<AgentBrief | null>(null);
  const [draft, setDraft] = useState("");
  // Skip hydrate publish so opening a project does not mark the editor dirty.
  const persistReadyRef = useRef(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  const hasThread = agent.events.length > 0;
  const busy = agent.isRunning || agent.sending;
  // A run that died on something transient is worth one button, not a retype.
  const retryable =
    !agent.isRunning &&
    agent.lastRun?.status === "failed" &&
    agent.lastRun.error?.code !== "asset_not_ready";

  // Follow the tail unless the producer has scrolled up to read something.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedToBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [agent.events.length, agent.isRunning]);

  // Legacy thread.brief migration lands on the events poll. Absorb into Redux
  // without marking dirty so stub-only project.metadata can pick up a real format.
  useEffect(() => {
    if (!agent.brief?.format) return;
    if (savedInputs?.format || savedInputs?.purpose) return;
    dispatch(
      setGenerationMetadata({
        ...(savedInputs ?? {}),
        ...briefToMetadata(agent.brief),
      }),
    );
  }, [agent.brief, savedInputs, dispatch]);

  // Panel inputs ride the existing 10s project sync (same as framing/captions).
  // Only depend on `inputs` — do not re-fire when a run starts/stops.
  useEffect(() => {
    if (!inputs) return;
    if (!persistReadyRef.current) {
      persistReadyRef.current = true;
      return;
    }
    dispatch(updateGenerationMetadata(briefToMetadata(inputs)));
  }, [inputs, dispatch]);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const distanceFromBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < 80;
  };

  const startRun = () => {
    if (!inputs) return;
    pinnedToBottomRef.current = true;
    dispatch(updateGenerationMetadata(briefToMetadata(inputs)));
    void agent.start({
      ...inputs,
      autoFrame: autoFrameEnabled,
      targetAspectRatio,
    });
  };

  const submitDraft = (text: string, answerTo?: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    pinnedToBottomRef.current = true;
    setDraft("");
    void agent.send(trimmed, answerTo);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-background">
      <Header
        agent={agent}
        projectId={projectId}
        promptsDisabled={agent.isRunning}
      />

      {agent.offline && (
        <Banner tone="warn" icon={WifiOff}>
          Lost contact with the agent service. Still retrying — the run keeps going
          on the server, and the transcript will catch up.
        </Banner>
      )}

      {agent.sendError && (
        <Banner tone="error" icon={AlertCircle} onDismiss={agent.dismissSendError}>
          {agent.sendError}
        </Banner>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto"
      >
        <div className="p-4 space-y-4">
          {/* --- Inputs --------------------------------------------------- */}
          <div className="space-y-5">
            {!hasThread && (
              <p className="text-sm text-muted-foreground leading-relaxed">
                Set the shape of the cut, then start. You can talk to the editor
                at any point — while it's working or after it's done.
              </p>
            )}
            <BriefControls
              disabled={agent.isRunning}
              savedInputs={savedInputs}
              onPlatformChange={onPlatformChange}
              onChange={setInputs}
            />
            <div className="flex items-center justify-between">
              <Label
                htmlFor="agent-auto-frame"
                className="text-xs font-semibold text-muted-foreground cursor-pointer"
              >
                Auto-frame when the cut changes
              </Label>
              <Switch
                id="agent-auto-frame"
                checked={autoFrameEnabled}
                onCheckedChange={onAutoFrameChange}
                disabled={agent.isRunning}
              />
            </div>
          </div>

          {/* --- The thread ----------------------------------------------- */}
          {agent.loading && !hasThread ? (
            <div className="space-y-2 pt-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : (
            hasThread && <AgentThread events={agent.events} />
          )}

          {agent.isRunning && <ThinkingIndicator stage={agent.run?.stage} />}

          {agent.queuedMessages > 0 && (
            <p className="text-xs text-muted-foreground">
              {agent.queuedMessages === 1
                ? "Your message is queued — it goes in as soon as the editor finishes this step."
                : `${agent.queuedMessages} messages queued.`}
            </p>
          )}
        </div>
      </div>

      {/* --- Composer ---------------------------------------------------- */}
      <div className="shrink-0 border-t bg-muted/30">
        {agent.openQuestion && agent.openQuestion.suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {agent.openQuestion.suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                disabled={busy}
                onClick={() =>
                  submitDraft(suggestion, agent.openQuestion?.questionId)
                }
                className="rounded-full border-2 border-blue-500/30 bg-blue-500/5 px-3 py-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-500/15 disabled:opacity-50"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {!hasThread ? (
          <div className="p-4">
            <Button
              onClick={startRun}
              disabled={!inputs || busy}
              className="w-full h-11 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg font-semibold text-sm"
            >
              {busy ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4 mr-2" />
              )}
              Start cutting
            </Button>
          </div>
        ) : (
          <div className="p-3">
            <div className="rounded-lg border-2 border-border bg-card focus-within:border-blue-400/70 transition-colors">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value.slice(0, 8000))}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitDraft(draft, agent.openQuestion?.questionId);
                  }
                }}
                rows={2}
                placeholder={
                  agent.openQuestion
                    ? "Answer the editor…"
                    : agent.isRunning
                      ? "Send a note — it goes in at the next turn…"
                      : "Ask for a change, or answer a question…"
                }
                className="w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm focus:outline-none placeholder:text-muted-foreground/50"
              />

              <div className="flex items-center gap-1 px-2 pb-2">
                {agent.isRunning ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                    disabled={agent.run?.cancelRequested}
                    onClick={() => void agent.cancel()}
                  >
                    <CircleSlash className="h-3.5 w-3.5 mr-1.5" />
                    {agent.run?.cancelRequested ? "Stopping…" : "Stop"}
                  </Button>
                ) : (
                  <div className="flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                      disabled={!inputs || busy}
                      onClick={startRun}
                      title="Send the inputs again as a fresh instruction"
                    >
                      <Sparkles className="h-3 w-3 mr-1.5" />
                      Apply inputs
                    </Button>
                    {retryable && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                        disabled={busy}
                        onClick={() => submitDraft(RETRY_MESSAGE)}
                      >
                        <RotateCw className="h-3 w-3 mr-1.5" />
                        Retry
                      </Button>
                    )}
                  </div>
                )}

                <div className="flex-1" />

                <Button
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  disabled={!draft.trim() || agent.sending}
                  onClick={() =>
                    submitDraft(draft, agent.openQuestion?.questionId)
                  }
                >
                  {agent.sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowUp className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Header({
  agent,
  projectId,
  promptsDisabled,
}: {
  agent: IQAgentState;
  projectId: string;
  promptsDisabled: boolean;
}) {
  const stage = agent.run?.stage;
  const status = agent.run?.status ?? agent.lastRun?.status;

  const pill = agent.isRunning
    ? { label: stage ? STAGE_LABELS[stage] : "Working", tone: "active" as const }
    : agent.framingActive
      ? { label: "Framing", tone: "active" as const }
      : agent.openQuestion
        ? { label: "Needs your call", tone: "attention" as const }
        : status === "failed"
          ? { label: "Stopped", tone: "error" as const }
          : status === "completed"
            ? { label: "Ready", tone: "idle" as const }
            : null;

  return (
    <div className="border-b bg-muted/50 shrink-0">
      <div className="flex items-center gap-2 px-4 py-3 min-w-0">
        <div className="p-1.5 rounded-md bg-blue-500/10 shrink-0">
          <Wand2 className="h-4 w-4 text-blue-500" />
        </div>
        <span className="font-semibold shrink-0">IQ Editor</span>
        <div className="ml-auto flex items-center gap-2 min-w-0">
          {pill && (
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider min-w-0 max-w-[10rem]",
                pill.tone === "active" && "bg-blue-500/15 text-blue-500",
                pill.tone === "attention" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                pill.tone === "error" && "bg-destructive/15 text-destructive",
                pill.tone === "idle" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
              )}
              title={pill.label}
            >
              {pill.tone === "active" && (
                <Loader2 className="h-2.5 w-2.5 animate-spin shrink-0" />
              )}
              <span className="truncate">{pill.label}</span>
            </span>
          )}
          <PromptsEditor projectId={projectId} disabled={promptsDisabled} />
        </div>
      </div>
    </div>
  );
}

function ThinkingIndicator({ stage }: { stage?: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
      <span>
        {stage && stage in STAGE_LABELS
          ? STAGE_LABELS[stage as keyof typeof STAGE_LABELS]
          : "Working"}
        …
      </span>
    </div>
  );
}

function Banner({
  tone,
  icon: Icon,
  children,
  onDismiss,
}: {
  tone: "warn" | "error";
  icon: typeof AlertCircle;
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 border-b px-4 py-2 text-xs",
        tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        tone === "error" && "bg-destructive/10 text-destructive",
      )}
    >
      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span className="flex-1">{children}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 font-semibold underline-offset-2 hover:underline"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
