"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { PerformanceModel } from "@/lib/analysis/metrics";
import type { ReportFacts } from "@/lib/analysis/facts";
import type { AssistantFocus } from "@/lib/assistant/types";
import { AssistantPanel } from "./AssistantPanel";

/**
 * Report-scoped assistant state. Any "Ask" button in the report calls
 * `ask(focus)`: the panel opens with that focus attached, so the user never
 * has to say which campaign or metric they mean.
 */

interface AssistantContextValue {
  open: boolean;
  focus: AssistantFocus;
  /** Bumped on every ask() so the panel re-renders the opener even for the same focus. */
  focusVersion: number;
  pendingQuestion: string | null;
  ask: (focus: AssistantFocus, question?: string) => void;
  setOpen: (open: boolean) => void;
  clearPendingQuestion: () => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

export function useAssistant(): AssistantContextValue | null {
  return useContext(AssistantContext);
}

export function AssistantProvider({
  reportId,
  aiEnabled,
  facts,
  model,
  currency,
  children,
}: {
  reportId: string;
  aiEnabled: boolean;
  facts: ReportFacts;
  model: PerformanceModel;
  currency: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<AssistantFocus>({ kind: "report" });
  const [focusVersion, setFocusVersion] = useState(0);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);

  const ask = useCallback((next: AssistantFocus, question?: string) => {
    setFocus(next);
    setFocusVersion((v) => v + 1);
    setPendingQuestion(question ?? null);
    setOpen(true);
  }, []);

  const value = useMemo<AssistantContextValue>(
    () => ({
      open,
      focus,
      focusVersion,
      pendingQuestion,
      ask,
      setOpen,
      clearPendingQuestion: () => setPendingQuestion(null),
    }),
    [open, focus, focusVersion, pendingQuestion, ask],
  );

  return (
    <AssistantContext.Provider value={value}>
      <div className={`transition-[padding] ${open ? "lg:pr-[420px]" : ""}`}>{children}</div>
      <AssistantPanel reportId={reportId} aiEnabled={aiEnabled} facts={facts} model={model} currency={currency} />
    </AssistantContext.Provider>
  );
}
