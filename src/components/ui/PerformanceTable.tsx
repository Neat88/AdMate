"use client";

import { useMemo, useState } from "react";
import type { EntityPerformance, MetricKey } from "@/lib/analysis/types";
import { METRIC_META } from "@/lib/analysis/types";
import { getMetric } from "@/lib/analysis/metrics";
import { formatMetric, changeIsGood } from "@/lib/format";
import { DeltaChip } from "./primitives";

/**
 * Sortable, filterable entity table.
 *
 * Columns are chosen from the metrics actually present, so a report without
 * conversions simply has no CPA column rather than a column of dashes.
 */
export function PerformanceTable({
  entities,
  currency,
  availableMetrics,
  showComparison,
  levelLabel,
}: {
  entities: EntityPerformance[];
  currency: string;
  availableMetrics: MetricKey[];
  showComparison: boolean;
  levelLabel: string;
}) {
  const [sortKey, setSortKey] = useState<MetricKey | "name">("spend");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [query, setQuery] = useState("");

  const columns = useMemo(
    () =>
      (["spend", "impressions", "clicks", "ctr", "cpc", "cpm", "conversions", "cpa", "revenue", "roas", "frequency"] as MetricKey[]).filter(
        (m) => availableMetrics.includes(m),
      ),
    [availableMetrics],
  );

  const rows = useMemo(() => {
    const filtered = query
      ? entities.filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
      : entities;

    return [...filtered].sort((a, b) => {
      if (sortKey === "name") {
        return sortDir === "asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      }
      const av = getMetric(a.metrics, sortKey);
      const bv = getMetric(b.metrics, sortKey);
      // Missing values always sort last, regardless of direction - they are
      // absent data, not the smallest value.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }, [entities, query, sortKey, sortDir]);

  const toggleSort = (key: MetricKey | "name") => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  if (entities.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-sm text-ink-500">
        This report does not contain {levelLabel.toLowerCase()}-level data.
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">Filter {levelLabel}</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Filter ${levelLabel.toLowerCase()}…`}
            className="w-56 rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm placeholder:text-ink-400"
          />
        </label>
        <p className="text-xs text-ink-500 tnum">
          {rows.length} of {entities.length} {levelLabel.toLowerCase()}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-t border-ink-200 text-sm">
          <caption className="sr-only">
            {levelLabel} performance, sortable by any metric column
          </caption>
          <thead>
            <tr className="bg-ink-50 text-left">
              <SortHeader
                label={levelLabel}
                active={sortKey === "name"}
                dir={sortDir}
                onClick={() => toggleSort("name")}
                align="left"
                sticky
              />
              {columns.map((m) => (
                <SortHeader
                  key={m}
                  label={METRIC_META[m].label}
                  active={sortKey === m}
                  dir={sortDir}
                  onClick={() => toggleSort(m)}
                  align="right"
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((entity) => (
              <tr key={entity.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/60">
                <th
                  scope="row"
                  className="sticky left-0 z-10 max-w-[240px] bg-white px-4 py-2.5 text-left font-medium text-ink-900"
                >
                  <span className="block truncate" title={entity.name}>
                    {entity.name}
                  </span>
                  {entity.campaign && entity.level !== "campaign" ? (
                    <span className="block truncate text-xs font-normal text-ink-500" title={entity.campaign}>
                      {entity.campaign}
                    </span>
                  ) : null}
                </th>
                {columns.map((m) => {
                  const value = getMetric(entity.metrics, m);
                  const delta = showComparison ? entity.periodComparison?.deltas[m] : undefined;
                  return (
                    <td key={m} className="px-4 py-2.5 text-right tnum">
                      <span className={value === null ? "text-ink-300" : "text-ink-800"}>
                        {formatMetric(value, m, currency)}
                      </span>
                      {delta?.changePct != null ? (
                        <DeltaChip
                          change={delta.changePct}
                          isGood={changeIsGood(m, delta.changePct)}
                          className="ml-1.5"
                        />
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink-500">
          Nothing matches “{query}”.
        </p>
      ) : null}
    </div>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  align,
  sticky = false,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align: "left" | "right";
  sticky?: boolean;
}) {
  return (
    <th
      scope="col"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`${sticky ? "sticky left-0 z-10 bg-ink-50" : ""} whitespace-nowrap px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-600`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-1 ${align === "right" ? "justify-end" : "justify-start"} hover:text-ink-900`}
      >
        {label}
        <span aria-hidden="true" className={active ? "text-ink-700" : "text-ink-300"}>
          {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}
