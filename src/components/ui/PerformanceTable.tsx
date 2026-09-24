"use client";

import { useMemo, useState } from "react";
import type { EntityPerformance, MetricKey } from "@/lib/analysis/types";
import { METRIC_META } from "@/lib/analysis/types";
import { getMetric } from "@/lib/analysis/metrics";
import { formatMetric, changeIsGood } from "@/lib/format";
import { DeltaChip } from "./primitives";
import type { Objective, ObjectiveResolution } from "@/lib/analysis/objectives";
import { OBJECTIVES, metricLabel, objectiveForEntity, objectiveLabel, primaryCostMetric } from "@/lib/analysis/objectives";
import { useRouter } from "next/navigation";
import type { Tier } from "@/lib/analysis/diagnoses";
import { TIER_STYLE } from "@/components/report/tiers";
import { AskButton } from "@/components/assistant/AskButton";

import { healthKey } from "@/components/report/health";
import { CompareEntities } from "@/components/report/CompareEntities";

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
  objectives,
  accountObjective,
  health,
  reportId,
}: {
  entities: EntityPerformance[];
  currency: string;
  availableMetrics: MetricKey[];
  showComparison: boolean;
  levelLabel: string;
  /** When present, rows show their objective and an objective-aware "main KPI" column. */
  objectives?: Record<string, ObjectiveResolution>;
  accountObjective?: Objective | "mixed";
  /** Worst diagnosis tier per entity, keyed by healthKey(). */
  health?: Record<string, Tier>;
  /** Enables correcting campaign objectives in place. */
  reportId?: string;
}) {
  const [sortKey, setSortKey] = useState<MetricKey | "name">("spend");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const selectable = Boolean(objectives);
  const toggleSelected = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : current.length >= 4 ? current : [...current, id],
    );

  const columns = useMemo(
    () =>
      ([
        "spend",
        "impressions",
        "clicks",
        "ctr",
        "cpc",
        "cpm",
        "conversions",
        "cpa",
        "revenue",
        "roas",
        "leads",
        "cpl",
        "landingPageViews",
        "costPerLpv",
        "frequency",
      ] as MetricKey[]).filter(
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
          {selectable ? (selected.length > 0 ? `${selected.length} selected (max 4) · ` : "Tick 2-4 rows to compare · ") : ""}
          {rows.length} of {entities.length} {levelLabel.toLowerCase()}
        </p>
      </div>

      {/* relative: absolutely-positioned descendants (sr-only caption, popovers) must be clipped by this scroller, not widen the page */}
      <div className="relative overflow-x-auto">
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
              {objectives ? (
                <th scope="col" className="whitespace-nowrap px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-ink-600">
                  Main KPI
                </th>
              ) : null}
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
                  className="sticky left-0 z-10 max-w-[260px] bg-white px-4 py-2.5 text-left font-medium text-ink-900"
                >
                  {selectable ? (
                    <input
                      type="checkbox"
                      checked={selected.includes(entity.id)}
                      onChange={() => toggleSelected(entity.id)}
                      disabled={!selected.includes(entity.id) && selected.length >= 4}
                      aria-label={`Select ${entity.name} to compare`}
                      className="no-print float-left mr-2 mt-0.5 h-3.5 w-3.5 rounded border-ink-300"
                    />
                  ) : null}
                  <span className="block truncate" title={entity.name}>
                    {entity.name}
                  </span>
                  {entity.campaign && entity.level !== "campaign" ? (
                    <span className="block truncate text-xs font-normal text-ink-500" title={entity.campaign}>
                      {entity.campaign}
                    </span>
                  ) : null}
                  {objectives ? (
                    <span className="mt-1 flex flex-wrap items-center gap-1">
                      <ObjectiveTag entity={entity} objectives={objectives} accountObjective={accountObjective ?? "mixed"} reportId={reportId} />
                      <HealthTag tier={health?.[healthKey(entity.level, entity.campaign, entity.adset, entity.name)]} />
                      <AskButton focus={{ kind: "entity", entityId: entity.id }} variant="icon" />
                    </span>
                  ) : null}
                </th>
                {objectives ? (
                  <MainKpiCell
                    entity={entity}
                    objective={objectiveForEntity(entity, objectives, accountObjective ?? "mixed")}
                    currency={currency}
                    showComparison={showComparison}
                  />
                ) : null}
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

      {selectable && selected.length >= 2 ? (
        <CompareEntities
          entities={selected.map((id) => entities.find((e) => e.id === id)).filter((e): e is EntityPerformance => Boolean(e))}
          objectives={objectives!}
          accountObjective={accountObjective ?? "mixed"}
          currency={currency}
          onClear={() => setSelected([])}
        />
      ) : null}

      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink-500">
          Nothing matches “{query}”.
        </p>
      ) : null}
    </div>
  );
}

function ObjectiveTag({
  entity,
  objectives,
  accountObjective,
  reportId,
}: {
  entity: EntityPerformance;
  objectives: Record<string, ObjectiveResolution>;
  accountObjective: Objective | "mixed";
  reportId?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const objective = objectiveForEntity(entity, objectives, accountObjective);
  const campaignName = entity.level === "campaign" ? entity.name : entity.campaign;
  const source = campaignName ? objectives[campaignName] : undefined;
  const title = source ? `Objective from ${source.detail}` : undefined;

  // Only campaign rows are editable; ad sets and ads inherit their campaign's objective.
  if (!reportId || entity.level !== "campaign" || objective === "mixed") {
    return (
      <span className="rounded border border-ink-200 bg-ink-50 px-1.5 py-px text-[10px] font-medium text-ink-600" title={title}>
        {objectiveLabel(objective)}
      </span>
    );
  }

  const change = async (value: string) => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/${reportId}/objectives`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign: entity.name, objective: value === "auto" ? null : value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Update failed");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-1">
      <label className="sr-only" htmlFor={`obj-${entity.id}`}>
        Objective for {entity.name}
      </label>
      <select
        id={`obj-${entity.id}`}
        value={source?.source === "user" ? objective : "auto"}
        disabled={pending}
        onChange={(e) => void change(e.target.value)}
        title={`${title ?? ""}. Change it if AdMate got it wrong - the report is re-analysed with your choice.`}
        className="rounded border border-ink-200 bg-ink-50 py-px pl-1 pr-4 text-[10px] font-medium text-ink-700"
      >
        <option value="auto">
          {source?.source === "user" ? "Auto-detect" : `${objectiveLabel(objective)} (auto)`}
        </option>
        {OBJECTIVES.map((o) => (
          <option key={o} value={o}>
            {objectiveLabel(o)}
          </option>
        ))}
      </select>
      {pending ? <span className="text-[10px] text-ink-500">Re-analysing…</span> : null}
      {error ? <span className="text-[10px] text-high-700">{error}</span> : null}
    </span>
  );
}

function HealthTag({ tier }: { tier: Tier | undefined }) {
  if (!tier) return null;
  const style = TIER_STYLE[tier];
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[10px] font-medium ${style.chip}`}>
      <span aria-hidden="true">{style.glyph}</span>
      {style.label}
    </span>
  );
}

function MainKpiCell({
  entity,
  objective,
  currency,
  showComparison,
}: {
  entity: EntityPerformance;
  objective: Objective | "mixed";
  currency: string;
  showComparison: boolean;
}) {
  const primary = primaryCostMetric(entity, objective);
  if (!primary) return <td className="px-4 py-2.5 text-right text-ink-300">—</td>;
  const value = getMetric(entity.metrics, primary.cost);
  const delta = showComparison ? entity.periodComparison?.deltas[primary.cost] : undefined;
  return (
    <td className="px-4 py-2.5 text-right tnum">
      <span className="block text-[10px] uppercase tracking-wide text-ink-500">{metricLabel(primary.cost, objective)}</span>
      <span className="font-semibold text-ink-900">{formatMetric(value, primary.cost, currency)}</span>
      {delta?.changePct != null ? (
        <DeltaChip change={delta.changePct} isGood={changeIsGood(primary.cost, delta.changePct)} className="ml-1.5" />
      ) : null}
    </td>
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
