import type { MetricKey, PeriodComparison } from "@/lib/analysis/types";
import { METRIC_META } from "@/lib/analysis/types";
import { formatMetric, changeIsGood } from "@/lib/format";
import { DeltaChip } from "./primitives";

/**
 * A single KPI tile.
 *
 * Renders "—" and an explicit note when the metric is absent from the report,
 * rather than showing a zero. A zero and a missing value mean different things
 * and the tile must not blur them.
 */
export function KpiCard({
  metric,
  value,
  currency,
  comparison,
}: {
  metric: MetricKey;
  value: number | null;
  currency: string;
  comparison?: PeriodComparison;
}) {
  const meta = METRIC_META[metric];
  const delta = comparison?.deltas[metric];
  const change = delta?.changePct ?? null;

  return (
    <div className="rounded-xl border border-ink-200 bg-white px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{meta.label}</p>
      </div>
      <p className="mt-1.5 text-xl font-semibold text-ink-900 tnum sm:text-2xl">
        {formatMetric(value, metric, currency)}
      </p>
      <div className="mt-1.5 flex items-center gap-2">
        {value === null ? (
          <span className="text-xs text-ink-400">Not in this report</span>
        ) : change !== null ? (
          <>
            <DeltaChip change={change} isGood={changeIsGood(metric, change)} />
            <span className="text-xs text-ink-400">vs prior period</span>
          </>
        ) : (
          <span className="text-xs text-ink-400">{meta.description}</span>
        )}
      </div>
    </div>
  );
}

export function KpiGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{children}</div>
  );
}
