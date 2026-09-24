"use client";

import { useState } from "react";
import type { AssistantAnswer } from "@/lib/assistant/types";

export interface PinnedView {
  id: string;
  question: string;
  answer: AssistantAnswer;
}

/**
 * Assistant answers the marketer chose to include in the client report,
 * rendered in the same facts / interpretation / advice structure. Removal
 * controls are hidden when printing.
 */
export function PinnedAnswers({ reportId, pins }: { reportId: string; pins: PinnedView[] }) {
  const [items, setItems] = useState(pins);
  if (items.length === 0) return null;

  const remove = async (id: string) => {
    const res = await fetch(`/api/reports/${reportId}/pins/${id}`, { method: "DELETE" });
    if (res.ok) setItems((current) => current.filter((p) => p.id !== id));
  };

  return (
    <section className="print-break">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">Questions answered</h2>
      <div className="mt-3 space-y-4">
        {items.map((p) => (
          <article key={p.id} className="rounded-lg border border-ink-200 p-4 print-break">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink-900">{p.question || "Analyst note"}</h3>
              <button
                type="button"
                onClick={() => void remove(p.id)}
                className="no-print shrink-0 text-xs text-ink-500 hover:text-high-700"
              >
                Remove
              </button>
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-800">{p.answer.blocks.observation}</p>
            {p.answer.blocks.evidence.length > 0 ? (
              <ul className="mt-2 space-y-0.5 text-sm text-ink-700 tnum">
                {p.answer.blocks.evidence.map((e, i) => (
                  <li key={i}>· {e}</li>
                ))}
              </ul>
            ) : null}
            {p.answer.blocks.interpretation ? (
              <p className="mt-2 text-sm leading-relaxed text-ink-700">
                <span className="font-medium">What it likely means: </span>
                {p.answer.blocks.interpretation}
              </p>
            ) : null}
            {p.answer.blocks.recommendation ? (
              <p className="mt-2 text-sm leading-relaxed text-ink-700">
                <span className="font-medium">Next step: </span>
                {p.answer.blocks.recommendation}
              </p>
            ) : null}
            {p.answer.blocks.confidence ? <p className="mt-2 text-xs text-ink-500">{p.answer.blocks.confidence}</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}
