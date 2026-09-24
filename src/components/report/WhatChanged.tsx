"use client";

import type { DriverAnalysis } from "@/lib/analysis/drivers";
import type { Objective } from "@/lib/analysis/objectives";
import { metricLabel } from "@/lib/analysis/objectives";
import { METRIC_META } from "@/lib/analysis/types";
import { describeChange } from "@/lib/analysis/facts";
import { formatByType, formatChange } from "@/lib/format";
import { AskButton } from "@/components/assistant/AskButton";

/**
 * "What changed, and who changed it" - each headline metric's movement
 * between the two halves of the report, broken down into the campaigns (or
 * ad sets / ads) that caused it. Bars show each child's share of the change;
 * the text beside each bar says which way it pushed, so direction never
 * relies on colour.
 */
export function WhatChanged({
  analyses,
  objective,
  currency,
  comparisonLabel,
}: {
  analyses: DriverAnalysis[];
  objective: Objective | "mixed";
  currency: string;
  comparisonLabel: string | null;
}) {
  const meaningful = analyses.filter((a) => a.changePct !== null && Math.abs(a.changePct) >= 0.05);
  if (analyses.length === 0) return null;

  return (
    <section aria-labelledby="changed-heading" className="rounded-xl border border-ink-200 bg-white">
      <div className="border-b border-ink-100 px-5 py-4">
        <h2 id="changed-heading" className="text-sm font-semibold text-ink-900">
          What changed
          {comparisonLabel ? <span className="ml-2 font-normal text-ink-500">— {comparisonLabel}</span> : null}
        </h2>
        <p className="mt-0.5 text-xs text-ink-500">
          Each change is split exactly into the parts that caused it. &ldquo;Pushed up/down&rdquo; is the entity&apos;s share of
          the change; &ldquo;offset&rdquo; means it moved the other way.
        </p>
      </div>
      {meaningful.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-600">
          Headline metrics moved less than 5% between the two halves of the report.
        </p>
      ) : (
        <div className="divide-y divide-ink-100">
          {meaningful.slice(0, 3).map((a) => (
            <ChangeRow key={a.metric} analysis={a} objective={objective} currency={currency} />
          ))}
        </div>
      )}
    </section>
  );
}

function ChangeRow({
  analysis,
  objective,
  currency,
}: {
  analysis: DriverAnalysis;
  objective: Objective | "mixed";
  currency: string;
}) {
  const fmt = METRIC_META[analysis.metric].format;
  const label = metricLabel(analysis.metric, objective);
  const rows = analysis.contributions
    .filter((c) => c.shareOfChange !== null && Math.abs(c.shareOfChange) >= 0.03)
    .slice(0, 5);
  const up = analysis.change > 0;
  const maxShare = Math.max(1, ...rows.map((r) => Math.abs(r.shareOfChange ?? 0)));

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-900">
            {label}{" "}
            <span className="font-normal text-ink-600 tnum">
              {formatByType(analysis.previousValue, fmt, currency)} → {formatByType(analysis.currentValue, fmt, currency)} (
              {formatChange(analysis.changePct)})
            </span>
            <span className={`ml-2 text-xs font-medium ${analysis.worsened ? "text-high-700" : "text-good-700"}`}>
              {analysis.worsened ? "worse" : "better"}
            </span>
          </p>
          <p className="mt-1 text-sm leading-relaxed text-ink-700">{describeChange(analysis, objective, currency)}</p>
        </div>
        <AskButton focus={{ kind: "change", metric: analysis.metric }} label="Why?" />
      </div>
      {rows.length > 0 ? (
        <ul className="mt-3 space-y-1.5" aria-label={`Contributions to the change in ${label}`}>
          {rows.map((c) => {
            const share = c.shareOfChange ?? 0;
            const pushes = share > 0;
            const width = `${Math.max(2, (Math.abs(share) / maxShare) * 100)}%`;
            const direction = pushes ? (up ? "pushed up" : "pushed down") : "offset";
            const detail =
              c.previousValue !== null && c.currentValue !== null
                ? `${label} ${formatByType(c.previousValue, fmt, currency)} → ${formatByType(c.currentValue, fmt, currency)}`
                : c.previousDenominator === 0
                  ? "new in the latest period"
                  : "no results in one period";
            return (
              <li key={c.entityId} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 text-xs sm:grid-cols-[minmax(0,14rem)_1fr_auto]">
                <span className="truncate text-ink-800" title={c.name}>
                  {c.name}
                </span>
                <span className="relative h-3 rounded bg-ink-100" title={`${c.name}: ${Math.round(Math.abs(share) * 100)}% of the change (${direction}); ${detail}`}>
                  <span
                    className={`absolute inset-y-0 left-0 rounded ${pushes ? "bg-brand-500" : "bg-ink-300"}`}
                    style={{ width }}
                  />
                </span>
                <span className="flex items-center gap-1 whitespace-nowrap text-ink-600 tnum">
                  {Math.round(Math.abs(share) * 100)}% {direction}
                  <AskButton focus={{ kind: "entity", entityId: c.entityId }} variant="icon" />
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
