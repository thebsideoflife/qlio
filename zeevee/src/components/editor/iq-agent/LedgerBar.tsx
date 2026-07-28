/**
 * The budget, rendered for the producer exactly as it is rendered for the
 * model. Same arithmetic, same verdict, no second source of truth.
 */

import { useState } from "react";
import { AlertTriangle, ChevronDown, Check, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration, type AgentLedger } from "@/services/agentTypes";

export function LedgerBar({ ledger }: { ledger: AgentLedger }) {
  const [open, setOpen] = useState(false);

  const status = ledger.target.status;
  const clean = ledger.blocking.length === 0;
  const detailCount = ledger.blocking.length + ledger.warnings.length;

  const verdict =
    status === "no_target"
      ? "No runtime target"
      : status === "within"
        ? "On target"
        : status === "over"
          ? `${formatDuration(Math.abs(ledger.target.delta))} over`
          : `${formatDuration(Math.abs(ledger.target.delta))} under`;

  return (
    <div
      className={cn(
        "border-b text-xs",
        clean
          ? "bg-emerald-500/5 border-emerald-500/20"
          : "bg-amber-500/5 border-amber-500/20",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={detailCount === 0}
        className="w-full flex items-center gap-2 px-4 py-2 text-left disabled:cursor-default"
      >
        {clean ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        )}

        <span className="font-semibold tabular-nums">
          {ledger.segmentCount} {ledger.segmentCount === 1 ? "segment" : "segments"}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="tabular-nums">{formatDuration(ledger.totalDuration)}</span>

        {ledger.target.seconds != null && (
          <>
            <span className="text-muted-foreground">/</span>
            <span className="tabular-nums text-muted-foreground">
              {formatDuration(ledger.target.seconds)}
            </span>
          </>
        )}

        <span
          className={cn(
            "ml-auto font-medium",
            status === "within" && "text-emerald-500",
            (status === "over" || status === "under") && "text-amber-500",
            status === "no_target" && "text-muted-foreground",
          )}
        >
          {verdict}
        </span>

        {detailCount > 0 && (
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        )}
      </button>

      {open && detailCount > 0 && (
        <div className="px-4 pb-3 space-y-1.5">
          {ledger.blocking.map((item, i) => (
            <div key={`b${i}`} className="flex gap-2 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{item}</span>
            </div>
          ))}
          {ledger.warnings.map((item, i) => (
            <div key={`w${i}`} className="flex gap-2 text-muted-foreground">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{item}</span>
            </div>
          ))}
          <div className="pt-1 text-[11px] text-muted-foreground/70">
            Spread across the source: [{ledger.coverage.quartiles.join(", ")}] by quarter
            {ledger.coverage.largestGap && (
              <> · largest untouched stretch {formatDuration(ledger.coverage.largestGap.seconds)}</>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
