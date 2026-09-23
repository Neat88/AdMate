"use client";

import { useEffect, useRef, useState } from "react";
import type { MetricKey } from "@/lib/analysis/types";
import { METRIC_META } from "@/lib/analysis/types";
import { GLOSSARY, relevanceNote } from "@/lib/analysis/glossary";
import type { Objective } from "@/lib/analysis/objectives";

/** ⓘ popover: what a metric means, how to read a move, and whether it matters for this objective. */
export function MetricInfo({ metric, objective }: { metric: MetricKey; objective?: Objective | "mixed" | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const entry = GLOSSARY[metric];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!entry) return null;
  const note = relevanceNote(metric, objective ?? null);

  return (
    <span ref={ref} className="relative inline-flex no-print">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`What does ${METRIC_META[metric].label} mean?`}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-ink-300 text-[10px] font-semibold leading-none text-ink-500 hover:border-ink-500 hover:text-ink-700"
      >
        i
      </button>
      {open ? (
        <span
          role="dialog"
          className="absolute left-0 top-6 z-20 w-64 rounded-lg border border-ink-200 bg-white p-3 text-left text-xs normal-case tracking-normal text-ink-700 shadow-lg"
        >
          <span className="block font-semibold text-ink-900">{METRIC_META[metric].label}</span>
          <span className="mt-1 block leading-relaxed">{entry.what}</span>
          <span className="mt-1.5 block leading-relaxed">{entry.reading}</span>
          <span className="mt-1.5 block leading-relaxed text-ink-500">{entry.diagnose}</span>
          {note ? <span className="mt-1.5 block font-medium leading-relaxed text-brand-700">{note}</span> : null}
        </span>
      ) : null}
    </span>
  );
}
