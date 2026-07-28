/**
 * Prompt overrides, per project. Deliberately tucked away: useful when you know
 * what you're doing, invisible when you don't.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ChevronRight,
  Loader2,
  RotateCcw,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchAgentPrompts, saveAgentPrompts } from "@/services/agentApi";
import type { AgentPromptSpec } from "@/services/agentTypes";

export function PromptsEditor({
  projectId,
  disabled,
}: {
  projectId: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<AgentPromptSpec[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchAgentPrompts(projectId);
      setPrompts(response.prompts);
      setDrafts(
        Object.fromEntries(
          response.prompts.map((p) => [p.key, p.override ?? p.default]),
        ),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load the prompts.",
      );
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open && !prompts && !loading) void load();
  }, [open, prompts, loading, load]);

  // A different project means different overrides.
  useEffect(() => {
    setPrompts(null);
    setDrafts({});
    setExpanded(null);
  }, [projectId]);

  const save = async () => {
    if (!prompts) return;
    setSaving(true);
    setError(null);
    try {
      const overrides: Record<string, string | null> = {};
      for (const prompt of prompts) {
        const draft = drafts[prompt.key] ?? "";
        overrides[prompt.key] =
          draft.trim() === prompt.default.trim() ? null : draft;
      }
      await saveAgentPrompts(projectId, overrides);
      setSavedAt(Date.now());
      setPrompts(
        prompts.map((p) => ({
          ...p,
          override:
            (drafts[p.key] ?? "").trim() === p.default.trim()
              ? null
              : (drafts[p.key] ?? null),
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    prompts?.some(
      (p) => (drafts[p.key] ?? "") !== (p.override ?? p.default),
    ) ?? false;

  const overriddenCount =
    prompts?.filter((p) => p.override != null).length ?? 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-muted transition-colors"
      >
        <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold text-muted-foreground">
          Prompts
        </span>
        {overriddenCount > 0 && (
          <span className="rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-blue-500">
            {overriddenCount}
          </span>
        )}
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-[min(24rem,calc(100vw-2rem))] max-h-[min(32rem,60vh)] overflow-y-auto rounded-lg border bg-background shadow-lg px-4 py-3 space-y-3">
          <p className="text-[11px] text-muted-foreground">
            Edits apply to this project's next run. Leave a prompt untouched to keep
            the default.
          </p>

          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading prompts…
            </div>
          )}

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          {prompts?.map((prompt) => {
            const isOpen = expanded === prompt.key;
            const draft = drafts[prompt.key] ?? "";
            const isOverridden = draft.trim() !== prompt.default.trim();

            return (
              <div key={prompt.key} className="rounded-lg border bg-card">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : prompt.key)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left"
                >
                  <ChevronRight
                    className={cn(
                      "h-3 w-3 text-muted-foreground transition-transform",
                      isOpen && "rotate-90",
                    )}
                  />
                  <span className="text-xs font-semibold">{prompt.label}</span>
                  {isOverridden && (
                    <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                  )}
                </button>

                {isOpen && (
                  <div className="px-3 pb-3 space-y-2">
                    <p className="text-[11px] text-muted-foreground">
                      {prompt.description}
                    </p>
                    {prompt.variables.length > 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        Placeholders:{" "}
                        {prompt.variables.map((v) => `{{${v}}}`).join(" ")}
                      </p>
                    )}
                    <textarea
                      value={draft}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [prompt.key]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => e.stopPropagation()}
                      spellCheck={false}
                      className="w-full h-64 px-2.5 py-2 text-[11px] font-mono leading-relaxed rounded-md bg-muted/40 border focus:border-blue-400 focus:outline-none resize-y"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() =>
                        setDrafts((prev) => ({
                          ...prev,
                          [prompt.key]: prompt.default,
                        }))
                      }
                    >
                      <RotateCcw className="h-3 w-3 mr-1.5" />
                      Reset to default
                    </Button>
                  </div>
                )}
              </div>
            );
          })}

          {prompts && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={!dirty || saving || disabled}
                onClick={save}
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                ) : (
                  <Save className="h-3 w-3 mr-1.5" />
                )}
                Save prompts
              </Button>
              {disabled && (
                <span className="text-[11px] text-muted-foreground">
                  Finish the current run first.
                </span>
              )}
              {!disabled && savedAt && !dirty && (
                <span className="text-[11px] text-emerald-500">Saved.</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
