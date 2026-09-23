"use client";

import { useState } from "react";
import type { Briefing, BriefingItem } from "@/lib/analysis/facts";
import type { DataIssue } from "@/lib/analysis/parse";
import { AskButton } from "@/components/assistant/AskButton";
import { TIER_ORDER, TIER_STYLE } from "./tiers";

/**
 * The first thing on the report: one sentence on what is happening, then the
 * biggest problem, biggest improvement, best opportunity, and how far to
 * trust the report. Built entirely from deterministic facts.
 */
export function TodayBriefing({
  briefing,
  comparisonLabel,
  issues,
}: {
  briefing: Briefing;
  comparisonLabel: string | null;
  issues: DataIssue[];
}) {
  return (
    <section aria-labelledby="briefing-heading" className="rounded-xl border border-ink-200 bg-white">
      <div className="flex flex-wrap items-start gap-3 border-b border-ink-100 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id="briefing-heading" className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            Today&apos;s briefing{comparisonLabel ? <span className="font-normal normal-case"> · {comparisonLabel}</span> : null}
          </h2>
          <p className="mt-1.5 text-base leading-relaxed text-ink-900 sm:text-lg">{briefing.verdict}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {TIER_ORDER.filter((t) => briefing.counts[t] > 0).map((t) => (
              <a
                key={t}
                href="#actions"
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${TIER_STYLE[t].chip}`}
              >
                <span aria-hidden="true">{TIER_STYLE[t].glyph}</span>
                {briefing.counts[t]} {TIER_STYLE[t].label.toLowerCase()}
              </a>
            ))}
          </div>
        </div>
        <AskButton focus={{ kind: "report" }} label="Ask AdMate" variant="button" />
      </div>
      <div className="grid gap-px bg-ink-100 sm:grid-cols-2 xl:grid-cols-4">
        <BriefingCard label="Biggest problem" tone="problem" item={briefing.biggestProblem} empty="No critical or review items." />
        <BriefingCard label="Biggest improvement" tone="win" item={briefing.biggestImprovement} empty="No significant improvement between the two periods." />
        <BriefingCard label="Biggest opportunity" tone="opportunity" item={briefing.biggestOpportunity} empty="No clear scaling opportunity in this report." />
        <DataConfidenceCard confidence={briefing.dataConfidence} issues={issues} />
      </div>
    </section>
  );
}

const TONE = {
  problem: "text-high-700",
  win: "text-good-700",
  opportunity: "text-brand-700",
} as const;

function BriefingCard({
  label,
  tone,
  item,
  empty,
}: {
  label: string;
  tone: keyof typeof TONE;
  item: BriefingItem | null;
  empty: string;
}) {
  return (
    <div className="flex flex-col bg-white px-5 py-4">
      <p className={`text-xs font-semibold uppercase tracking-wide ${TONE[tone]}`}>{label}</p>
      {item ? (
        <>
          <p className="mt-1.5 text-sm font-semibold text-ink-900">{item.title}</p>
          <p className="text-xs text-ink-500">{item.level === "account" ? "Account-wide" : item.entityName}</p>
          <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-ink-700">{item.summary}</p>
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
            <a href={`#${item.diagnosisId}`} className="text-xs font-medium text-brand-600 hover:underline">
              {item.actionLabel} →
            </a>
            <AskButton focus={{ kind: "diagnosis", diagnosisId: item.diagnosisId }} />
          </div>
        </>
      ) : (
        <p className="mt-1.5 text-sm text-ink-500">{empty}</p>
      )}
    </div>
  );
}

const LEVEL_STYLE = {
  good: { label: "Good", cls: "text-good-700", glyph: "●●●" },
  fair: { label: "Fair", cls: "text-med-700", glyph: "●●○" },
  limited: { label: "Limited", cls: "text-high-700", glyph: "●○○" },
};

function DataConfidenceCard({ confidence, issues }: { confidence: Briefing["dataConfidence"]; issues: DataIssue[] }) {
  const [open, setOpen] = useState(false);
  const style = LEVEL_STYLE[confidence.level];
  const notes = issues.filter((i) => i.severity === "info");
  return (
    <div className="flex flex-col bg-white px-5 py-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-600">Data confidence</p>
      <p className={`mt-1.5 text-sm font-semibold ${style.cls}`}>
        <span aria-hidden="true" className="mr-1 tracking-tighter">{style.glyph}</span>
        {style.label}
      </p>
      <ul className="mt-1.5 space-y-1 text-sm leading-relaxed text-ink-700">
        {confidence.reasons.slice(0, open ? undefined : 2).map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      {open && notes.length > 0 ? (
        <div className="mt-2 border-t border-ink-100 pt-2">
          <p className="text-xs font-semibold text-ink-600">What this file does and doesn&apos;t contain</p>
          <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-600">
            {notes.map((n, i) => (
              <li key={i}>{n.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {confidence.reasons.length > 2 || notes.length > 0 ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-auto pt-3 text-left text-xs font-medium text-brand-600 hover:underline"
        >
          {open ? "Show less" : "Details"}
        </button>
      ) : null}
    </div>
  );
}
