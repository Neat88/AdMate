import type { BaseMetric, EntityPerformance, MetricKey, PeriodComparison } from "./types";
import { getMetric, type PerformanceModel } from "./metrics";

/**
 * "Which campaign / ad set / ad is driving this change?"
 *
 * For any ratio metric R = N / D (CPA = spend / conversions, CTR = clicks /
 * impressions, ...) the change between two periods splits *exactly* into one
 * additive contribution per child:
 *
 *     R' - R = Σ_i (ΔN_i - R·ΔD_i) / D'
 *
 * where R is the parent's previous value and D' its current denominator. In
 * words: a child pushes CPA up by the extra spend it took beyond what its
 * extra conversions would have cost at the old CPA. The identity holds for
 * children that are new, paused, or recorded zero conversions, which is why it
 * is used here instead of averaging per-child ratios.
 *
 * Each contribution further splits into
 *   - a rate effect: the child itself got better or worse, and
 *   - a mix effect: budget moved toward (or away from) a child that was
 *     already better or worse than the parent average.
 * That distinction maps onto different actions (fix the ad vs. move budget).
 */

export interface RatioDefinition {
  metric: MetricKey;
  numerator: BaseMetric;
  denominator: BaseMetric;
  scale: number;
  /** True for costs: an increase is bad. */
  higherIsWorse: boolean;
}

export const RATIO_DEFINITIONS: Partial<Record<MetricKey, RatioDefinition>> = {
  cpa: { metric: "cpa", numerator: "spend", denominator: "conversions", scale: 1, higherIsWorse: true },
  cpl: { metric: "cpl", numerator: "spend", denominator: "leads", scale: 1, higherIsWorse: true },
  cpc: { metric: "cpc", numerator: "spend", denominator: "clicks", scale: 1, higherIsWorse: true },
  cpm: { metric: "cpm", numerator: "spend", denominator: "impressions", scale: 1000, higherIsWorse: true },
  costPerLpv: { metric: "costPerLpv", numerator: "spend", denominator: "landingPageViews", scale: 1, higherIsWorse: true },
  cpe: { metric: "cpe", numerator: "spend", denominator: "engagements", scale: 1, higherIsWorse: true },
  costPerThruplay: { metric: "costPerThruplay", numerator: "spend", denominator: "thruplays", scale: 1, higherIsWorse: true },
  ctr: { metric: "ctr", numerator: "clicks", denominator: "impressions", scale: 1, higherIsWorse: false },
  cvr: { metric: "cvr", numerator: "conversions", denominator: "clicks", scale: 1, higherIsWorse: false },
  roas: { metric: "roas", numerator: "revenue", denominator: "spend", scale: 1, higherIsWorse: false },
};

export interface DriverContribution {
  entityId: string;
  name: string;
  level: EntityPerformance["level"];
  /** Change in the parent metric attributable to this child, in metric units. */
  contribution: number;
  /** contribution / total change. 0.64 means "64% of the change". Null when the change is ~0. */
  shareOfChange: number | null;
  rateEffect: number | null;
  mixEffect: number | null;
  previousValue: number | null;
  currentValue: number | null;
  previousNumerator: number;
  currentNumerator: number;
  previousDenominator: number;
  currentDenominator: number;
  /** Current-period share of the parent's numerator (usually spend share). */
  currentShare: number | null;
}

export interface DriverAnalysis {
  metric: MetricKey;
  parentId: string;
  parentName: string;
  parentLevel: EntityPerformance["level"];
  childLevel: EntityPerformance["level"];
  previousValue: number;
  currentValue: number;
  change: number;
  changePct: number | null;
  /** True when the movement is in the bad direction for this metric. */
  worsened: boolean;
  /** Children ordered by how much they pushed in the direction of the change. */
  contributions: DriverContribution[];
  /** Change not explained by the listed children (rows without a child name). */
  unexplained: number;
  previousLabel: string;
  currentLabel: string;
}

function base(comparison: PeriodComparison | undefined, metric: BaseMetric, which: "current" | "previous"): number | null {
  const d = comparison?.deltas[metric];
  if (!d) return null;
  const v = which === "current" ? d.current : d.previous;
  return v === undefined ? null : v;
}

export function childrenOf(model: PerformanceModel, parent: EntityPerformance): EntityPerformance[] {
  if (parent.level === "account") {
    if (model.campaigns.length > 0) return model.campaigns;
    if (model.adsets.length > 0) return model.adsets;
    return model.ads;
  }
  if (parent.level === "campaign") {
    const adsets = model.adsets.filter((a) => a.campaign === parent.name);
    if (adsets.length > 0) return adsets;
    return model.ads.filter((a) => a.campaign === parent.name);
  }
  if (parent.level === "adset") {
    return model.ads.filter((a) => a.campaign === parent.campaign && a.adset === parent.name);
  }
  return [];
}

export function analyzeDrivers(
  model: PerformanceModel,
  parent: EntityPerformance,
  metric: MetricKey,
  explicitChildren?: EntityPerformance[],
): DriverAnalysis | null {
  const def = RATIO_DEFINITIONS[metric];
  const comparison = parent.periodComparison;
  if (!def || !comparison) return null;

  const N = base(comparison, def.numerator, "previous");
  const D = base(comparison, def.denominator, "previous");
  const N2 = base(comparison, def.numerator, "current");
  const D2 = base(comparison, def.denominator, "current");
  if (N === null || D === null || N2 === null || D2 === null || D <= 0 || D2 <= 0) return null;

  const R = N / D;
  const R2 = N2 / D2;
  const change = (R2 - R) * def.scale;

  const children = explicitChildren ?? childrenOf(model, parent);
  if (children.length < 2) return null;

  const contributions: DriverContribution[] = [];
  let explained = 0;
  for (const child of children) {
    const c = child.periodComparison;
    // A child with no comparison had no rows in either half; its numbers are all zero.
    const n = base(c, def.numerator, "previous") ?? 0;
    const d = base(c, def.denominator, "previous") ?? 0;
    const n2 = base(c, def.numerator, "current") ?? 0;
    const d2 = base(c, def.denominator, "current") ?? 0;
    if (n === 0 && d === 0 && n2 === 0 && d2 === 0) continue;

    const contribution = (((n2 - n) - R * (d2 - d)) / D2) * def.scale;
    explained += contribution;

    let rateEffect: number | null = null;
    let mixEffect: number | null = null;
    if (d > 0 && d2 > 0) {
      const r = n / d;
      const r2 = n2 / d2;
      rateEffect = ((d2 * (r2 - r)) / D2) * def.scale;
      mixEffect = contribution - rateEffect;
    }

    contributions.push({
      entityId: child.id,
      name: child.name,
      level: child.level,
      contribution,
      shareOfChange: Math.abs(change) > 1e-12 ? contribution / change : null,
      rateEffect,
      mixEffect,
      previousValue: d > 0 ? (n / d) * def.scale : null,
      currentValue: d2 > 0 ? (n2 / d2) * def.scale : null,
      previousNumerator: n,
      currentNumerator: n2,
      previousDenominator: d,
      currentDenominator: d2,
      currentShare: N2 > 0 ? n2 / N2 : null,
    });
  }
  if (contributions.length === 0) return null;

  // Biggest push in the direction of the overall change first.
  const direction = change >= 0 ? 1 : -1;
  contributions.sort((a, b) => direction * (b.contribution - a.contribution));

  return {
    metric,
    parentId: parent.id,
    parentName: parent.name,
    parentLevel: parent.level,
    childLevel: contributions[0].level,
    previousValue: R * def.scale,
    currentValue: R2 * def.scale,
    change,
    changePct: R !== 0 ? (R2 - R) / Math.abs(R) : null,
    worsened: def.higherIsWorse ? change > 0 : change < 0,
    contributions,
    unexplained: change - explained,
    previousLabel: comparison.previousLabel,
    currentLabel: comparison.currentLabel,
  };
}

/**
 * The children that account for most of a change - enough of them to cover
 * `coverage` of the movement, capped at `max`. Only children pushing in the
 * direction of the change are returned.
 */
export function mainDrivers(analysis: DriverAnalysis, coverage = 0.7, max = 3): DriverContribution[] {
  const out: DriverContribution[] = [];
  let covered = 0;
  for (const c of analysis.contributions) {
    if (c.shareOfChange === null || c.shareOfChange <= 0.05) break;
    out.push(c);
    covered += c.shareOfChange;
    if (covered >= coverage || out.length >= max) break;
  }
  return out;
}

/** Whether a contribution is mostly the child getting worse (rate) or budget moving (mix). */
export function driverKind(c: DriverContribution): "rate" | "mix" | "new" {
  if (c.rateEffect === null || c.mixEffect === null) return c.previousDenominator === 0 ? "new" : "rate";
  return Math.abs(c.rateEffect) >= Math.abs(c.mixEffect) ? "rate" : "mix";
}

/** Metric value for display, falling back to the aggregate when there is no comparison. */
export function currentMetric(entity: EntityPerformance, metric: MetricKey): number | null {
  return entity.periodComparison?.deltas[metric]?.current ?? getMetric(entity.metrics, metric);
}

/**
 * A synthetic parent covering only some campaigns - used for mixed-objective
 * accounts, where "account CPA" would divide sales-campaign spend plus
 * awareness spend by sales conversions and mean nothing.
 */
export function groupEntity(id: string, name: string, members: EntityPerformance[]): EntityPerformance {
  const sum = (pick: (e: EntityPerformance) => Partial<Record<BaseMetric, number | null>>) => {
    const out: Partial<Record<BaseMetric, number | null>> = {};
    for (const e of members) {
      for (const [k, v] of Object.entries(pick(e)) as [BaseMetric, number | null][]) {
        if (k === "frequency" || v === null || v === undefined) continue;
        out[k] = (out[k] ?? 0) + v;
      }
    }
    return out;
  };
  const base = sum((e) => e.metrics.base);
  const withComparison = members.filter((m) => m.periodComparison);
  const first = withComparison[0]?.periodComparison;
  let periodComparison: PeriodComparison | undefined;
  if (first) {
    const prev = sum((e) => Object.fromEntries(Object.entries(e.periodComparison?.deltas ?? {}).map(([k, d]) => [k, d?.previous ?? null])));
    const curr = sum((e) => Object.fromEntries(Object.entries(e.periodComparison?.deltas ?? {}).map(([k, d]) => [k, d?.current ?? null])));
    const deltas: PeriodComparison["deltas"] = {};
    for (const k of new Set([...Object.keys(prev), ...Object.keys(curr)]) as Set<BaseMetric>) {
      const p = prev[k] ?? null;
      const c = curr[k] ?? null;
      deltas[k] = { metric: k, previous: p, current: c, absoluteChange: p !== null && c !== null ? c - p : null, changePct: p && c !== null ? (c - p) / Math.abs(p) : null };
    }
    periodComparison = { ...first, deltas };
  }
  return {
    id,
    level: "account",
    name,
    campaign: null,
    adset: null,
    rowCount: members.reduce((n, m) => n + m.rowCount, 0),
    metrics: { base, derived: {} },
    periodComparison,
  };
}
