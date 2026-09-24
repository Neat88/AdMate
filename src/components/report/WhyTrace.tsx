"use client";

import { useState } from "react";
import type { Finding } from "@/lib/analysis/detectors";

/**
 * "Why am I seeing this?" - the gates a finding passed, in order, so a user
 * can check the reasoning instead of taking it on trust.
 */
export function WhyTrace({ findings }: { findings: Finding[] }) {
  const [open, setOpen] = useState(false);
  const traced = findings.filter((f) => f.trigger && f.trigger.checks.length > 0);
  if (traced.length === 0) return null;

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs font-medium text-ink-600 underline decoration-dotted underline-offset-2 hover:text-ink-900"
      >
        {open ? "Hide reasoning" : "Why am I seeing this?"}
      </button>
      {open ? (
        <div className="mt-2 space-y-3 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2.5">
          {traced.map((f) => (
            <div key={f.id}>
              <p className="text-xs font-semibold text-ink-800">
                {f.trigger!.rule} <span className="font-normal text-ink-500">— {f.title}</span>
              </p>
              <ol className="mt-1.5 space-y-1.5">
                {f.trigger!.checks.map((c, i) => (
                  <li key={i} className="flex gap-2 text-xs leading-relaxed">
                    <span
                      aria-label={c.passed ? "passed" : "not met"}
                      className={`mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold ${
                        c.passed ? "bg-good-50 text-good-700" : "bg-med-50 text-med-700"
                      }`}
                    >
                      {c.passed ? "✓" : "!"}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium text-ink-800">{c.label}:</span>{" "}
                      <span className="text-ink-700">{c.observed}</span>
                      <span className="block text-ink-500">Rule: {c.rule}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          <p className="text-[11px] text-ink-500">
            All figures are calculated by AdMate from your file. Nothing here is estimated by an AI model.
          </p>
        </div>
      ) : null}
    </div>
  );
}
