/**
 * The thread: the event log rendered as a conversation.
 *
 * Tool calls collapse into one line each so the prose stays readable, but the
 * full result — including the error code and the hint the model was given — is
 * one click away. Nothing that happened is hidden from the producer.
 */

import { useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Ban,
  ChevronRight,
  CircleCheck,
  Crop,
  Eye,
  FileText,
  Flag,
  HelpCircle,
  Info,
  Loader2,
  Play,
  Scissors,
  Search,
  Sigma,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatDuration,
  type AgentEvent,
  type ToolName,
} from "@/services/agentTypes";
import {
  buildThreadItems,
  type ThreadItem,
  type ToolItem,
} from "./threadItems";

const TOOL_ICONS: Record<ToolName, typeof Search> = {
  search_video: Search,
  read_transcript: FileText,
  watch_clip: Play,
  view_frames: Eye,
  edit_segments: Scissors,
  check_budget: Sigma,
  ask_user: HelpCircle,
  finish_turn: Flag,
};

export function AgentThread({ events }: { events: AgentEvent[] }) {
  const items = buildThreadItems(events);

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <ThreadRow key={item.key} item={item} />
      ))}
    </div>
  );
}

function ThreadRow({ item }: { item: ThreadItem }) {
  switch (item.kind) {
    case "runStart":
      return (
        <div className="flex items-center gap-2 pt-2">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
            New turn
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>
      );

    case "user":
      return <UserBubble text={item.text} isBrief={item.isBrief} />;

    case "assistant":
      return (
        <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
          {item.text}
        </p>
      );

    case "stage":
      return (
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-500/80">
            {item.label}
          </span>
          <div className="h-px flex-1 bg-blue-500/15" />
          {item.note && (
            <span className="text-[10px] text-muted-foreground">{item.note}</span>
          )}
        </div>
      );

    case "tool":
      return <ToolRow item={item} />;

    case "question":
      return (
        <div className="rounded-lg border-2 border-blue-500/30 bg-blue-500/5 p-3">
          <div className="flex items-center gap-1.5 mb-1 text-blue-500">
            <HelpCircle className="h-3.5 w-3.5" />
            <span className="text-[10px] font-bold uppercase tracking-wider">
              Needs your call
            </span>
          </div>
          <p className="text-sm leading-relaxed">{item.text}</p>
        </div>
      );

    case "framing":
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {item.done ? (
            item.error ? (
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            ) : (
              <CircleCheck className="h-3.5 w-3.5 text-emerald-500" />
            )
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
          )}
          <Crop className="h-3 w-3" />
          <span>
            {item.error
              ? item.error
              : item.done
                ? `Framed ${item.completed} of ${item.total} segments`
                : `Framing ${item.completed}/${item.total} segments…`}
          </span>
        </div>
      );

    case "completed":
      return (
        <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-emerald-500">
            <CircleCheck className="h-3.5 w-3.5" />
            <span className="text-[10px] font-bold uppercase tracking-wider">
              Turn complete
            </span>
          </div>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{item.summary}</p>
          {item.concerns.length > 0 && (
            <ul className="space-y-1 pt-1 border-t">
              {item.concerns.map((c, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case "failed":
      return (
        <div className="rounded-lg border-2 border-destructive/40 bg-destructive/5 p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
            <span className="text-[10px] font-bold uppercase tracking-wider">
              Run stopped · {item.code}
            </span>
          </div>
          <p className="text-sm leading-relaxed">{item.message}</p>
          {item.detail && <Detail text={item.detail} />}
          {item.retryable && (
            <p className="text-xs text-muted-foreground">
              This one looks retryable — send a message to pick up where it left off.
            </p>
          )}
        </div>
      );

    case "cancelled":
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Ban className="h-3.5 w-3.5" />
          <span>{item.note ?? "Stopped."}</span>
        </div>
      );

    case "notice":
      return (
        <div
          className={cn(
            "flex gap-2 text-xs rounded-md px-2.5 py-2",
            item.level === "error" && "bg-destructive/10 text-destructive",
            item.level === "warn" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
            item.level === "info" && "bg-muted text-muted-foreground",
          )}
        >
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <span>{item.message}</span>
            {item.detail && <Detail text={item.detail} />}
          </div>
        </div>
      );

    default:
      return null;
  }
}

function UserBubble({ text, isBrief }: { text: string; isBrief: boolean }) {
  const [open, setOpen] = useState(false);

  if (isBrief) {
    return (
      <div className="rounded-lg bg-muted/60 border">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-1.5 px-3 py-2 text-left"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="text-xs font-semibold text-muted-foreground">
            The brief you sent
          </span>
        </button>
        {open && (
          <p className="px-3 pb-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {text}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-3.5 py-2 text-sm text-white whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[item.name] ?? Sigma;
  const hasDetail =
    Boolean(item.error) ||
    (item.warnings?.length ?? 0) > 0 ||
    item.progress.length > 0;

  return (
    <div
      className={cn(
        "rounded-md border text-xs",
        item.done && !item.ok
          ? "border-destructive/40 bg-destructive/5"
          : "border-transparent bg-muted/40",
      )}
    >
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        disabled={!hasDetail}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left disabled:cursor-default"
      >
        {!item.done ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
        ) : item.ok ? (
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        )}

        <span className={cn("truncate", !item.done && "text-foreground")}>
          {item.done && item.ok ? item.summary || item.label : item.label}
        </span>

        {(item.warnings?.length ?? 0) > 0 && item.ok && (
          <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
        )}

        {item.done && item.ms != null && item.ms > 3000 && (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/60">
            {formatDuration(item.ms / 1000)}
          </span>
        )}

        {hasDetail && (
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
              item.ms != null && item.ms > 3000 ? "" : "ml-auto",
              open && "rotate-90",
            )}
          />
        )}
      </button>

      {open && (
        <div className="px-2.5 pb-2 space-y-1.5">
          {item.progress.map((note, i) => (
            <p key={i} className="text-muted-foreground">
              {note}
            </p>
          ))}

          {item.error && (
            <div className="space-y-1">
              <p className="text-destructive">{item.error.message}</p>
              <p className="text-muted-foreground">
                What the editor was told to do: {item.error.hint}
              </p>
              {item.error.detail && <Detail text={item.error.detail} />}
            </div>
          )}

          {item.warnings?.map((warning, i) => (
            <p key={i} className="text-amber-600 dark:text-amber-400">
              {warning}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function Detail({ text }: { text: string }) {
  return (
    <pre className="mt-1 max-h-32 overflow-auto rounded bg-black/5 dark:bg-white/5 p-2 text-[10px] leading-snug whitespace-pre-wrap break-words">
      {text}
    </pre>
  );
}
