import type {
  BaseMetric,
  DerivedMetric,
  EntityLevel,
  EntityPerformance,
  MetricKey,
  MetricSet,
  NormalizedRow,
  PeriodComparison,
  PeriodDelta,
  TrendPoint,
} from "./types";
import { BASE_METRICS, DERIVED_METRICS } from "./types";

/**
 * Deterministic metric maths.
 *
 * Nothing in this file guesses. A derived metric is produced only when every
 * input it needs is a real reported number, and division by zero yields `null`
 * rather than Infinity - "CPA of infinity" is not a finding, "spend with zero
 * conversions" is, and that is detected explicitly elsewhere.
 */

/** Sums a base metric across rows. Returns null if no row reported it. */
function sumMetric(rows: NormalizedRow[], metric: BaseMetric): number | null {
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const v = row.metrics[metric];
    if (typeof v === "number") {
      total += v;
      seen = true;
    }
  }
  return seen ? total : null;
}

/**
 * Frequency is a ratio, not a total - summing it is meaningless. Recompute it
 * from impressions/reach when possible, otherwise take a spend-weighted mean.
 */
function aggregateFrequency(rows: NormalizedRow[]): number | null {
  const impressions = sumMetric(rows, "impressions");
  const reach = sumMetric(rows, "reach");
  if (impressions !== null && reach !== null && reach > 0) return impressions / reach;

  let weighted = 0;
  let weight = 0;
  for (const row of rows) {
    const f = row.metrics.frequency;
    if (typeof f !== "number") continue;
    const w = typeof row.metrics.impressions === "number" ? row.metrics.impressions : 1;
    weighted += f * w;
    weight += w;
  }
  return weight > 0 ? weighted / weight : null;
}

function safeDivide(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null;
  if (denominator === 0) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

export function deriveMetrics(base: Partial<Record<BaseMetric, number | null>>): Partial<
  Record<DerivedMetric, number | null>
> {
  const get = (m: BaseMetric) => (base[m] === undefined ? null : base[m]!);
  const impressions = get("impressions");
  const clicks = get("clicks");
  const spend = get("spend");
  const conversions = get("conversions");
  const revenue = get("revenue");
  const leads = get("leads");
  const lpv = get("landingPageViews");
  const engagements = get("engagements");
  const thruplays = get("thruplays");

  const derived: Partial<Record<DerivedMetric, number | null>> = {};
  const set = (k: DerivedMetric, v: number | null) => {
    if (v !== null) derived[k] = v;
  };

  set("ctr", safeDivide(clicks, impressions));
  set("cpc", safeDivide(spend, clicks));
  set("cpm", impressions !== null && impressions > 0 && spend !== null ? (spend / impressions) * 1000 : null);
  set("cpa", safeDivide(spend, conversions));
  set("roas", safeDivide(revenue, spend));
  set("cvr", safeDivide(conversions, clicks));
  set("aov", safeDivide(revenue, conversions));
  set("cpl", safeDivide(spend, leads));
  set("leadRate", safeDivide(leads, clicks));
  set("costPerLpv", safeDivide(spend, lpv));
  set("cpe", safeDivide(spend, engagements));
  set("engagementRate", safeDivide(engagements, impressions));
  set("costPerThruplay", safeDivide(spend, thruplays));

  return derived;
}

export function aggregate(rows: NormalizedRow[]): MetricSet {
  const base: Partial<Record<BaseMetric, number | null>> = {};
  for (const metric of BASE_METRICS) {
    if (metric === "frequency") continue;
    const v = sumMetric(rows, metric);
    if (v !== null) base[metric] = v;
  }
  const freq = aggregateFrequency(rows);
  if (freq !== null) base.frequency = freq;

  return { base, derived: deriveMetrics(base) };
}

export function getMetric(set: MetricSet, key: MetricKey): number | null {
  if ((BASE_METRICS as string[]).includes(key)) {
    const v = set.base[key as BaseMetric];
    return v === undefined ? null : v;
  }
  const v = set.derived[key as DerivedMetric];
  return v === undefined ? null : v;
}

/* -------------------------------------------------------------------------- */
/* Entity roll-ups                                                            */
/* -------------------------------------------------------------------------- */

const UNNAMED = "(not set)";

function entityKeyFor(row: NormalizedRow, level: EntityLevel): string | null {
  if (level === "account") return "__account__";
  if (level === "campaign") return row.campaign ?? (row.adset || row.ad ? UNNAMED : null);
  if (level === "adset") return row.adset === null ? null : `${row.campaign ?? UNNAMED}\u0000${row.adset}`;
  return row.ad === null ? null : `${row.campaign ?? UNNAMED}\u0000${row.adset ?? UNNAMED}\u0000${row.ad}`;
}

function displayName(row: NormalizedRow, level: EntityLevel): string {
  if (level === "account") return "Account total";
  if (level === "campaign") return row.campaign ?? UNNAMED;
  if (level === "adset") return row.adset ?? UNNAMED;
  return row.ad ?? UNNAMED;
}

export function buildTrend(rows: NormalizedRow[]): TrendPoint[] {
  const byDate = new Map<string, NormalizedRow[]>();
  for (const row of rows) {
    if (row.date === null) continue;
    const bucket = byDate.get(row.date);
    if (bucket) bucket.push(row);
    else byDate.set(row.date, [row]);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, dateRows]) => ({ date, metrics: aggregate(dateRows) }));
}

/** The two halves of the reporting window used for every period comparison. */
export interface PeriodSplit {
  previousDays: string[];
  currentDays: string[];
  /** A middle day left out so both halves have the same number of days. */
  excludedDay: string | null;
}

/**
 * Splits the reporting window into two equal halves. Returns null when there
 * are fewer than 4 distinct days - with less data the "change" is noise, and
 * reporting it as a trend would be misleading.
 */
export function splitPeriods(rows: NormalizedRow[]): PeriodSplit | null {
  const days = [...new Set(rows.filter((r) => r.date !== null).map((r) => r.date as string))].sort();
  if (days.length < 4) return null;
  const half = Math.floor(days.length / 2);
  return {
    previousDays: days.slice(0, half),
    currentDays: days.slice(days.length - half),
    excludedDay: days.length % 2 === 1 ? days[half] : null,
  };
}

/**
 * Compares the two halves of the reporting window.
 *
 * Pass the account-level `split` when comparing an entity: every campaign, ad
 * set and ad must be compared over the *same* dates as the account, otherwise
 * an ad launched mid-report gets its own private "halves" and its change
 * cannot be added up against anything else.
 */
export function comparePeriods(rows: NormalizedRow[], split?: PeriodSplit | null): PeriodComparison | null {
  const s = split === undefined ? splitPeriods(rows) : split;
  if (!s) return null;

  const previousDays = new Set(s.previousDays);
  const currentDays = new Set(s.currentDays);
  const dated = rows.filter((r) => r.date !== null);
  const previousRows = dated.filter((r) => previousDays.has(r.date as string));
  const currentRows = dated.filter((r) => currentDays.has(r.date as string));
  // One empty half is still a comparison (an ad launched or paused mid-report);
  // its missing side reads as "not reported" rather than as zero.
  if (previousRows.length === 0 && currentRows.length === 0) return null;

  const current = aggregate(currentRows);
  const previous = aggregate(previousRows);

  const deltas: Partial<Record<MetricKey, PeriodDelta>> = {};
  const allKeys: MetricKey[] = [...BASE_METRICS, ...DERIVED_METRICS];
  for (const metric of allKeys) {
    const c = getMetric(current, metric);
    const p = getMetric(previous, metric);
    if (c === null && p === null) continue;
    deltas[metric] = {
      metric,
      current: c,
      previous: p,
      absoluteChange: c !== null && p !== null ? c - p : null,
      changePct: c !== null && p !== null && p !== 0 ? (c - p) / Math.abs(p) : null,
    };
  }

  const half = s.currentDays.length;
  return {
    currentLabel: `Last ${half} day${half === 1 ? "" : "s"}`,
    previousLabel: `Prior ${half} day${half === 1 ? "" : "s"}`,
    previousStart: s.previousDays[0],
    previousEnd: s.previousDays[s.previousDays.length - 1],
    currentStart: s.currentDays[0],
    currentEnd: s.currentDays[s.currentDays.length - 1],
    currentDays: s.currentDays.length,
    previousDays: s.previousDays.length,
    excludedDay: s.excludedDay,
    deltas,
  };
}

export interface PerformanceModel {
  account: EntityPerformance;
  campaigns: EntityPerformance[];
  adsets: EntityPerformance[];
  ads: EntityPerformance[];
  levelsPresent: EntityLevel[];
  hasDates: boolean;
  /** The date split every period comparison in this model uses. */
  split?: PeriodSplit | null;
}

function buildLevel(
  rows: NormalizedRow[],
  level: EntityLevel,
  withTrend: boolean,
  split: PeriodSplit | null,
): EntityPerformance[] {
  const groups = new Map<string, NormalizedRow[]>();
  for (const row of rows) {
    const key = entityKeyFor(row, level);
    if (key === null) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const out: EntityPerformance[] = [];
  for (const [key, groupRows] of groups) {
    const first = groupRows[0];
    const entity: EntityPerformance = {
      id: `${level}:${key}`,
      level,
      name: displayName(first, level),
      campaign: level === "account" ? null : first.campaign,
      adset: level === "ad" || level === "adset" ? first.adset : null,
      rowCount: groupRows.length,
      metrics: aggregate(groupRows),
    };
    if (withTrend) {
      const trend = buildTrend(groupRows);
      if (trend.length > 1) entity.trend = trend;
      const comparison = comparePeriods(groupRows, split);
      if (comparison) entity.periodComparison = comparison;
    }
    out.push(entity);
  }

  // Biggest spender first - that is where money is at risk.
  out.sort((a, b) => (getMetric(b.metrics, "spend") ?? 0) - (getMetric(a.metrics, "spend") ?? 0));
  return out;
}

export function buildPerformanceModel(rows: NormalizedRow[]): PerformanceModel {
  const hasDates = rows.some((r) => r.date !== null);
  const split = hasDates ? splitPeriods(rows) : null;

  const account = buildLevel(rows, "account", hasDates, split)[0] ?? {
    id: "account:__account__",
    level: "account" as const,
    name: "Account total",
    campaign: null,
    adset: null,
    rowCount: 0,
    metrics: { base: {}, derived: {} },
  };

  const campaigns = buildLevel(rows, "campaign", hasDates, split);
  const adsets = buildLevel(rows, "adset", hasDates, split);
  const ads = buildLevel(rows, "ad", hasDates, split);

  const levelsPresent: EntityLevel[] = ["account"];
  if (campaigns.length > 0) levelsPresent.push("campaign");
  if (adsets.length > 0) levelsPresent.push("adset");
  if (ads.length > 0) levelsPresent.push("ad");

  return { account, campaigns, adsets, ads, levelsPresent, hasDates, split };
}

/* -------------------------------------------------------------------------- */
/* Statistics used by the detectors                                           */
/* -------------------------------------------------------------------------- */

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Spend-weighted mean. Comparing a campaign against the *weighted* account
 * average avoids a £5 test campaign dragging the benchmark around.
 */
export function weightedMean(pairs: { value: number; weight: number }[]): number | null {
  let total = 0;
  let weight = 0;
  for (const p of pairs) {
    if (!Number.isFinite(p.value) || !Number.isFinite(p.weight) || p.weight <= 0) continue;
    total += p.value * p.weight;
    weight += p.weight;
  }
  return weight > 0 ? total / weight : null;
}

/** Median absolute deviation - robust to the outliers we are hunting for. */
export function mad(values: number[]): number | null {
  const med = median(values);
  if (med === null) return null;
  return median(values.map((v) => Math.abs(v - med)));
}

/**
 * Robust z-score using the MAD. Falls back to null when the sample is too
 * small or has no spread, so detectors do not fire on flat data.
 */
export function robustZ(value: number, values: number[]): number | null {
  if (values.length < 4) return null;
  const med = median(values);
  const dev = mad(values);
  if (med === null || dev === null || dev === 0) return null;
  return (value - med) / (1.4826 * dev);
}
