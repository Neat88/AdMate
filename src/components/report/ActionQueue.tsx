"use client";

import { useMemo, useState } from "react";
import type { Diagnosis, Tier } from "@/lib/analysis/diagnoses";
import type { Finding } from "@/lib/analysis/detectors";
import type { Insight } from "@/lib/ai/insights";
import type { RecommendationStatus } from "@/lib/db/queries";
import { DecisionCard } from "./DecisionCard";
import { TIER_ORDER, TIER_STYLE } from "./tiers";

export interface RecommendationRef {
  id: string;
  status: RecommendationStatus;
  note: string | null;
}

/**
 * "What to do" - diagnoses grouped by tier. Critical items open by default;
 * the filter row lets a busy user look at one tier at a time.
 */
export function ActionQueue({
  diagnoses,
  findings,
  insights,
  recommendations,
  currency,
}: {
  diagnoses: Diagnosis[];
  findings: Record<string, Finding>;
  insights: Record<string, Insight>;
  recommendations: Record<string, RecommendationRef>;
  currency: string;
}) {
  const [filter, setFilter] = useState<Tier | "all">("all");
  const insightMap = useMemo(() => new Map(Object.entries(insights)), [insights]);
  const counts = useMemo(() => {
    const c: Record<Tier, number> = { critical: 0, attention: 0, monitor: 0, performing: 0 };
    for (const d of diagnoses) c[d.tier]++;
    return c;
  }, [diagnoses]);

  const visibleTiers = TIER_ORDER.filter((t) => counts[t] > 0 && (filter === "all" || filter === t));

  return (
    <section id="actions" aria-labelledby="actions-heading">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="actions-heading" className="text-sm font-semibold text-ink-900">
          What to do
          <span className="ml-2 font-normal text-ink-500">— one card per problem, most urgent first</span>
        </h2>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter by tier">
          <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
            All ({diagnoses.length})
          </FilterButton>
          {TIER_ORDER.filter((t) => counts[t] > 0).map((t) => (
            <FilterButton key={t} active={filter === t} onClick={() => setFilter(t)}>
              <span aria-hidden="true">{TIER_STYLE[t].glyph}</span> {TIER_STYLE[t].label} ({counts[t]})
            </FilterButton>
          ))}
        </div>
      </div>

      {diagnoses.length === 0 ? (
        <p className="rounded-xl border border-ink-200 bg-white px-5 py-6 text-sm text-ink-600">
          Nothing in this report crossed AdMate&apos;s thresholds. That means nothing stood out against comparable
          campaigns or the earlier half of the report - not that results meet your business targets.
        </p>
      ) : (
        <div className="space-y-6">
          {visibleTiers.map((tier) => (
            <div key={tier}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-600">
                <span aria-hidden="true">{TIER_STYLE[tier].glyph}</span> {TIER_STYLE[tier].label} ({counts[tier]})
              </h3>
              <div className="space-y-3">
                {diagnoses
                  .filter((d) => d.tier === tier)
                  .map((d) => {
                    const rec = recommendations[d.primaryFindingId];
                    return (
                      <DecisionCard
                        key={d.id}
                        diagnosis={d}
                        findings={d.findingIds.map((id) => findings[id]).filter(Boolean)}
                        insights={insightMap}
                        currency={currency}
                        recommendationId={rec?.id}
                        status={rec?.status}
                        note={rec?.note}
                        defaultOpen={false}
                      />
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
        active ? "border-ink-900 bg-ink-900 text-white" : "border-ink-200 bg-white text-ink-600 hover:border-ink-300"
      }`}
    >
      {children}
    </button>
  );
}
