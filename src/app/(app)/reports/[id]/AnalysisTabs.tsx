"use client";

import { useState } from "react";
import type { EntityLevel, MetricKey, TrendPoint } from "@/lib/analysis/types";
import type { PerformanceModel } from "@/lib/analysis/metrics";
import { Card, CardHeader } from "@/components/ui/primitives";
import { PerformanceTable } from "@/components/ui/PerformanceTable";
import { TrendChart } from "@/components/ui/TrendChart";
import type { Objective, ObjectiveResolution } from "@/lib/analysis/objectives";
import type { Tier } from "@/lib/analysis/diagnoses";

const LEVEL_LABELS: Record<EntityLevel, string> = {
  account: "Account",
  campaign: "Campaigns",
  adset: "Ad sets / ad groups",
  ad: "Ads",
};

/**
 * Level-by-level performance explorer.
 *
 * Only the levels actually present in the uploaded file get a tab — a Google
 * Search export with no ad-level rows does not show an empty "Ads" tab, and a
 * report without dates does not show a trend section at all.
 */
export function AnalysisTabs({
  model,
  currency,
  availableMetrics,
  accountTrend,
  objectives,
  accountObjective,
  health,
  reportId,
}: {
  model: PerformanceModel;
  currency: string;
  availableMetrics: MetricKey[];
  accountTrend: TrendPoint[];
  objectives?: Record<string, ObjectiveResolution>;
  accountObjective?: Objective | "mixed";
  health?: Record<string, Tier>;
  reportId?: string;
}) {
  const levels = model.levelsPresent.filter((l) => l !== "account");
  const [level, setLevel] = useState<EntityLevel>(levels[0] ?? "account");

  const entities =
    level === "campaign" ? model.campaigns : level === "adset" ? model.adsets : level === "ad" ? model.ads : [];

  return (
    <div className="space-y-6">
      {accountTrend.length > 1 ? (
        <Card>
          <CardHeader
            title="Performance over time"
            description="Account totals per day, from the dates in your file."
          />
          <TrendChart
            trend={accountTrend}
            currency={currency}
            availableMetrics={availableMetrics}
            defaultPrimary="spend"
            defaultSecondary={availableMetrics.includes("conversions") ? "conversions" : "clicks"}
          />
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Performance breakdown"
          description={
            model.hasDates
              ? "Sort by any column. Change chips compare the most recent half of the reporting period against the half before it."
              : "Sort by any column. This report has no dates, so no period-over-period comparison is available."
          }
          action={
            levels.length > 1 ? (
              <div className="flex gap-1 rounded-lg bg-ink-100 p-0.5" role="tablist" aria-label="Entity level">
                {levels.map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="tab"
                    aria-selected={level === l}
                    onClick={() => setLevel(l)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      level === l ? "bg-white text-ink-900 shadow-sm" : "text-ink-600 hover:text-ink-900"
                    }`}
                  >
                    {LEVEL_LABELS[l]}
                  </button>
                ))}
              </div>
            ) : null
          }
        />
        <PerformanceTable
          key={level}
          entities={entities}
          currency={currency}
          availableMetrics={availableMetrics}
          showComparison={model.hasDates}
          levelLabel={LEVEL_LABELS[level]}
          objectives={objectives}
          accountObjective={accountObjective}
          health={health}
          reportId={reportId}
        />
      </Card>
    </div>
  );
}
