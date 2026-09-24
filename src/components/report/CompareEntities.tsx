"use client";

import type { EntityPerformance, MetricKey } from "@/lib/analysis/types";
import { METRIC_META } from "@/lib/analysis/types";
import { getMetric } from "@/lib/analysis/metrics";
import {
  OBJECTIVE_PROFILES,
  metricLabel,
  objectiveForEntity,
  objectiveLabel,
  type Objective,
  type ObjectiveResolution,
} from "@/lib/analysis/objectives";
import { formatMetric } from "@/lib/format";
import { AskButton } from "@/components/assistant/AskButton";

/**
 * Side-by-side view of 2-4 selected entities. Rows are the metrics their
 * objective is judged on; the best value per row is marked (with a label, not
 * just colour). Mixing objectives is allowed but flagged as not like-for-like.
 */
export function CompareEntities({
  entities,
  objectives,
  accountObjective,
  currency,
  onClear,
}: {
  entities: EntityPerformance[];
  objectives: Record<string, ObjectiveResolution>;
  accountObjective: Objective | "mixed";
  currency: string;
  onClear: () => void;
}) {
  const objs = entities.map((e) => objectiveForEntity(e, objectives, accountObjective));
  const sameObjective = objs.every((o) => o === objs[0]);
  const base = objs[0];
  const metrics: MetricKey[] = [
    "spend",
    ...(sameObjective && base !== "mixed" ? OBJECTIVE_PROFILES[base].keyMetrics : ["ctr", "cpc", "cpm"]),
    "frequency",
  ].filter((m, i, all) => all.indexOf(m) === i && entities.some((e) => getMetric(e.metrics, m as MetricKey) !== null)) as MetricKey[];

  const best = (m: MetricKey): string | null => {
    const dir = METRIC_META[m].higherIsBetter;
    if (dir === null) return null;
    let winner: EntityPerformance | null = null;
    for (const e of entities) {
      const v = getMetric(e.metrics, m);
      if (v === null) continue;
      const w = winner ? getMetric(winner.metrics, m) : null;
      if (w === null || (dir ? v > w : v < w)) winner = e;
    }
    return winner?.id ?? null;
  };

  const question = `Compare ${entities.map((e) => e.name).join(" and ")}. Which is doing better, and why?`;

  return (
    <div className="border-t border-ink-200 bg-ink-50/60 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">Side by side</h3>
        <div className="flex items-center gap-2">
          <AskButton focus={{ kind: "entity", entityId: entities[0].id }} question={question} label="Ask AdMate to compare" />
          <button type="button" onClick={onClear} className="text-xs font-medium text-ink-600 hover:text-ink-900">
            Clear selection
          </button>
        </div>
      </div>
      {!sameObjective ? (
        <p className="mt-2 rounded-lg border border-med-200 bg-med-50 px-3 py-2 text-xs text-med-700">
          These have different objectives ({[...new Set(objs)].map((o) => objectiveLabel(o)).join(", ")}), so this is not a
          like-for-like comparison - only delivery metrics are shown.
        </p>
      ) : null}
      <div className="relative mt-3 overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <caption className="sr-only">Selected entities compared metric by metric</caption>
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-ink-600">
              <th scope="col" className="py-1.5 pr-4">Metric</th>
              {entities.map((e) => (
                <th key={e.id} scope="col" className="max-w-[180px] truncate py-1.5 pr-4 text-right" title={e.name}>
                  {e.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => {
              const winner = best(m);
              return (
                <tr key={m} className="border-t border-ink-200">
                  <th scope="row" className="py-1.5 pr-4 text-left font-normal text-ink-700">
                    {metricLabel(m, sameObjective ? base : null)}
                  </th>
                  {entities.map((e) => (
                    <td key={e.id} className={`py-1.5 pr-4 text-right tnum ${winner === e.id ? "font-semibold text-good-700" : "text-ink-800"}`}>
                      {formatMetric(getMetric(e.metrics, m), m, currency)}
                      {winner === e.id ? <span className="ml-1 text-[10px] font-medium">best</span> : null}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
