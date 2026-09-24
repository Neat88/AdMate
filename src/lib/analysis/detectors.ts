import type { BaseMetric, EntityLevel, EntityPerformance, MetricKey, MetricSet } from "./types";
import { METRIC_META } from "./types";
import { deriveMetrics, getMetric, robustZ, type PerformanceModel } from "./metrics";
import {
  OBJECTIVE_PROFILES,
  accountObjective as resolveAccountObjective,
  metricLabel,
  metricRelevant,
  objectiveForEntity,
  objectiveLabel,
  primaryCostMetric,
  resolveCampaignObjectives,
  type Objective,
  type ObjectiveResolution,
} from "./objectives";
import {
  aboveBenchmarkTest,
  belowBenchmarkTest,
  rateDecreaseTest,
  rateIncreaseTest,
  zeroEventsTest,
  type EvidenceStrength,
  type SignificanceResult,
} from "./stats";
import { analyzeDrivers, driverKind, mainDrivers, type DriverAnalysis } from "./drivers";

/**
 * Deterministic issue detection.
 *
 * Every finding produced here is a *fact plus an arithmetic comparison* - never
 * an interpretation. Candidate causes are recorded as explicitly-labelled
 * hypotheses, and the AI layer downstream is only allowed to narrate what is
 * already in `evidence`. That separation is what keeps the product honest: if
 * a number appears in the UI, it came from this file, not from a model.
 *
 * Before a detector speaks it now asks three questions:
 *   1. Is this metric one this campaign's objective is judged on?
 *   2. Is the movement large enough to matter (the percentage threshold)?
 *   3. Is it large enough that chance is an unlikely explanation (the
 *      statistical test)? Movements that pass 1-2 but not 3 are still reported,
 *      but as "monitor", with what it would take to confirm them.
 * Each answer is recorded in `trigger`, which is what the UI shows under
 * "Why am I seeing this?".
 */

export type Priority = "high" | "medium" | "low";
export type Confidence = "high" | "medium" | "low";
export type FindingKind = "issue" | "opportunity" | "win";
export type { EvidenceStrength };

export interface EvidenceItem {
  label: string;
  metric: MetricKey | null;
  value: number | null;
  /** Comparison value: previous period, or the account benchmark. */
  comparison?: number | null;
  comparisonLabel?: string;
  changePct?: number | null;
  format: "integer" | "currency" | "percent" | "ratio" | "decimal";
}

/** One gate a detector checked before raising a finding. */
export interface TriggerCheck {
  label: string;
  /** What the data showed, pre-formatted. */
  observed: string;
  /** The rule it was checked against, pre-formatted. */
  rule: string;
  passed: boolean;
}

export interface TriggerTrace {
  /** Name of the detection rule, e.g. "Efficiency decline". */
  rule: string;
  checks: TriggerCheck[];
}

/** The children that account for most of a finding's movement. */
export interface FindingDriver {
  name: string;
  level: EntityLevel;
  /** Share of the parent's change this child accounts for (0..1+). */
  share: number;
  kind: "rate" | "mix" | "new";
  previousValue: number | null;
  currentValue: number | null;
  /** Current-period share of the parent's spend (or other numerator). */
  currentShare: number | null;
}

export interface Finding {
  id: string;
  code: string;
  kind: FindingKind;
  level: EntityLevel;
  entityName: string;
  campaign: string | null;
  adset: string | null;
  title: string;
  /** Plain-language statement of the observation. Always factual. */
  headline: string;
  priority: Priority;
  /** 0..100, used for ordering within a priority band. */
  severityScore: number;
  confidence: Confidence;
  confidenceReason: string;
  evidence: EvidenceItem[];
  /** Candidate explanations. Presented as hypotheses, never as conclusions. */
  hypotheses: string[];
  /** Deterministic fallback actions; the AI may refine the wording. */
  actions: string[];
  /** What to watch after acting. */
  monitor: string[];
  /** Spend associated with the entity, used to rank by money at stake. */
  spendAtStake: number | null;
  /** Extra data the AI needs but that is not shown as a metric chip. */
  context: Record<string, string | number | null>;
  /** The metric this finding is about, when there is one. */
  metric?: MetricKey | null;
  /** Objective the entity was judged against. */
  objective?: Objective | "mixed";
  /** How strongly the numbers support the finding, statistically. */
  strength?: EvidenceStrength;
  /** Why the finding was raised - each gate it passed. */
  trigger?: TriggerTrace;
  /** Children driving the movement, largest first. */
  drivers?: FindingDriver[];
  /** How much more data would make a "monitor" finding conclusive. */
  dataNeeded?: string | null;
}

interface DetectorContext {
  model: PerformanceModel;
  accountSpend: number | null;
  /** Entity spend must clear this to be worth flagging. */
  materialSpend: number;
  /** Account-wide roll-up, used where objectives don't matter. */
  benchmarks: Partial<Record<MetricKey, number | null>>;
  /** Roll-up of campaigns sharing each objective - the like-for-like benchmark. */
  objectiveBenchmarks: Partial<Record<Objective, MetricSet>>;
  objectives: Record<string, ObjectiveResolution>;
  accountObjective: Objective | "mixed";
  currency: string;
}

/** Relative thresholds, tuned to flag movements a marketer would act on. */
const T = {
  cpaSpike: 0.2,
  cpcSpike: 0.25,
  cpmSpike: 0.2,
  ctrDrop: 0.2,
  cvrDrop: 0.25,
  roasDrop: 0.2,
  improvement: 0.2,
  benchmarkWorse: 1.5, // 50% worse than the like-for-like benchmark
  benchmarkBetter: 0.6, // 40% better than the like-for-like benchmark
  frequencyHigh: 3.0,
  /** Below this many results across both periods, a cost-per-result change is not even worth monitoring. */
  minResultsForChange: 5,
  /** Minimum results before an entity is called efficient enough to scale. */
  minResultsForScale: 5,
  minConversions: 3,
  minClicks: 30,
  minImpressions: 1000,
};

function pctChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

function fmtOf(metric: MetricKey): EvidenceItem["format"] {
  return METRIC_META[metric].format;
}

function ev(
  label: string,
  metric: MetricKey | null,
  value: number | null,
  extra: Partial<EvidenceItem> = {},
): EvidenceItem {
  return {
    label,
    metric,
    value,
    format: metric ? fmtOf(metric) : "decimal",
    ...extra,
  };
}

/**
 * Converts a magnitude and a share-of-spend into a 0-100 score, then a band.
 * Money at stake dominates: a 30% CPA rise on 40% of the budget outranks a
 * 300% rise on a £12 test campaign.
 */
function score(magnitude: number, spendShare: number, base = 40): number {
  const magnitudePart = Math.min(45, magnitude * 60);
  const moneyPart = Math.min(45, spendShare * 90);
  return Math.round(Math.min(100, base * 0.2 + magnitudePart + moneyPart));
}

function bandFor(scoreValue: number, kind: FindingKind = "issue"): Priority {
  // The high band means "investigate now". Opportunities are upside, not
  // urgency, so they are capped at medium however strong the score - otherwise
  // a campaign worth scaling outranks one quietly burning budget.
  if (kind !== "issue") return scoreValue >= 45 ? "medium" : "low";
  if (scoreValue >= 62) return "high";
  if (scoreValue >= 38) return "medium";
  return "low";
}

/** Statistical strength caps confidence: a big move on tiny counts is never "high". */
function capConfidence(confidence: Confidence, strength: EvidenceStrength): Confidence {
  if (strength === "weak") return "low";
  if (strength === "moderate" && confidence === "high") return "medium";
  return confidence;
}

function spendShare(entity: EntityPerformance, accountSpend: number | null): number {
  const spend = getMetric(entity.metrics, "spend");
  if (spend === null || accountSpend === null || accountSpend <= 0) return 0;
  return Math.max(0, Math.min(1, spend / accountSpend));
}

function label(entity: EntityPerformance): string {
  if (entity.level === "campaign") return `Campaign "${entity.name}"`;
  if (entity.level === "adset") return `Ad set "${entity.name}"`;
  if (entity.level === "ad") return `Ad "${entity.name}"`;
  return "The account";
}

function objectiveOf(entity: EntityPerformance, ctx: DetectorContext): Objective | "mixed" {
  return objectiveForEntity(entity, ctx.objectives, ctx.accountObjective);
}

function objectiveCheck(entity: EntityPerformance, ctx: DetectorContext, metric: MetricKey): TriggerCheck {
  const objective = objectiveOf(entity, ctx);
  const campaignName = entity.level === "campaign" ? entity.name : entity.campaign;
  const resolution = campaignName ? ctx.objectives[campaignName] : undefined;
  return {
    label: "Objective",
    observed: `${objectiveLabel(objective)}${resolution ? ` (from ${resolution.detail})` : ""}`,
    rule: `${metricLabel(metric, objective)} is a metric this objective is judged on`,
    passed: true,
  };
}

function materialityCheck(entity: EntityPerformance, ctx: DetectorContext): TriggerCheck {
  const share = spendShare(entity, ctx.accountSpend);
  return {
    label: "Spend at stake",
    observed: `${fmtMoney(getMetric(entity.metrics, "spend"), ctx.currency)} (${fmtShare(share)} of account spend)`,
    rule: "at least 2% of account spend",
    passed: true,
  };
}

function strengthCheck(sig: SignificanceResult): TriggerCheck {
  return {
    label: "Could this be chance?",
    observed: sig.description,
    rule: "strong below 5%, moderate below 20%; weaker signals are shown as \"monitor\"",
    passed: sig.strength !== "weak",
  };
}

/** Converts a driver analysis into the compact form stored on a finding. */
function findingDrivers(analysis: DriverAnalysis | null): FindingDriver[] {
  if (!analysis) return [];
  return mainDrivers(analysis).map((c) => ({
    name: c.name,
    level: c.level,
    share: c.shareOfChange ?? 0,
    kind: driverKind(c),
    previousValue: c.previousValue,
    currentValue: c.currentValue,
    currentShare: c.currentShare,
  }));
}

function levelNoun(level: EntityLevel): string {
  return level === "campaign" ? "campaign" : level === "adset" ? "ad set" : level === "ad" ? "ad" : "account";
}

function driverSentence(drivers: FindingDriver[]): string {
  if (drivers.length === 0) return "";
  const top = drivers[0];
  const what =
    top.kind === "mix"
      ? "mostly because budget shifted toward it"
      : top.kind === "new"
        ? "as a newly spending " + levelNoun(top.level)
        : "mostly because its own efficiency changed";
  const others =
    drivers.length > 1
      ? ` ${drivers
          .slice(1)
          .map((d) => `"${d.name}" (${fmtShare(d.share)})`)
          .join(" and ")} account${drivers.length === 2 ? "s" : ""} for most of the rest.`
      : "";
  const portion =
    top.share > 1
      ? `more than the whole change (other ${levelNoun(top.level)}s partly offset it)`
      : `${fmtShare(top.share)} of the change`;
  return ` The ${levelNoun(top.level)} "${top.name}" accounts for ${portion}, ${what}.${others}`;
}

/* -------------------------------------------------------------------------- */
/* Detectors                                                                  */
/* -------------------------------------------------------------------------- */

type Detector = (entity: EntityPerformance, ctx: DetectorContext) => Finding[];

/** The result metric a conversion-type objective is judged on, if the entity has it. */
function conversionResult(entity: EntityPerformance, objective: Objective | "mixed"): BaseMetric | null {
  if (objective !== "sales" && objective !== "leads" && objective !== "app") return null;
  const primary = primaryCostMetric(entity, objective);
  if (primary) return primary.result;
  // No cost metric means no spend or zero results; fall back to whichever result column exists.
  for (const m of OBJECTIVE_PROFILES[objective].resultMetrics) {
    if (getMetric(entity.metrics, m) !== null) return m;
  }
  return null;
}

/** Results per click and per unit of spend across campaigns sharing an objective. */
function baselineRates(ctx: DetectorContext, objective: Objective | "mixed", result: BaseMetric) {
  const set = objective === "mixed" ? null : ctx.objectiveBenchmarks[objective];
  const source = set ?? ctx.model.account.metrics;
  const results = source.base[result] ?? null;
  const clicks = source.base.clicks ?? null;
  const spend = source.base.spend ?? null;
  return {
    perClick: results !== null && clicks ? results / clicks : null,
    perSpend: results !== null && spend ? results / spend : null,
  };
}

/** Spend with a confirmed zero results - the clearest waste signal there is, when it is conclusive. */
const spendWithoutConversions: Detector = (entity, ctx) => {
  const objective = objectiveOf(entity, ctx);
  const result = conversionResult(entity, objective);
  const spend = getMetric(entity.metrics, "spend");
  if (result === null || spend === null) return [];
  const results = getMetric(entity.metrics, result);
  // `null` means results were never reported - a tracking question handled at account level.
  if (results === null || results > 0 || spend < ctx.materialSpend) return [];

  const resultLabel = metricLabel(result, objective).toLowerCase();
  const clicks = getMetric(entity.metrics, "clicks");
  const rates = baselineRates(ctx, objective, result);
  const sig =
    clicks !== null && clicks > 0 && rates.perClick
      ? zeroEventsTest(clicks, rates.perClick, "clicks", resultLabel)
      : rates.perSpend
        ? zeroEventsTest(spend, rates.perSpend, `${ctx.currency} of spend`, resultLabel)
        : zeroEventsTest(0, 0, "clicks", resultLabel);

  const share = spendShare(entity, ctx.accountSpend);
  const s = score(sig.strength === "weak" ? 0.4 : 1, share, sig.strength === "weak" ? 40 : 70);
  const dataNeeded =
    sig.strength !== "strong" && sig.exposureNeeded !== null
      ? clicks !== null && clicks > 0 && rates.perClick
        ? `about ${fmtNumber(sig.exposureNeeded)} more clicks with no ${resultLabel} would make this conclusive`
        : `about ${fmtMoney(sig.exposureNeeded, ctx.currency)} more spend with no ${resultLabel} would make this conclusive`
      : null;

  const hypotheses = [
    "The audience may not match the offer, so traffic arrives with low purchase intent.",
    "The landing page or checkout may be failing to convert the traffic it receives.",
  ];
  if (sig.strength !== "strong") {
    hypotheses.unshift(
      `At the account's usual rate this much traffic would only be expected to produce about ${sig.expected.toFixed(1)} ${resultLabel}, so zero may simply be too little traffic so far.`,
    );
  }
  hypotheses.push(
    "Conversion tracking may not be firing for this campaign, in which case results are happening but are not being reported.",
  );

  const actions =
    sig.strength === "strong"
      ? [
          "Confirm the conversion event is firing for this campaign before changing anything else - a tracking gap and a performance problem need opposite responses.",
          "If tracking is confirmed healthy, compare this entity's audience and creative against one that is converting.",
          `Consider capping or pausing spend here until a result is recorded, to protect the ${fmtMoney(spend, ctx.currency)} currently going out.`,
        ]
      : [
          "Confirm the conversion event is firing, so you know a zero means zero.",
          `Don't pause on this evidence alone: ${dataNeeded ?? "more traffic is needed before zero results is conclusive"}.`,
          "If you need to limit risk meanwhile, cap the budget rather than pausing, so data keeps arriving.",
        ];

  return [
    {
      id: "",
      code: "spend_no_conversions",
      kind: "issue",
      level: entity.level,
      entityName: entity.name,
      campaign: entity.campaign,
      adset: entity.adset,
      title: sig.strength === "strong" ? `Spending with no recorded ${resultLabel}` : `No ${resultLabel} yet - too early to judge`,
      headline: `${label(entity)} spent ${fmtMoney(spend, ctx.currency)} and recorded 0 ${resultLabel} in this report.`,
      priority: bandFor(s),
      severityScore: s,
      confidence: sig.strength === "strong" ? "high" : sig.strength === "moderate" ? "medium" : "low",
      confidenceReason: sig.description,
      evidence: [
        ev("Spend", "spend", spend),
        ev(metricLabel(result, objective), result, 0),
        ev("Clicks", "clicks", clicks),
        ev("Share of account spend", null, share, { format: "percent" }),
      ],
      hypotheses,
      actions,
      monitor: [
        `${metricLabel(result, objective)} and cost per result over the next reporting period.`,
        "Click-through rate and landing page traffic, to separate a delivery problem from a conversion problem.",
      ],
      spendAtStake: spend,
      context: { clicks, spendShare: share, expectedResults: Number(sig.expected.toFixed(1)) },
      metric: result,
      objective,
      strength: sig.strength,
      dataNeeded,
      trigger: {
        rule: "Spend without results",
        checks: [
          objectiveCheck(entity, ctx, result),
          materialityCheck(entity, ctx),
          { label: "Results", observed: `0 ${resultLabel}`, rule: "zero recorded (not missing)", passed: true },
          strengthCheck(sig),
        ],
      },
    },
  ];
};

/**
 * How to test a movement statistically: which counts the metric is built
 * from. `direction` is the direction of the *metric* move being tested.
 */
export function movementSignificance(
  metric: MetricKey,
  comparison: NonNullable<EntityPerformance["periodComparison"]>,
  bad: boolean,
): SignificanceResult {
  const d = comparison.deltas;
  const pair = (m: BaseMetric) => [d[m]?.previous ?? null, d[m]?.current ?? null] as const;
  // Each metric is a rate of `events` per `exposure`; "worse" means fewer events per exposure
  // for costs (CPA up = fewer conversions per dollar) and for rates (CTR down).
  const spec: Partial<Record<MetricKey, [BaseMetric, BaseMetric, string]>> = {
    cpa: ["conversions", "spend", "conversions"],
    cpl: ["leads", "spend", "leads"],
    cpc: ["clicks", "spend", "clicks"],
    cpm: ["impressions", "spend", "impressions"],
    ctr: ["clicks", "impressions", "clicks"],
    cvr: ["conversions", "clicks", "conversions"],
    leadRate: ["leads", "clicks", "leads"],
    cpe: ["engagements", "spend", "engagements"],
    costPerThruplay: ["thruplays", "spend", "ThruPlays"],
  };
  if (metric === "roas") {
    // Revenue is a sum of order values, not a count; judge the evidence by
    // conversion volume instead.
    const [pc, cc] = pair("conversions");
    const total = (pc ?? 0) + (cc ?? 0);
    const strength: EvidenceStrength = total >= 30 ? "strong" : total >= 10 ? "moderate" : "weak";
    return {
      pValue: null,
      strength,
      description: `ROAS is driven by revenue per order, which cannot be tested like a count. It rests on ${fmtNumber(total)} conversions across both periods (30+ is treated as solid, 10+ as indicative).`,
    };
  }
  const s = spec[metric];
  if (!s) return { pValue: null, strength: "moderate", description: "No statistical test applies to this metric." };
  const [pe, ce] = pair(s[0]);
  const [px, cx] = pair(s[1]);
  if (pe === null || ce === null || px === null || cx === null) {
    return { pValue: null, strength: "weak", description: `The ${s[2]} counts needed to test this change are not in the report.` };
  }
  // Worse always means fewer events per unit of exposure: CPA up is fewer
  // conversions per dollar, CTR down is fewer clicks per impression.
  return bad
    ? rateDecreaseTest(pe, px, ce, cx, s[2])
    : rateIncreaseTest(pe, px, ce, cx, s[2]);
}

/** Minimum volume below which a movement is not reported at all. */
function hasMinimumVolume(metric: MetricKey, comparison: NonNullable<EntityPerformance["periodComparison"]>): boolean {
  const d = comparison.deltas;
  const both = (m: BaseMetric) => (d[m]?.current ?? 0) + (d[m]?.previous ?? 0);
  if (metric === "cpa" || metric === "cvr" || metric === "roas") return both("conversions") >= T.minResultsForChange;
  if (metric === "cpl" || metric === "leadRate") return both("leads") >= T.minResultsForChange;
  if (metric === "ctr" || metric === "cpc") return (d.clicks?.current ?? 0) >= T.minClicks;
  if (metric === "cpm") return (d.impressions?.current ?? 0) >= T.minImpressions;
  return true;
}

/** Period-over-period movement on an efficiency metric, in either direction. */
function periodMovementDetector(
  metric: MetricKey,
  direction: "up" | "down",
  threshold: number,
  code: string,
  title: string,
  kind: FindingKind = "issue",
): Detector {
  return (entity, ctx) => {
    const comparison = entity.periodComparison;
    if (!comparison) return [];
    const objective = objectiveOf(entity, ctx);
    if (!metricRelevant(metric, objective)) return [];

    const delta = comparison.deltas[metric];
    if (!delta || delta.changePct === null || delta.current === null || delta.previous === null) return [];

    const change = delta.changePct;
    const moved = direction === "up" ? change >= threshold : change <= -threshold;
    if (!moved) return [];

    const spend = getMetric(entity.metrics, "spend");
    if (spend !== null && spend < ctx.materialSpend) return [];
    if (!hasMinimumVolume(metric, comparison)) return [];

    const sig = movementSignificance(metric, comparison, kind === "issue");

    const share = spendShare(entity, ctx.accountSpend);
    const s = score(Math.abs(change) * (sig.strength === "weak" ? 0.5 : 1), share);
    const mLabel = metricLabel(metric, objective);
    const supporting: EvidenceItem[] = [
      ev(`${mLabel} (${comparison.currentLabel})`, metric, delta.current, {
        comparison: delta.previous,
        comparisonLabel: comparison.previousLabel,
        changePct: change,
      }),
    ];

    // Attach the neighbouring metrics that separate the plausible causes.
    const COMPANIONS: Partial<Record<MetricKey, MetricKey[]>> = {
      cpa: ["spend", "conversions", "clicks", "ctr", "cvr", "cpc", "cpm"],
      cpl: ["spend", "leads", "clicks", "ctr", "leadRate", "cpc"],
      cpc: ["cpm", "ctr", "clicks", "impressions"],
      cpm: ["impressions", "reach", "frequency", "spend"],
      ctr: ["impressions", "clicks", "frequency", "cpm"],
      cvr: ["clicks", "conversions", "cpc"],
      roas: ["revenue", "conversions", "aov", "spend"],
    };
    for (const companion of COMPANIONS[metric] ?? []) {
      const cd = comparison.deltas[companion];
      if (!cd || cd.current === null) continue;
      supporting.push(
        ev(metricLabel(companion, objective), companion, cd.current, {
          comparison: cd.previous,
          comparisonLabel: comparison.previousLabel,
          changePct: cd.changePct,
        }),
      );
    }

    // Which child drove it? Only meaningful above ad level.
    const drivers = entity.level !== "ad" ? findingDrivers(analyzeDrivers(ctx.model, entity, metric)) : [];
    for (const d of drivers) {
      supporting.push(
        ev(`Share of change from "${d.name}"`, null, d.share, { format: "percent" }),
      );
      if (d.currentValue !== null) {
        supporting.push(
          ev(`${mLabel} of "${d.name}"`, metric, d.currentValue, {
            comparison: d.previousValue,
            comparisonLabel: comparison.previousLabel,
            changePct: pctChange(d.currentValue, d.previousValue),
          }),
        );
      }
    }

    const hypotheses = kind === "win" ? winHypotheses(metric) : buildHypotheses(metric, comparison.deltas, drivers);
    const baseConfidence = confidenceForComparison(comparison.currentDays, spend, ctx.materialSpend);
    const confidence = capConfidence(baseConfidence, sig.strength);

    return [
      {
        id: "",
        code,
        kind,
        level: entity.level,
        entityName: entity.name,
        campaign: entity.campaign,
        adset: entity.adset,
        title,
        headline: `${label(entity)} saw ${mLabel} move from ${fmtValue(
          delta.previous,
          METRIC_META[metric].format,
          ctx.currency,
        )} to ${fmtValue(delta.current, METRIC_META[metric].format, ctx.currency)} (${fmtPct(change)}) between ${
          comparison.previousLabel.toLowerCase()
        } and ${comparison.currentLabel.toLowerCase()}.${driverSentence(drivers)}`,
        priority: bandFor(s, kind),
        severityScore: s,
        confidence,
        confidenceReason: `Based on ${comparison.currentDays} day(s) compared against the preceding ${comparison.previousDays} day(s) in this report. ${sig.description}`,
        evidence: supporting,
        hypotheses,
        actions: kind === "win" ? winActions(metric) : buildActions(metric, comparison.deltas, drivers),
        monitor: kind === "win" ? winMonitor(metric) : buildMonitor(metric),
        spendAtStake: spend,
        context: {
          currentPeriod: `${comparison.currentStart} to ${comparison.currentEnd}`,
          previousPeriod: `${comparison.previousStart} to ${comparison.previousEnd}`,
          pValue: sig.pValue !== null ? Number(sig.pValue.toFixed(3)) : null,
        },
        metric,
        objective,
        strength: sig.strength,
        drivers,
        dataNeeded:
          sig.strength === "weak"
            ? "another week of data at the current spend would show whether this is a real shift or normal fluctuation"
            : null,
        trigger: {
          rule: kind === "win" ? "Meaningful improvement" : "Period-over-period change",
          checks: [
            objectiveCheck(entity, ctx, metric),
            {
              label: "Size of change",
              observed: `${fmtPct(change)} (${fmtValue(delta.previous, METRIC_META[metric].format, ctx.currency)} → ${fmtValue(delta.current, METRIC_META[metric].format, ctx.currency)})`,
              rule: `${direction === "up" ? "an increase" : "a decrease"} of at least ${Math.round(threshold * 100)}%`,
              passed: true,
            },
            materialityCheck(entity, ctx),
            strengthCheck(sig),
          ],
        },
      },
    ];
  };
}

function confidenceForComparison(days: number, spend: number | null, material: number): Confidence {
  if (days >= 7 && spend !== null && spend >= material * 3) return "high";
  if (days >= 4) return "medium";
  return "low";
}

/**
 * Chooses candidate explanations from the *shape* of the surrounding metric
 * movements. E.g. a CPA rise with a stable CTR but a falling conversion rate
 * points downstream of the click, not at the creative.
 */
function buildHypotheses(
  metric: MetricKey,
  deltas: Partial<Record<MetricKey, { changePct: number | null; current: number | null }>>,
  drivers: FindingDriver[] = [],
): string[] {
  const change = (k: MetricKey) => deltas[k]?.changePct ?? null;
  const out: string[] = [];

  if (drivers.length > 0) {
    const top = drivers[0];
    out.push(
      top.kind === "mix"
        ? `Most of the change comes from budget moving toward "${top.name}", which was already less efficient than average - the ${levelNoun(top.level)} itself did not necessarily get worse.`
        : `Most of the change is concentrated in "${top.name}" rather than spread across the ${levelNoun(top.level)}s, which points at something specific to it (creative, audience or placement) rather than an account-wide shift.`,
    );
  }

  if (metric === "cpa" || metric === "cpl") {
    const ctr = change("ctr");
    const cvr = change(metric === "cpl" ? "leadRate" : "cvr");
    const cpm = change("cpm");
    const freq = change("frequency");

    if (cvr !== null && cvr <= -0.1) {
      out.push(
        "Conversion rate fell alongside cost per result, which points to something after the click - landing page, offer, checkout, or conversion tracking - rather than to ad delivery.",
      );
    }
    if (ctr !== null && ctr <= -0.1) {
      out.push(
        "Click-through rate fell at the same time, which is consistent with creative fatigue or a less responsive audience.",
      );
    }
    if (cpm !== null && cpm >= 0.1) {
      out.push(
        "CPM rose as well, so part of the increase may come from higher auction costs rather than from weaker ad performance.",
      );
    }
    if (freq !== null && freq >= 0.15) {
      out.push("Frequency increased, meaning the same people are seeing the ads more often - a common precursor to fatigue.");
    }
    if (out.length === 0) {
      out.push(
        "The supporting metrics in this report did not move enough to single out a cause. Audience saturation, auction competition and a tracking change all remain possible.",
      );
    }
    out.push(
      "A change in conversion tracking or attribution window would produce the same pattern and should be ruled out before making bid or budget changes.",
    );
  } else if (metric === "ctr") {
    const freq = change("frequency");
    const impressions = change("impressions");
    if (freq !== null && freq >= 0.15) {
      out.push("Frequency rose over the same window, which is the classic signature of creative fatigue.");
    }
    if (impressions !== null && impressions >= 0.3) {
      out.push(
        "Impressions grew substantially, so delivery may have expanded into a broader, less qualified audience.",
      );
    }
    out.push("A competitor entering the same auction, or a seasonal shift in attention, can also depress CTR without anything changing in the account.");
  } else if (metric === "cpm") {
    out.push("Higher CPM usually reflects auction dynamics - more competition for the same audience, or a seasonal demand peak.");
    out.push("A narrowed audience or a change in placements can also raise CPM by reducing available inventory.");
  } else if (metric === "cpc") {
    const ctr = change("ctr");
    const cpm = change("cpm");
    if (ctr !== null && ctr <= -0.1) out.push("CPC rose while CTR fell, so the ads are earning fewer clicks per impression - a creative or relevance signal.");
    if (cpm !== null && cpm >= 0.1) out.push("CPM rose too, so part of the increase is the cost of reaching people rather than click performance.");
    if (out.length === 0) out.push("Neither CTR nor CPM moved decisively in this report, so the cause is not identifiable from the available data.");
  } else if (metric === "roas") {
    const aov = change("aov");
    const cvr = change("cvr");
    if (aov !== null && aov <= -0.1) out.push("Average order value fell, so the traffic may be converting on lower-value products or a discount may be in effect.");
    if (cvr !== null && cvr <= -0.1) out.push("Conversion rate fell, which reduces revenue per click independently of order value.");
    out.push("Revenue attribution lags behind spend on most platforms, so a recent drop can partially recover as conversions are attributed.");
  } else if (metric === "cvr") {
    out.push("A conversion rate drop with stable click volume usually sits after the click: landing page changes, stock or pricing changes, or a checkout issue.");
    out.push("A tracking or consent change would also reduce recorded conversions without any real change in customer behaviour.");
  }

  return out;
}

function buildActions(
  metric: MetricKey,
  deltas: Partial<Record<MetricKey, { changePct: number | null }>>,
  drivers: FindingDriver[] = [],
): string[] {
  const change = (k: MetricKey) => deltas[k]?.changePct ?? null;
  const focus =
    drivers.length > 0
      ? `Start with "${drivers[0].name}" - it accounts for ${drivers[0].share > 1 ? "more than the whole" : fmtShare(drivers[0].share) + " of the"} change.`
      : null;

  if (metric === "cpa" || metric === "cpl") {
    const actions = [
      "Verify the conversion event is still recording correctly before changing budgets.",
      focus ??
        "Break performance down by creative and by audience to find whether the increase is concentrated in one ad or spread evenly.",
    ];
    if ((change("ctr") ?? 0) <= -0.1) actions.push("Refresh the creative: CTR declined alongside cost per result, so new ad variations are a reasonable first test.");
    if ((change("frequency") ?? 0) >= 0.15) actions.push("Expand or refresh the audience to reduce frequency before it erodes performance further.");
    if ((change(metric === "cpl" ? "leadRate" : "cvr") ?? 0) <= -0.1) actions.push("Audit the landing page and conversion flow - the drop appears after the click, not in the ad.");
    if (drivers[0]?.kind === "mix") actions.push(`Rebalance budget: spend moved toward "${drivers[0].name}", which converts less efficiently than the rest.`);
    actions.push("Hold budget steady while diagnosing; cutting spend mid-diagnosis removes the data you need to confirm the cause.");
    return actions;
  }
  if (metric === "ctr") {
    return [
      focus ?? "Compare CTR by individual ad to see whether one creative is dragging the average down.",
      "Check frequency: if it is climbing, rotate in new creative rather than increasing bids.",
      "Test a new hook or format against the current best performer instead of replacing everything at once.",
      "Leave targeting unchanged while testing creative, so the result is attributable.",
    ];
  }
  if (metric === "cpm") {
    return [
      "Check whether the audience definition or placement mix changed at the start of the more expensive period.",
      "Compare CPM against other campaigns in the same account to see whether this is account-wide or campaign-specific.",
      "If CPM is rising account-wide, treat it as an auction condition and judge campaigns on their cost per result rather than CPM.",
    ];
  }
  if (metric === "roas") {
    return [
      "Confirm the attribution window and revenue tracking have not changed between the two periods.",
      focus ?? "Break revenue down by campaign and product to see whether the drop is concentrated or broad.",
      "Compare average order value and conversion rate separately - they call for different fixes.",
      "Allow for attribution lag before reallocating budget away from this campaign.",
    ];
  }
  if (metric === "cvr") {
    return [
      "Test the conversion path manually end to end, including on mobile.",
      "Confirm the conversion tag or pixel fires and that consent settings have not changed.",
      "Check for stock, pricing or promotion changes that coincide with the drop.",
    ];
  }
  return [
    focus ?? "Break this metric down by campaign and ad to locate where the change is concentrated.",
    "Confirm no tracking or account setting changed during the reporting window.",
  ];
}

function buildMonitor(metric: MetricKey): string[] {
  const base: Record<string, string[]> = {
    cpa: ["Cost per conversion over the next 7 days", "Conversion volume, to confirm the CPA change is not just fewer conversions", "Conversion rate and CTR, to see which half of the funnel responded"],
    cpl: ["Cost per lead over the next 7 days", "Lead volume", "Lead rate and CTR, to see which half of the funnel responded"],
    ctr: ["Click-through rate by individual ad", "Frequency", "CPC, which usually follows CTR"],
    cpm: ["CPM against the account average", "Impressions and reach", "Whether cost per result follows CPM or stays stable"],
    cpc: ["Cost per click", "CTR and CPM separately"],
    roas: ["ROAS and revenue, allowing for attribution lag", "Average order value", "Conversion rate"],
    cvr: ["Conversion rate", "Landing page traffic vs. recorded conversions", "Conversion tag health"],
  };
  return base[metric as string] ?? ["The affected metric over the next reporting period."];
}

function winHypotheses(metric: MetricKey): string[] {
  return [
    `A recent creative, audience or landing page change may be paying off - check what changed at the start of the better period.`,
    metric === "cpa" || metric === "cpl" || metric === "roas"
      ? "Part of an efficiency gain can come from lower auction costs or seasonality rather than anything in the account."
      : "Seasonal attention or weaker competition can also lift engagement without an account change.",
  ];
}

function winActions(metric: MetricKey): string[] {
  return [
    "Keep what is working running unchanged for now - edits can reset the platform's learning.",
    "Note what changed before the improvement, so it can be repeated in other campaigns.",
    metric === "cpa" || metric === "cpl" || metric === "roas"
      ? "If the improvement holds for another week, consider a gradual budget increase (20-30% at a time)."
      : "If it holds, apply the winning creative or audience to similar campaigns.",
  ];
}

function winMonitor(metric: MetricKey): string[] {
  return [`${METRIC_META[metric].label} over the next 7 days, to confirm the improvement holds`, "Frequency, which erodes gains as audiences saturate"];
}

/** Entity materially worse than the like-for-like (same-objective) benchmark. */
function benchmarkDetector(
  metric: MetricKey,
  worseIsHigher: boolean,
  code: string,
  title: string,
  primaryOnly: boolean,
): Detector {
  return (entity, ctx) => {
    if (entity.level === "account") return [];
    const objective = objectiveOf(entity, ctx);
    if (objective === "mixed" || !metricRelevant(metric, objective)) return [];
    if (primaryOnly && primaryCostMetric(entity, objective)?.cost !== metric) return [];

    const value = getMetric(entity.metrics, metric);
    const benchSet = ctx.objectiveBenchmarks[objective];
    const benchmark = benchSet ? getMetric(benchSet, metric) : null;
    if (value === null || benchmark === null || benchmark === 0) return [];

    const spend = getMetric(entity.metrics, "spend");
    if (spend === null || spend < ctx.materialSpend) return [];

    const ratio = value / benchmark;
    const isWorse = worseIsHigher ? ratio >= T.benchmarkWorse : ratio <= T.benchmarkBetter;
    if (!isWorse) return [];

    // Statistical check: how many events should this entity have recorded at
    // the benchmark rate, and is its shortfall bigger than chance explains?
    let sig: SignificanceResult;
    if (metric === "ctr") {
      const impressions = getMetric(entity.metrics, "impressions");
      const clicks = getMetric(entity.metrics, "clicks");
      if (impressions === null || impressions < T.minImpressions || clicks === null) return [];
      sig = belowBenchmarkTest(clicks, impressions * benchmark, "clicks");
    } else {
      const primary = primaryCostMetric(entity, objective);
      const result = primary?.result ?? "conversions";
      const results = getMetric(entity.metrics, result);
      if (results === null || results < T.minConversions) return [];
      sig = belowBenchmarkTest(results, spend / benchmark, metricLabel(result, objective).toLowerCase());
    }

    const share = spendShare(entity, ctx.accountSpend);
    const magnitude = worseIsHigher ? ratio - 1 : 1 - ratio;
    const peerValues = peerMetricValues(ctx, entity.level, objective, metric);
    const z = robustZ(value, peerValues);
    const s = score(magnitude * (sig.strength === "weak" ? 0.5 : 1), share);
    const mLabel = metricLabel(metric, objective);
    const benchLabel = `${objectiveLabel(objective)} average (spend-weighted)`;
    const baseConfidence: Confidence = z !== null && Math.abs(z) >= 2 ? "high" : peerValues.length >= 4 ? "medium" : "low";

    return [
      {
        id: "",
        code,
        kind: "issue",
        level: entity.level,
        entityName: entity.name,
        campaign: entity.campaign,
        adset: entity.adset,
        title,
        headline: `${label(entity)} has a ${mLabel} of ${fmtValue(
          value,
          METRIC_META[metric].format,
          ctx.currency,
        )} against a ${fmtValue(benchmark, METRIC_META[metric].format, ctx.currency)} average for ${objectiveLabel(objective).toLowerCase()} campaigns in this account.`,
        priority: bandFor(s),
        severityScore: s,
        confidence: capConfidence(baseConfidence, sig.strength),
        confidenceReason: `${sig.description} ${
          z !== null
            ? `Compared against ${peerValues.length} peers with the same objective, this value is ${Math.abs(z).toFixed(1)} robust standard deviations from the median.`
            : `Only ${peerValues.length} peer(s) with the same objective were available, so this is a comparison against their spend-weighted average rather than an outlier test.`
        }`,
        evidence: [
          ev(mLabel, metric, value, {
            comparison: benchmark,
            comparisonLabel: benchLabel,
            changePct: pctChange(value, benchmark),
          }),
          ev("Spend", "spend", spend),
          ev("Share of account spend", null, share, { format: "percent" }),
        ],
        hypotheses: [
          `A ${mLabel} this far from comparable campaigns usually means this entity is reaching a different audience or using weaker creative or placements.`,
          "It may also be earlier in its learning phase than the entities it is being compared against.",
          "Retargeting and prospecting naturally run at different efficiency levels; confirm you are comparing like with like.",
        ],
        actions: [
          `Compare this entity's setup against the best ${objectiveLabel(objective).toLowerCase()} performer on ${mLabel}: audience, placements, creative and offer.`,
          "Check how long it has been running - recently launched entities often sit outside the average while the platform optimises.",
          share > 0.15
            ? `This carries ${fmtShare(share)} of account spend, so reallocating part of its budget toward better performers would have a measurable effect.`
            : "If the gap persists after a full learning period, reduce its share of budget.",
        ],
        monitor: [
          `${mLabel} relative to comparable campaigns, not in isolation.`,
          "Spend share, to confirm any reallocation actually took effect.",
        ],
        spendAtStake: spend,
        context: { benchmark, ratio, peerCount: peerValues.length },
        metric,
        objective,
        strength: sig.strength,
        dataNeeded: sig.strength === "weak" ? "more volume is needed before this gap can be told apart from normal variation" : null,
        trigger: {
          rule: "Worse than comparable campaigns",
          checks: [
            objectiveCheck(entity, ctx, metric),
            {
              label: "Gap to benchmark",
              observed: `${fmtValue(value, METRIC_META[metric].format, ctx.currency)} vs ${fmtValue(benchmark, METRIC_META[metric].format, ctx.currency)} (${fmtPct(pctChange(value, benchmark))})`,
              rule: worseIsHigher ? "at least 50% above the same-objective average" : "at least 40% below the same-objective average",
              passed: true,
            },
            materialityCheck(entity, ctx),
            strengthCheck(sig),
          ],
        },
      },
    ];
  };
}

function peerMetricValues(
  ctx: DetectorContext,
  level: EntityLevel,
  objective: Objective | "mixed",
  metric: MetricKey,
): number[] {
  const model = ctx.model;
  const pool =
    level === "campaign" ? model.campaigns : level === "adset" ? model.adsets : level === "ad" ? model.ads : [];
  return pool
    .filter((e) => objectiveOf(e, ctx) === objective)
    .map((e) => getMetric(e.metrics, metric))
    .filter((v): v is number => v !== null && Number.isFinite(v));
}

/** Audience saturation: high frequency, optionally corroborated by CTR decline. */
const highFrequency: Detector = (entity, ctx) => {
  const freq = getMetric(entity.metrics, "frequency");
  const spend = getMetric(entity.metrics, "spend");
  if (freq === null || freq < T.frequencyHigh) return [];
  if (spend === null || spend < ctx.materialSpend) return [];
  const objective = objectiveOf(entity, ctx);

  const ctrDelta = entity.periodComparison?.deltas.ctr;
  let ctrSig: SignificanceResult | null = null;
  if (ctrDelta?.changePct != null && ctrDelta.changePct <= -0.1 && entity.periodComparison) {
    ctrSig = movementSignificance("ctr", entity.periodComparison, true);
  }
  const ctrFalling = ctrSig !== null && ctrSig.strength !== "weak";
  const strength: EvidenceStrength = ctrFalling ? ctrSig!.strength : "weak";
  const share = spendShare(entity, ctx.accountSpend);
  const s = score(Math.min(1, (freq - T.frequencyHigh) / 3) + (ctrFalling ? 0.3 : 0), share, 35);

  return [
    {
      id: "",
      code: "high_frequency",
      kind: "issue",
      level: entity.level,
      entityName: entity.name,
      campaign: entity.campaign,
      adset: entity.adset,
      title: ctrFalling ? "High frequency with falling CTR" : "High frequency",
      headline: `${label(entity)} has a frequency of ${freq.toFixed(2)}, meaning the average person reached saw these ads ${freq.toFixed(1)} times${
        ctrFalling ? ", and CTR declined over the same window" : ""
      }.`,
      priority: bandFor(s),
      severityScore: s,
      confidence: ctrFalling ? "high" : "medium",
      confidenceReason: ctrFalling
        ? "Frequency and CTR moved in the directions that together indicate creative fatigue, which is stronger evidence than either signal alone."
        : "Frequency alone indicates exposure, not fatigue. CTR did not decline meaningfully in this report, so this is a risk signal rather than a confirmed problem.",
      evidence: [
        ev("Frequency", "frequency", freq),
        ev("Reach", "reach", getMetric(entity.metrics, "reach")),
        ev("Impressions", "impressions", getMetric(entity.metrics, "impressions")),
        ...(ctrDelta && ctrDelta.current !== null
          ? [ev("CTR", "ctr" as MetricKey, ctrDelta.current, { comparison: ctrDelta.previous, comparisonLabel: "Prior period", changePct: ctrDelta.changePct })]
          : []),
        ev("Spend", "spend", spend),
      ],
      hypotheses: [
        "The audience may be too small for the budget, forcing repeated delivery to the same people.",
        ctrFalling
          ? "The combination of rising exposure and falling response is the standard pattern for creative fatigue."
          : "High frequency is tolerable for retargeting audiences, where repeated exposure is intentional.",
      ],
      actions: [
        "Check the audience size against the daily budget - frequency climbs when the budget outgrows the audience.",
        "Rotate in new creative before performance degrades further, rather than after.",
        "For prospecting, broaden the audience; for retargeting, cap frequency or shorten the membership window.",
      ],
      monitor: ["Frequency", "CTR and CPC, which typically move first when fatigue sets in", "Cost per result, which follows"],
      spendAtStake: spend,
      context: { frequency: freq, ctrFalling: ctrFalling ? "yes" : "no" },
      metric: "frequency",
      objective,
      strength,
      dataNeeded: ctrFalling ? null : "a CTR decline alongside this frequency would confirm fatigue",
      trigger: {
        rule: ctrFalling ? "Creative fatigue" : "Audience saturation risk",
        checks: [
          { label: "Frequency", observed: freq.toFixed(2), rule: `at least ${T.frequencyHigh.toFixed(1)}`, passed: true },
          materialityCheck(entity, ctx),
          {
            label: "CTR trend",
            observed: ctrDelta?.changePct != null ? fmtPct(ctrDelta.changePct) : "no period comparison available",
            rule: "a significant decline confirms fatigue; without it this is a risk to monitor",
            passed: ctrFalling,
          },
        ],
      },
    },
  ];
};

/** Strong performer with room to scale - the opportunity side of the ledger. */
const scaleOpportunity: Detector = (entity, ctx) => {
  if (entity.level === "account") return [];
  const spend = getMetric(entity.metrics, "spend");
  if (spend === null || spend < ctx.materialSpend) return [];
  const objective = objectiveOf(entity, ctx);
  if (objective === "mixed") return [];
  const primary = primaryCostMetric(entity, objective);
  if (!primary || (objective !== "sales" && objective !== "leads" && objective !== "app")) return [];

  const results = getMetric(entity.metrics, primary.result);
  if (results === null || results < T.minResultsForScale) return [];
  const bench = ctx.objectiveBenchmarks[objective];
  if (!bench) return [];

  let metric: MetricKey | null = null;
  let value: number | null = null;
  let benchmark: number | null = null;
  let magnitude = 0;

  const roas = objective === "sales" ? getMetric(entity.metrics, "roas") : null;
  const roasBenchmark = objective === "sales" ? getMetric(bench, "roas") : null;
  if (roas !== null && roasBenchmark) {
    const ratio = roas / roasBenchmark;
    if (ratio >= 1 / T.benchmarkBetter) {
      metric = "roas";
      value = roas;
      benchmark = roasBenchmark;
      magnitude = ratio - 1;
    }
  }
  const cost = getMetric(entity.metrics, primary.cost);
  const costBenchmark = getMetric(bench, primary.cost);
  if (metric === null && cost !== null && costBenchmark) {
    const ratio = cost / costBenchmark;
    if (ratio <= T.benchmarkBetter) {
      metric = primary.cost;
      value = cost;
      benchmark = costBenchmark;
      magnitude = 1 - ratio;
    }
  }
  if (metric === null || value === null || benchmark === null) return [];

  // Don't recommend scaling something that is currently deteriorating or saturating.
  const trend = entity.periodComparison?.deltas[primary.cost]?.changePct ?? null;
  if (trend !== null && trend >= T.cpaSpike) return [];
  const frequency = getMetric(entity.metrics, "frequency");
  if (frequency !== null && frequency >= T.frequencyHigh) return [];

  const benchCost = costBenchmark ?? null;
  const sig = benchCost
    ? aboveBenchmarkTest(results, spend / benchCost, metricLabel(primary.result, objective).toLowerCase())
    : { pValue: null, strength: "moderate" as EvidenceStrength, description: "No cost benchmark available for a statistical check." };
  if (sig.strength === "weak") return [];

  const share = spendShare(entity, ctx.accountSpend);
  // An efficient entity that is *small* is the interesting case - it has room
  // to grow. One already taking most of the budget has less headroom.
  const headroom = 1 - share;
  const s = Math.round(Math.min(100, 20 + Math.min(40, magnitude * 55) + headroom * 25));
  const mLabel = metricLabel(metric, objective);

  return [
    {
      id: "",
      code: "scale_opportunity",
      kind: "opportunity",
      level: entity.level,
      entityName: entity.name,
      campaign: entity.campaign,
      adset: entity.adset,
      title: "Efficient performer with room to scale",
      headline: `${label(entity)} is outperforming comparable campaigns on ${mLabel} (${fmtValue(
        value,
        METRIC_META[metric].format,
        ctx.currency,
      )} vs ${fmtValue(benchmark, METRIC_META[metric].format, ctx.currency)}) while taking ${fmtShare(share)} of account spend.`,
      priority: bandFor(s, "opportunity"),
      severityScore: s,
      confidence: capConfidence(results >= 20 ? "high" : "medium", sig.strength),
      confidenceReason: `Based on ${fmtNumber(results)} recorded result(s). ${sig.description}`,
      evidence: [
        ev(mLabel, metric, value, {
          comparison: benchmark,
          comparisonLabel: `${objectiveLabel(objective)} average (spend-weighted)`,
          changePct: pctChange(value, benchmark),
        }),
        ev("Spend", "spend", spend),
        ev(metricLabel(primary.result, objective), primary.result, results),
        ev("Share of account spend", null, share, { format: "percent" }),
      ],
      hypotheses: [
        "Strong efficiency at a small budget often means the audience or creative is well matched, but it does not guarantee the result holds at a larger budget.",
        "Efficiency can also reflect a narrow, cheap audience that will saturate quickly once spend rises.",
      ],
      actions: [
        "Increase budget gradually - roughly 20-30% at a time - and re-measure, rather than scaling in one step.",
        "Watch frequency as budget rises; a fast climb means the audience is too small to absorb it.",
        "Test the winning creative or audience in a separate campaign to see whether the advantage transfers.",
      ],
      monitor: [
        `${mLabel} after each budget increase - efficiency commonly declines as spend grows.`,
        "Frequency and CPM, the first indicators of audience saturation.",
        "Absolute result volume, not just efficiency.",
      ],
      spendAtStake: spend,
      context: { benchmark, share },
      metric,
      objective,
      strength: sig.strength,
      trigger: {
        rule: "Room to scale",
        checks: [
          objectiveCheck(entity, ctx, metric),
          {
            label: "Efficiency vs comparable campaigns",
            observed: `${fmtValue(value, METRIC_META[metric].format, ctx.currency)} vs ${fmtValue(benchmark, METRIC_META[metric].format, ctx.currency)}`,
            rule: "at least 40% better than the same-objective average",
            passed: true,
          },
          {
            label: "Not deteriorating",
            observed: trend !== null ? `${metricLabel(primary.cost, objective)} ${fmtPct(trend)} vs prior period` : "no period comparison",
            rule: "cost per result not rising 20%+ and frequency below 3",
            passed: true,
          },
          strengthCheck(sig),
        ],
      },
    },
  ];
};

/* -------------------------------------------------------------------------- */
/* Account-level detectors                                                    */
/* -------------------------------------------------------------------------- */

function isConversionObjective(o: Objective | "mixed"): boolean {
  return o === "sales" || o === "leads" || o === "app";
}

function accountDetectors(ctx: DetectorContext): Finding[] {
  const out: Finding[] = [];
  const { model, currency } = ctx;
  const account = model.account;
  const accountSpend = getMetric(account.metrics, "spend");

  // Only campaigns whose objective is a conversion are judged on conversions.
  const conversionCampaigns =
    model.campaigns.length > 0
      ? model.campaigns.filter((c) => isConversionObjective(objectiveOf(c, ctx)))
      : isConversionObjective(ctx.accountObjective)
        ? [account]
        : [];

  // Conversion tracking appears absent where it should exist.
  if (conversionCampaigns.length > 0) {
    let clicks = 0;
    let conversions: number | null = null;
    for (const c of conversionCampaigns) {
      clicks += getMetric(c.metrics, "clicks") ?? 0;
      const conv = getMetric(c.metrics, "conversions");
      const leads = getMetric(c.metrics, "leads");
      if (conv !== null || leads !== null) conversions = (conversions ?? 0) + (conv ?? 0) + (leads ?? 0);
    }
    if (clicks > 100 && (conversions === null || conversions === 0)) {
      const missing = conversions === null;
      out.push({
        id: "",
        code: "conversion_tracking_gap",
        kind: "issue",
        level: "account",
        entityName: "Account",
        campaign: null,
        adset: null,
        title: missing ? "No conversion data in this report" : "No conversions recorded account-wide",
        headline: missing
          ? `This report contains ${fmtNumber(clicks)} clicks on conversion-focused campaigns but no conversion column, so cost-per-result and ROAS cannot be assessed.`
          : `Conversion-focused campaigns in this report recorded ${fmtNumber(clicks)} clicks and 0 conversions.`,
        priority: "high",
        severityScore: missing ? 70 : 85,
        confidence: "high",
        confidenceReason:
          "This is a statement about what the uploaded file does or does not contain, not an inference about performance.",
        evidence: [
          ev("Clicks", "clicks", clicks),
          ev("Conversions", "conversions", conversions),
          ev("Spend", "spend", accountSpend),
        ],
        hypotheses: missing
          ? [
              "The export may simply have been generated without conversion columns selected.",
              "The campaigns may be optimising for something other than conversions; if so, set the objective at upload.",
            ]
          : [
              "Conversion tracking may be broken - a missing pixel, a changed event name, or a consent banner blocking the tag.",
              "The attribution window may exclude conversions that did occur.",
              "The traffic may genuinely not be converting, which is a targeting and offer problem rather than a tracking one.",
            ],
        actions: missing
          ? [
              "Re-export the report with conversion and conversion value columns included, then upload again for a full analysis.",
              "If these campaigns are not conversion campaigns, re-upload with the right objective so AdMate judges the metrics that matter.",
            ]
          : [
              "Test the conversion path yourself and confirm the event fires in the platform's event manager.",
              "Check whether the event name or attribution setting changed recently.",
              "Treat all cost-per-result figures as unreliable until tracking is confirmed - do not reallocate budget on them.",
            ],
        monitor: ["Whether conversions appear in the next export", "Platform event diagnostics"],
        spendAtStake: accountSpend,
        context: {},
        metric: "conversions",
        objective: ctx.accountObjective,
        strength: missing ? "moderate" : "strong",
        trigger: {
          rule: missing ? "Missing conversion data" : "Tracking gap",
          checks: [
            {
              label: "Conversion-focused campaigns",
              observed: `${conversionCampaigns.length} campaign(s) judged on conversions`,
              rule: "at least one campaign whose objective is sales, leads or installs",
              passed: true,
            },
            { label: "Clicks", observed: fmtNumber(clicks), rule: "more than 100", passed: true },
            {
              label: "Conversions",
              observed: missing ? "no conversion column" : "0",
              rule: "none recorded",
              passed: true,
            },
          ],
        },
      });
    }
  }

  // Budget concentration.
  if (accountSpend !== null && accountSpend > 0 && model.campaigns.length >= 3) {
    const top = model.campaigns[0];
    const topSpend = getMetric(top.metrics, "spend") ?? 0;
    const share = topSpend / accountSpend;
    if (share >= 0.6) {
      const s = Math.round(45 + share * 25);
      out.push({
        id: "",
        code: "budget_concentration",
        kind: "issue",
        level: "account",
        entityName: "Account",
        campaign: top.name,
        adset: null,
        title: "Budget heavily concentrated in one campaign",
        headline: `"${top.name}" accounts for ${fmtShare(share)} of total spend (${fmtMoney(topSpend, currency)} of ${fmtMoney(accountSpend, currency)}) across ${model.campaigns.length} campaigns.`,
        priority: bandFor(s),
        severityScore: s,
        confidence: "high",
        confidenceReason: "Concentration is calculated directly from the spend figures in this report.",
        evidence: [
          ev("Top campaign spend", "spend", topSpend),
          ev("Total account spend", "spend", accountSpend),
          ev("Share of account spend", null, share, { format: "percent" }),
          ev("Campaigns in report", null, model.campaigns.length, { format: "integer" }),
        ],
        hypotheses: [
          "Concentration is a deliberate and correct choice when one campaign is clearly the best performer.",
          "It becomes a risk when that campaign's performance changes, because there is no diversified base to fall back on.",
        ],
        actions: [
          `Confirm "${top.name}" is genuinely the most efficient campaign and not simply the one with the largest budget.`,
          "Keep at least one alternative campaign funded enough to produce readable data, so there is somewhere to move budget if performance shifts.",
          "Set an alert on this campaign's cost per result - a change there moves most of the account.",
        ],
        monitor: [
          `${top.name}'s cost per result week over week`,
          "Whether smaller campaigns have enough spend to produce meaningful data",
        ],
        spendAtStake: topSpend,
        context: { share, campaignCount: model.campaigns.length },
        metric: "spend",
        objective: ctx.accountObjective,
        // Concentration is a structural risk, not a performance problem.
        strength: "weak",
        trigger: {
          rule: "Budget concentration",
          checks: [
            { label: "Top campaign share", observed: fmtShare(share), rule: "60% or more of spend", passed: true },
            { label: "Campaigns", observed: String(model.campaigns.length), rule: "3 or more", passed: true },
          ],
        },
      });
    }
  }

  // Long tail of non-converting ads - only ads that are supposed to convert.
  if (model.ads.length >= 5 && accountSpend !== null && accountSpend > 0) {
    const eligible = model.ads.filter((a) => isConversionObjective(objectiveOf(a, ctx)));
    const wasteful = eligible.filter((a) => {
      const spend = getMetric(a.metrics, "spend");
      const conv = getMetric(a.metrics, "conversions");
      return spend !== null && spend > 0 && conv === 0;
    });
    const wastedSpend = wasteful.reduce((sum, a) => sum + (getMetric(a.metrics, "spend") ?? 0), 0);
    const wastedClicks = wasteful.reduce((sum, a) => sum + (getMetric(a.metrics, "clicks") ?? 0), 0);
    const share = wastedSpend / accountSpend;
    if (wasteful.length >= 3 && share >= 0.08) {
      const rates = baselineRates(ctx, ctx.accountObjective === "mixed" ? "sales" : ctx.accountObjective, "conversions");
      const sig =
        wastedClicks > 0 && rates.perClick
          ? zeroEventsTest(wastedClicks, rates.perClick, "clicks", "conversions")
          : zeroEventsTest(wastedSpend, rates.perSpend ?? 0, `${currency} of spend`, "conversions");
      const s = Math.round(30 + share * 90);
      out.push({
        id: "",
        code: "long_tail_waste",
        kind: "opportunity",
        level: "account",
        entityName: "Account",
        campaign: null,
        adset: null,
        title: "Spend spread across non-converting ads",
        headline: `${wasteful.length} of ${eligible.length} conversion-focused ads spent money without recording a conversion, totalling ${fmtMoney(wastedSpend, currency)} (${fmtShare(share)} of account spend).`,
        priority: bandFor(s, "opportunity"),
        severityScore: s,
        confidence: sig.strength === "strong" ? "medium" : "low",
        confidenceReason: `Individual ads often have too little traffic for zero conversions to be conclusive; taken together, ${sig.description}`,
        evidence: [
          ev("Non-converting ads", null, wasteful.length, { format: "integer" }),
          ev("Conversion-focused ads", null, eligible.length, { format: "integer" }),
          ev("Spend on non-converting ads", "spend", wastedSpend),
          ev("Share of account spend", null, share, { format: "percent" }),
        ],
        hypotheses: [
          "Some of these are likely new or low-volume ads that have not had enough traffic to convert yet.",
          "Others may be genuinely weak creative that the platform is still testing budget against.",
        ],
        actions: [
          "Sort ads by spend and review only those above a meaningful threshold - the smallest ones are noise.",
          "Consolidate budget into the ads that are converting rather than pausing everything at once, which restarts the learning phase.",
          "Give recently launched ads a full learning period before judging them.",
        ],
        monitor: ["Share of spend going to converting ads", "Account cost per result after consolidation"],
        spendAtStake: wastedSpend,
        context: { count: wasteful.length, share },
        metric: "conversions",
        objective: ctx.accountObjective,
        strength: sig.strength,
        trigger: {
          rule: "Spend on non-converting ads",
          checks: [
            { label: "Non-converting ads", observed: `${wasteful.length} of ${eligible.length}`, rule: "3 or more", passed: true },
            { label: "Their share of spend", observed: fmtShare(share), rule: "8% or more", passed: true },
            strengthCheck(sig),
          ],
        },
      });
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

const ENTITY_DETECTORS: Detector[] = [
  spendWithoutConversions,
  periodMovementDetector("cpa", "up", T.cpaSpike, "cpa_spike", "Cost per conversion increased"),
  periodMovementDetector("cpl", "up", T.cpaSpike, "cpl_spike", "Cost per lead increased"),
  periodMovementDetector("roas", "down", T.roasDrop, "roas_drop", "Return on ad spend declined"),
  periodMovementDetector("ctr", "down", T.ctrDrop, "ctr_drop", "Click-through rate declined"),
  periodMovementDetector("cvr", "down", T.cvrDrop, "cvr_drop", "Conversion rate declined"),
  periodMovementDetector("cpm", "up", T.cpmSpike, "cpm_spike", "CPM increased"),
  periodMovementDetector("cpc", "up", T.cpcSpike, "cpc_spike", "Cost per click increased"),
  periodMovementDetector("cpa", "down", T.improvement, "cpa_improved", "Cost per conversion improved", "win"),
  periodMovementDetector("cpl", "down", T.improvement, "cpl_improved", "Cost per lead improved", "win"),
  periodMovementDetector("roas", "up", T.improvement, "roas_improved", "Return on ad spend improved", "win"),
  periodMovementDetector("ctr", "up", T.improvement, "ctr_improved", "Click-through rate improved", "win"),
  benchmarkDetector("cpa", true, "cpa_above_benchmark", "Cost per result well above comparable campaigns", true),
  benchmarkDetector("cpl", true, "cpl_above_benchmark", "Cost per lead well above comparable campaigns", true),
  benchmarkDetector("cpc", true, "cpc_above_benchmark", "Cost per click well above comparable campaigns", true),
  benchmarkDetector("ctr", false, "ctr_below_benchmark", "CTR well below comparable campaigns", false),
  highFrequency,
  scaleOpportunity,
];

export interface DetectionResult {
  findings: Finding[];
  benchmarks: Partial<Record<MetricKey, number | null>>;
  objectiveBenchmarks: Partial<Record<Objective, MetricSet>>;
  objectives: Record<string, ObjectiveResolution>;
  accountObjective: Objective | "mixed";
  materialSpend: number;
}

export interface DetectOptions {
  objectives?: Record<string, ObjectiveResolution>;
  accountObjective?: Objective | "mixed";
}

function computeBenchmarks(model: PerformanceModel): Partial<Record<MetricKey, number | null>> {
  // The account roll-up is itself the spend-weighted benchmark for ratio
  // metrics, because it is computed from summed inputs rather than averaged
  // ratios. That is the statistically correct comparison point.
  const out: Partial<Record<MetricKey, number | null>> = {};
  for (const metric of ["ctr", "cpc", "cpm", "cpa", "cpl", "roas", "cvr", "aov", "frequency"] as MetricKey[]) {
    out[metric] = getMetric(model.account.metrics, metric);
  }
  return out;
}

/** Sums campaigns per objective, so each campaign is compared with its own kind. */
function computeObjectiveBenchmarks(
  model: PerformanceModel,
  objectives: Record<string, ObjectiveResolution>,
  account: Objective | "mixed",
): Partial<Record<Objective, MetricSet>> {
  const sums = new Map<Objective, Partial<Record<BaseMetric, number | null>>>();
  const pool = model.campaigns.length > 0 ? model.campaigns : [];
  for (const c of pool) {
    const obj = objectives[c.name]?.objective;
    if (!obj) continue;
    const acc = sums.get(obj) ?? {};
    for (const [k, v] of Object.entries(c.metrics.base) as [BaseMetric, number | null][]) {
      if (k === "frequency" || v === null || v === undefined) continue;
      acc[k] = (acc[k] ?? 0) + v;
    }
    sums.set(obj, acc);
  }
  const out: Partial<Record<Objective, MetricSet>> = {};
  for (const [obj, base] of sums) out[obj] = { base, derived: deriveMetrics(base) };
  if (pool.length === 0 && account !== "mixed") out[account] = model.account.metrics;
  return out;
}

export function detectFindings(model: PerformanceModel, currency: string, options: DetectOptions = {}): DetectionResult {
  const accountSpend = getMetric(model.account.metrics, "spend");
  const benchmarks = computeBenchmarks(model);
  const objectives = options.objectives ?? resolveCampaignObjectives(model, [], null);
  const accountObjective = options.accountObjective ?? resolveAccountObjective(model, objectives, null);
  const objectiveBenchmarks = computeObjectiveBenchmarks(model, objectives, accountObjective);

  // Materiality floor: ignore anything below 2% of account spend, so the
  // recommendation list stays about money that matters.
  const materialSpend = accountSpend !== null && accountSpend > 0 ? accountSpend * 0.02 : 0;

  const ctx: DetectorContext = {
    model,
    accountSpend,
    materialSpend,
    benchmarks,
    objectiveBenchmarks,
    objectives,
    accountObjective,
    currency,
  };

  const findings: Finding[] = [];

  // Account-level movement is worth reporting on its own.
  for (const detector of ENTITY_DETECTORS) {
    if (detector === spendWithoutConversions || detector === scaleOpportunity) continue;
    findings.push(...detector(model.account, ctx));
  }

  const entities = [...model.campaigns, ...model.adsets, ...model.ads];
  for (const entity of entities) {
    for (const detector of ENTITY_DETECTORS) {
      findings.push(...detector(entity, ctx));
    }
  }

  findings.push(...accountDetectors(ctx));

  const deduped = dedupe(findings, model.campaigns.length);
  deduped.sort((a, b) => b.severityScore - a.severityScore);
  deduped.forEach((f, i) => {
    f.id = `${f.code}:${f.level}:${slug(f.entityName)}:${i}`;
  });

  return { findings: deduped, benchmarks, objectiveBenchmarks, objectives, accountObjective, materialSpend };
}

/**
 * A CPA spike on a campaign usually reappears on its ad sets and ads. Keeping
 * all of them would multiply the recommendation list for one real problem, so:
 *   - within one campaign, every finding at the shallowest level is kept (two
 *     different ads can both be genuinely bad), capped at three;
 *   - one deeper finding survives only if it is notably more severe - that is
 *     the "which ad, specifically" detail marketers want (the driver analysis
 *     usually names it already);
 *   - an account-level movement is dropped when a campaign already carries the
 *     same finding: the campaign card, with its drivers, is the actionable one.
 */
function dedupe(findings: Finding[], campaignCount: number): Finding[] {
  const levelRank: Record<EntityLevel, number> = { account: 0, campaign: 1, adset: 2, ad: 3 };
  const byCodeAndCampaign = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.code}\u0000${f.campaign ?? f.entityName}`;
    const bucket = byCodeAndCampaign.get(key);
    if (bucket) bucket.push(f);
    else byCodeAndCampaign.set(key, [f]);
  }

  const out: Finding[] = [];
  for (const group of byCodeAndCampaign.values()) {
    group.sort((a, b) => levelRank[a.level] - levelRank[b.level] || b.severityScore - a.severityScore);
    const top = group[0];
    const sameLevel = group.filter((f) => f.level === top.level).slice(0, 3);
    out.push(...sameLevel);
    const deeper = group.find(
      (f) => levelRank[f.level] > levelRank[top.level] && f.severityScore >= top.severityScore + 10,
    );
    if (deeper) out.push(deeper);
  }

  if (campaignCount >= 2) {
    const campaignCodes = new Set(out.filter((f) => f.level === "campaign").map((f) => f.code));
    return out.filter(
      (f) => !(f.level === "account" && f.entityName === "Account total" && campaignCodes.has(f.code)),
    );
  }
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers (shared with the AI prompt builder)                     */
/* -------------------------------------------------------------------------- */

export function fmtNumber(n: number | null): string {
  if (n === null) return "not reported";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);
}

export function fmtMoney(n: number | null, currency: string): string {
  if (n === null) return "not reported";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${fmtNumber(n)}`;
  }
}

/** Signed percentage, for period-over-period changes. */
export function fmtPct(n: number | null): string {
  if (n === null) return "not reported";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(1)}%`;
}

/** Unsigned percentage, for shares and proportions (never a "+" prefix). */
export function fmtShare(n: number | null): string {
  if (n === null) return "not reported";
  return `${(n * 100).toFixed(1)}%`;
}

export function fmtValue(
  n: number | null,
  format: EvidenceItem["format"],
  currency: string,
): string {
  if (n === null) return "not reported";
  switch (format) {
    case "currency":
      return fmtMoney(n, currency);
    case "percent":
      return `${(n * 100).toFixed(2)}%`;
    case "ratio":
      return `${n.toFixed(2)}x`;
    case "integer":
      return fmtNumber(Math.round(n));
    default:
      return fmtNumber(n);
  }
}
