import type { EntityPerformance, MetricKey, PeriodComparison, PeriodDelta } from "./types";
import { BASE_METRICS, DERIVED_METRICS, METRIC_META } from "./types";
import { deriveMetrics, getMetric, type PerformanceModel } from "./metrics";
import { groupEntity } from "./drivers";
import { movementSignificance, type EvidenceStrength } from "./detectors";
import type { ReportFacts } from "./facts";
import { OBJECTIVE_PROFILES, objectiveForEntity, primaryCostMetric, type Objective } from "./objectives";

/**
 * Report-over-report comparison.
 *
 * Within one file, "previous period" can only mean the first half of it. Once
 * a user uploads regularly, the honest baseline is their previous upload for
 * the same workspace and platform. This compares the two at account level
 * and campaign by campaign (matched by name), and runs the same statistical
 * test the detectors use, so "CPA up 18% vs last upload" comes with a view on
 * whether that is more than noise.
 */

export interface ReportRef {
  id: string;
  filename: string;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
}

export interface MetricChange {
  metric: MetricKey;
  previous: number | null;
  current: number | null;
  changePct: number | null;
  /** Only for metrics that are rates of countable events. */
  strength: EvidenceStrength | null;
  /** True when the change is in the bad direction for this metric. */
  worsened: boolean | null;
  /** Totals are shown as daily averages when the two uploads cover different numbers of days. */
  perDay: boolean;
  /** Set when the figure covers only some campaigns, e.g. "Sales / conversions campaigns". */
  scope?: string | null;
}

export interface CampaignChange {
  name: string;
  objective: Objective | "mixed";
  costMetric: MetricKey | null;
  spend: MetricChange;
  cost: MetricChange | null;
}

export interface HistoryComparison {
  previous: ReportRef;
  previousDays: number | null;
  currentDays: number | null;
  /** "previous upload" labels, e.g. "Aug 11 - Aug 24". */
  account: MetricChange[];
  campaigns: CampaignChange[];
  newCampaigns: string[];
  stoppedCampaigns: string[];
}

/** A PeriodComparison built from two whole reports, so the detectors' test can be reused. */
function asComparison(previous: EntityPerformance, current: EntityPerformance): PeriodComparison {
  const deltas: PeriodComparison["deltas"] = {};
  for (const metric of [...BASE_METRICS, ...DERIVED_METRICS] as MetricKey[]) {
    const p = getMetric(previous.metrics, metric);
    const c = getMetric(current.metrics, metric);
    if (p === null && c === null) continue;
    const delta: PeriodDelta = {
      metric,
      previous: p,
      current: c,
      absoluteChange: p !== null && c !== null ? c - p : null,
      changePct: p !== null && c !== null && p !== 0 ? (c - p) / Math.abs(p) : null,
    };
    deltas[metric] = delta;
  }
  return {
    currentLabel: "This upload",
    previousLabel: "Previous upload",
    currentStart: "",
    currentEnd: "",
    previousStart: "",
    previousEnd: "",
    currentDays: 0,
    previousDays: 0,
    deltas,
  };
}

const ADDITIVE = new Set<MetricKey>(["spend", "impressions", "reach", "clicks", "conversions", "revenue", "leads", "landingPageViews", "engagements", "thruplays", "videoViews"]);

function change(
  metric: MetricKey,
  comparison: PeriodComparison,
  days: { previous: number | null; current: number | null },
): MetricChange {
  const d = comparison.deltas[metric];
  const perDay = ADDITIVE.has(metric) && days.previous !== null && days.current !== null && days.previous !== days.current;
  const scale = (v: number | null | undefined, n: number | null) => (v == null ? null : perDay && n ? v / n : v);
  const previous = scale(d?.previous, days.previous);
  const current = scale(d?.current, days.current);
  const pct = previous !== null && current !== null && previous !== 0 ? (current - previous) / Math.abs(previous) : null;
  const dir = METRIC_META[metric].higherIsBetter;
  const worsened = pct === null || dir === null ? null : dir ? pct < 0 : pct > 0;
  const testable = ["cpa", "cpl", "cpc", "cpm", "ctr", "cvr", "leadRate", "roas", "cpe", "costPerThruplay"].includes(metric);
  const strength =
    testable && pct !== null && pct !== 0 ? movementSignificance(metric, comparison, worsened === true).strength : null;
  return { metric, previous, current, changePct: pct, strength, worsened, perDay };
}

function daysIn(model: PerformanceModel, ref: { periodStart: string | null; periodEnd: string | null }): number | null {
  if (ref.periodStart && ref.periodEnd) {
    const ms = Date.parse(ref.periodEnd) - Date.parse(ref.periodStart);
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms / 86_400_000) + 1;
  }
  return model.account.trend?.length || null;
}

export function compareReports(
  current: { model: PerformanceModel; facts: ReportFacts; report: { periodStart: string | null; periodEnd: string | null } },
  previous: { model: PerformanceModel; report: ReportRef },
): HistoryComparison {
  const { model, facts } = current;
  const days = { previous: daysIn(previous.model, previous.report), current: daysIn(model, current.report) };
  const accountComparison = asComparison(previous.model.account, model.account);
  const primary =
    facts.accountObjective === "mixed" ? null : primaryCostMetric(model.account, facts.accountObjective);
  const accountMetrics: MetricKey[] = ["spend"];
  if (primary) accountMetrics.push(primary.result, primary.cost);
  if (facts.accountObjective === "sales") accountMetrics.push("roas");
  accountMetrics.push("ctr", "cpc", "cpm");
  const account = [...new Set(accountMetrics)]
    .map((m) => change(m, accountComparison, days))
    .filter((c) => c.previous !== null || c.current !== null);

  // Mixed-objective accounts: judge cost per result across the campaigns that
  // share the dominant objective, in both uploads, rather than account-wide.
  if (facts.accountObjective === "mixed") {
    const spendBy = new Map<Objective, number>();
    for (const c of model.campaigns) {
      const o = facts.objectives[c.name]?.objective;
      if (o) spendBy.set(o, (spendBy.get(o) ?? 0) + (getMetric(c.metrics, "spend") ?? 0));
    }
    const top = [...spendBy.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (top) {
      const names = new Set(model.campaigns.filter((c) => facts.objectives[c.name]?.objective === top).map((c) => c.name));
      const label = `${OBJECTIVE_PROFILES[top].label} campaigns`;
      const now = groupEntity("g:now", label, model.campaigns.filter((c) => names.has(c.name)));
      const before = groupEntity("g:before", label, previous.model.campaigns.filter((c) => names.has(c.name)));
      now.metrics.derived = deriveMetrics(now.metrics.base);
      before.metrics.derived = deriveMetrics(before.metrics.base);
      const groupPrimary = primaryCostMetric(now, top);
      if (groupPrimary && before.metrics.base.spend) {
        const cmp = asComparison(before, now);
        const scoped = [groupPrimary.result, groupPrimary.cost, ...(top === "sales" ? (["roas"] as MetricKey[]) : [])]
          .map((m) => ({ ...change(m, cmp, days), scope: label }))
          .filter((c) => c.previous !== null && c.current !== null);
        account.splice(1, 0, ...scoped);
      }
    }
  }

  const previousByName = new Map(previous.model.campaigns.map((c) => [c.name, c]));
  const currentNames = new Set(model.campaigns.map((c) => c.name));
  const campaigns: CampaignChange[] = [];
  const newCampaigns: string[] = [];
  for (const c of model.campaigns) {
    const before = previousByName.get(c.name);
    if (!before) {
      newCampaigns.push(c.name);
      continue;
    }
    const objective = objectiveForEntity(c, facts.objectives, facts.accountObjective);
    const cmp = asComparison(before, c);
    const cost = primaryCostMetric(c, objective)?.cost ?? null;
    campaigns.push({
      name: c.name,
      objective,
      costMetric: cost,
      spend: change("spend", cmp, days),
      cost: cost ? change(cost, cmp, days) : null,
    });
  }
  const stoppedCampaigns = previous.model.campaigns.map((c) => c.name).filter((n) => !currentNames.has(n));

  return {
    previous: previous.report,
    previousDays: days.previous,
    currentDays: days.current,
    account,
    campaigns,
    newCampaigns,
    stoppedCampaigns,
  };
}
