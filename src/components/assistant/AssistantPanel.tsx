"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PerformanceModel } from "@/lib/analysis/metrics";
import type { ReportFacts } from "@/lib/analysis/facts";
import { buildOpener } from "@/lib/assistant/openers";
import type {
  AssistantAnswer,
  AssistantEvent,
  AssistantFocus,
  ChatMessage,
  Suggestion,
  SuggestionId,
} from "@/lib/assistant/types";
import { useAssistant } from "./AssistantProvider";
import { Sparkle } from "./AskButton";

/**
 * The "Ask AdMate" panel: a right-hand column on desktop, a bottom sheet on
 * phones. Openers and suggested questions are computed locally from the
 * report facts; only questions go to the server.
 */

interface OpenerMessage {
  id: string;
  role: "opener";
  text: string;
  label: string;
  suggestions: Suggestion[];
}

type Entry = ChatMessage | OpenerMessage;

export function AssistantPanel({
  reportId,
  aiEnabled,
  facts,
  model,
  currency,
}: {
  reportId: string;
  aiEnabled: boolean;
  facts: ReportFacts;
  model: PerformanceModel;
  currency: string;
}) {
  const assistant = useAssistant();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastFocusVersion = useRef(-1);

  const open = assistant?.open ?? false;
  const focus = assistant?.focus ?? ({ kind: "report" } as AssistantFocus);
  const ctx = useMemo(() => ({ facts, model, currency }), [facts, model, currency]);
  const opener = useMemo(() => buildOpener(focus, ctx), [focus, ctx]);

  // Load the stored conversation the first time the panel opens.
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    fetch(`/api/reports/${reportId}/assistant`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((data: { messages: ChatMessage[] }) => {
        if (cancelled) return;
        setEntries((current) => [...(data.messages ?? []), ...current]);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [open, loaded, reportId]);

  // A new "Ask" click adds a fresh opener for that focus.
  useEffect(() => {
    if (!assistant || assistant.focusVersion === lastFocusVersion.current) return;
    lastFocusVersion.current = assistant.focusVersion;
    if (assistant.focusVersion === 0) return;
    setEntries((current) => [
      ...current,
      {
        id: `opener-${assistant.focusVersion}`,
        role: "opener",
        text: opener.text,
        label: opener.label,
        suggestions: opener.suggestions,
      },
    ]);
  }, [assistant, opener]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [entries, status]);

  const send = useCallback(
    async (text: string, suggestionId?: SuggestionId) => {
      const question = text.trim();
      if (!question || sending) return;
      setError(null);
      setSending(true);
      setStatus("Reading the report…");
      const optimistic: ChatMessage = {
        id: `local-${Date.now()}`,
        role: "user",
        text: question,
        focusLabel: opener.label,
        createdAt: new Date().toISOString(),
      };
      setEntries((current) => [...current, optimistic]);
      setInput("");

      try {
        const res = await fetch(`/api/reports/${reportId}/assistant`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: question, focus, suggestionId: suggestionId ?? null }),
        });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "AdMate could not answer that right now.");
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const event = JSON.parse(line) as AssistantEvent;
            if (event.type === "status") setStatus(event.text);
            else if (event.type === "answer") setEntries((current) => [...current, event.message]);
            else if (event.type === "error") throw new Error(event.error);
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        setSending(false);
        setStatus(null);
      }
    },
    [focus, opener.label, reportId, sending],
  );

  // A question passed along with the click ("Ask: Should I pause it?").
  useEffect(() => {
    if (!assistant?.pendingQuestion || !loaded || sending) return;
    const q = assistant.pendingQuestion;
    assistant.clearPendingQuestion();
    void send(q);
  }, [assistant, loaded, sending, send]);

  const clear = async () => {
    await fetch(`/api/reports/${reportId}/assistant`, { method: "DELETE" }).catch(() => undefined);
    setEntries([]);
  };

  if (!assistant) return null;

  const last = entries[entries.length - 1];
  const suggestions: { text: string; id?: SuggestionId }[] =
    last && last.role === "opener"
      ? last.suggestions
      : last && last.role === "assistant" && last.answer
        ? last.answer.followUps.map((text) => ({ text }))
        : entries.length === 0
          ? opener.suggestions
          : [];

  return (
    <>
      {open ? (
        <div className="fixed inset-0 z-30 bg-ink-900/20 lg:hidden no-print" onClick={() => assistant.setOpen(false)} aria-hidden="true" />
      ) : null}
      <aside
        aria-label="Ask AdMate"
        className={`no-print fixed z-40 flex-col border-ink-200 bg-white shadow-xl
          inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl border-t
          lg:inset-y-0 lg:left-auto lg:right-0 lg:max-h-none lg:w-[400px] lg:rounded-none lg:border-l lg:border-t-0
          ${open ? "flex" : "hidden"}`}
      >
        <header className="flex items-center gap-2 border-b border-ink-100 px-4 py-3">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Sparkle className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink-900">Ask AdMate</p>
            <p className="truncate text-xs text-ink-500">Answers from this report&apos;s data only</p>
          </div>
          {entries.some((e) => e.role !== "opener") ? (
            <button type="button" onClick={clear} className="rounded px-2 py-1 text-xs text-ink-500 hover:bg-ink-100">
              Clear
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => assistant.setOpen(false)}
            className="rounded p-1 text-ink-500 hover:bg-ink-100"
            aria-label="Close assistant"
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="currentColor" aria-hidden="true">
              <path d="M5.3 5.3a1 1 0 011.4 0L10 8.6l3.3-3.3a1 1 0 111.4 1.4L11.4 10l3.3 3.3a1 1 0 01-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 01-1.4-1.4L8.6 10 5.3 6.7a1 1 0 010-1.4z" />
            </svg>
          </button>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {entries.length === 0 ? (
            <OpenerBubble label={opener.label} text={opener.text} />
          ) : (
            entries.map((entry) =>
              entry.role === "opener" ? (
                <OpenerBubble key={entry.id} label={entry.label} text={entry.text} />
              ) : entry.role === "user" ? (
                <UserBubble key={entry.id} message={entry} />
              ) : entry.answer ? (
                <AnswerView key={entry.id} answer={entry.answer} />
              ) : null,
            )
          )}
          {status ? (
            <p className="flex items-center gap-2 text-xs text-ink-500" role="status">
              <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" aria-hidden="true" />
              {status}
            </p>
          ) : null}
          {error ? <p className="rounded-lg border border-high-200 bg-high-50 px-3 py-2 text-xs text-high-700">{error}</p> : null}
        </div>

        {suggestions.length > 0 && !sending ? (
          <div className="flex flex-wrap gap-1.5 border-t border-ink-100 px-4 py-2.5">
            {suggestions.map((s) => (
              <button
                key={s.text}
                type="button"
                onClick={() => void send(s.text, s.id)}
                className="rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-100"
              >
                {s.text}
              </button>
            ))}
          </div>
        ) : null}

        <form
          className="border-t border-ink-100 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-ink-500">
            <span className="rounded bg-ink-100 px-1.5 py-0.5 font-medium text-ink-600">📍 {opener.label}</span>
            {focus.kind !== "report" ? (
              <button type="button" className="underline hover:text-ink-700" onClick={() => assistant.ask({ kind: "report" })}>
                whole report
              </button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={!aiEnabled || sending}
              maxLength={600}
              placeholder={aiEnabled ? "Ask a follow-up…" : "Free-text questions need an AI key - use the suggestions above"}
              className="min-w-0 flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm disabled:bg-ink-50 disabled:text-ink-400"
              aria-label="Your question"
            />
            <button
              type="submit"
              disabled={!aiEnabled || sending || input.trim() === ""}
              className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:bg-brand-300"
            >
              Ask
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}

function OpenerBubble({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-xl border border-brand-100 bg-brand-50/60 px-3 py-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">{label}</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-800">{text}</p>
    </div>
  );
}

function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-xl rounded-br-sm bg-ink-800 px-3 py-2 text-sm text-white">{message.text}</p>
    </div>
  );
}

function AnswerView({ answer }: { answer: AssistantAnswer }) {
  const b = answer.blocks;
  return (
    <div className="space-y-2.5 rounded-xl border border-ink-200 px-3 py-3 text-sm leading-relaxed">
      {b.observation ? <Block label="What happened" tone="fact">{b.observation}</Block> : null}
      {b.evidence.length > 0 ? (
        <Block label="The numbers" tone="fact">
          <ul className="space-y-0.5">
            {b.evidence.map((e, i) => (
              <li key={i} className="tnum text-ink-700">
                · {e}
              </li>
            ))}
          </ul>
        </Block>
      ) : null}
      {b.interpretation ? <Block label="What it likely means" tone="interpretation">{b.interpretation}</Block> : null}
      {b.recommendation ? <Block label="What to consider" tone="advice">{b.recommendation}</Block> : null}
      {b.confidence || b.limitations.length > 0 ? (
        <Block label="Confidence & limits" tone="limits">
          {b.confidence ? <p>{b.confidence}</p> : null}
          {b.limitations.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {b.limitations.map((l, i) => (
                <li key={i}>· {l}</li>
              ))}
            </ul>
          ) : null}
        </Block>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {answer.engine === "local" ? (
          <span className="rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 text-[10px] font-medium text-ink-500">
            Local analyst
          </span>
        ) : null}
        {answer.notice ? <span className="text-[11px] text-ink-500">{answer.notice}</span> : null}
      </div>
    </div>
  );
}

const TONE: Record<string, string> = {
  fact: "text-ink-500",
  interpretation: "text-med-700",
  advice: "text-brand-700",
  limits: "text-ink-500",
};

function Block({ label, tone, children }: { label: string; tone: string; children: React.ReactNode }) {
  return (
    <div>
      <p className={`text-[11px] font-semibold uppercase tracking-wide ${TONE[tone]}`}>{label}</p>
      <div className="mt-0.5 text-ink-800">{children}</div>
    </div>
  );
}
