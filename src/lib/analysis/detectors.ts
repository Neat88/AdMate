import type { EntityLevel, EntityPerformance, MetricKey } from "./types";
import { METRIC_META } from "./types";
import { getMetric, robustZ, weightedMean, type PerformanceModel } from "./metrics";

/**
 * Deterministic issue detection.
 *
 * Every finding produced here is a *fact plus an arithmetic comparison* - never
 * an interpretation. Candidate causes are recorded as explicitly-labelled
 * hypotheses, and the AI layer downstream is only allowed to narrate what is
 * already in `evidence`. That separation is what keeps the product honest: if
 * a number appears in the UI, it came from this file, not from a model.
 */

export type Priority = "high" | "medium" | "low";
export type Confidence = "high" | "medium" | "low";
export type FindingKind = "issue" | "opportunity" | "win";

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
}

interface DetectorContext {
  model: PerformanceModel;
  accountSpend: number | null;
  /** Entity spend must clear this to be worth flagging. */
  materialSpend: number;
  benchmarks: Partial<Record<MetricKey, number | null>>;
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
  spendSpike: 0.4,
  benchmarkWorse: 1.5, // 50% worse than account benchmark
  benchmarkBetter: 0.6, // 40% better than account benchmark
  frequencyHigh: 3.0,
  /** Minimum conversions before a CPA comparison is statistically meaningful. */
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

/* -------------------------------------------------------------------------- */
/* Detectors                                                                  */
/* -------------------------------------------------------------------------- */

type Detector = (entity: EntityPerformance, ctx: DetectorContext) => Finding[];

/** Spend with a confirmed zero conversions - the clearest waste signal there is. */
const spendWithoutConversions: Detector = (entity, ctx) => {
  const spend = getMetric(entity.metrics, "spend");
  const conversions = getMetric(entity.metrics, "conversions");
  // `null` means conversions were never reported - that is a tracking question,
  // not a performance one, and is handled by the account-level detector.
  if (spend === null || conversions === null) return [];
  if (conversions > 0 || spend < ctx.materialSpend) return [];

  const clicks = getMetric(entity.metrics, "clicks");
  const share = spendShare(entity, ctx.accountSpend);
  const s = score(1, share, 70);

  const hypotheses = [
    "The audience may not match the offer, so traffic arrives with low purchase intent.",
    "The landing page or checkout may be failing to convert the traffic it receives.",
  ];
  if (clicks !== null && clicks < T.minClicks) {
    hypotheses.push(
      `With only ${clicks} click(s) recorded, this may simply be too little traffic to have produced a conversion yet.`,
    );
  }
  hypotheses.push(
    "Conversion tracking may not be firing for this campaign, in which case conversions are happening but are not being reported.",
  );

  return [
    {
      id: "",
      code: "spend_no_conversions",
      kind: "issue",
      level: entity.level,
      entityName: entity.name,
      campaign: entity.campaign,
      adset: entity.adset,
      title: "Spending with no recorded conversions",
      headline: `${label(entity)} spent ${fmtMoney(spend, ctx.currency)} and recorded 0 conversions in this report.`,
      priority: bandFor(s),
      severityScore: s,
      confidence: clicks !== null && clicks >= T.minClicks ? "high" : "medium",
      confidenceReason:
        clicks !== null && clicks >= T.minClicks
          ? `${clicks} clicks were recorded, which is enough traffic for the absence of conversions to be meaningful.`
          : "Click volume is low, so the absence of conversions may reflect limited traffic rather than poor performance.",
      evidence: [
        ev("Spend", "spend", spend),
        ev("Conversions", "conversions", 0),
        ev("Clicks", "clicks", clicks),
        ev("Share of account spend", null, share, { format: "percent" }),
      ],
      hypotheses,
      actions: [
        "Confirm the conversion event is firing for this campaign before changing anything else - a tracking gap and a performance problem need opposite responses.",
        "If tracking is confirmed healthy, compare this campaign's audience and creative against one that is converting.",
        `Consider capping or pausing spend here until a conversion is recorded, to protect the ${fmtMoney(spend, ctx.currency)} currently going out.`,
      ],
      monitor: [
        "Conversions and cost per conversion over the next reporting period.",
        "Click-through rate and landing page traffic, to separate a delivery problem from a conversion problem.",
      ],
      spendAtStake: spend,
      context: { clicks, spendShare: share },
    },
  ];
};

/** Period-over-period deterioration on an efficiency metric. */
function periodMovementDetector(
  metric: MetricKey,
  direction: "up" | "down",
  threshold: number,
  code: string,
  title: string,
): Detector {
  return (entity, ctx) => {
    const comparison = entity.periodComparison;
    if (!comparison) return [];
    const delta = comparison.deltas[metric];
    if (!delta || delta.changePct === null || delta.current === null || delta.previous === null) return [];

    const change = delta.changePct;
    const moved = direction === "up" ? change >= threshold : change <= -threshold;
    if (!moved) return [];

    const spend = getMetric(entity.metrics, "spend");
    if (spend !== null && spend < ctx.materialSpend) return [];

    // Guard against tiny denominators producing dramatic percentages.
    if (metric === "cpa" || metric === "cvr") {
      const conv = comparison.deltas.conversions?.current;
      const prevConv = comparison.deltas.conversions?.previous;
      if ((conv ?? 0) < T.minConversions && (prevConv ?? 0) < T.minConversions) return [];
    }
    if (metric === "ctr" || metric === "cpc") {
      const clicks = comparison.deltas.clicks?.current;
      if (clicks !== null && clicks !== undefined && clicks < T.minClicks) return [];
    }

    const share = spendShare(entity, ctx.accountSpend);
    const s = score(Math.abs(change), share);
    const supporting: EvidenceItem[] = [
      ev(`${METRIC_META[metric].label} (${comparison.currentLabel})`, metric, delta.current, {
        comparison: delta.previous,
        comparisonLabel: comparison.previousLabel,
        changePct: change,
      }),
    ];

    // Attach the neighbouring metrics that separate the plausible causes.
    const COMPANIONS: Partial<Record<MetricKey, MetricKey[]>> = {
      cpa: ["conversions", "clicks", "ctr", "cvr", "cpc"],
      cpc: ["cpm", "ctr", "clicks", "impressions"],
      cpm: ["impressions", "reach", "frequency", "spend"],
      ctr: ["impressions", "clicks", "frequency", "cpm"],
      cvr: ["clicks", "conversions", "cpc"],
      roas: ["revenue", "conversions", "aov", "spend"],
      spend: ["impressions", "cpm", "conversions"],
    };
    const companions: MetricKey[] = COMPANIONS[metric] ?? [];

    for (const companion of companions) {
      const cd = comparison.deltas[companion];
      if (!cd || cd.current === null) continue;
      supporting.push(
        ev(METRIC_META[companion].label, companion, cd.current, {
          comparison: cd.previous,
          comparisonLabel: comparison.previousLabel,
          changePct: cd.changePct,
        }),
      );
    }

    const hypotheses = buildHypotheses(metric, comparison.deltas);

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
        headline: `${label(entity)} saw ${METRIC_META[metric].label} move from ${fmtValue(
          delta.previous,
          METRIC_META[metric].format,
          ctx.currency,
        )} to ${fmtValue(delta.current, METRIC_META[metric].format, ctx.currency)} (${fmtPct(change)}) between ${
          comparison.previousLabel.toLowerCase()
        } and ${comparison.currentLabel.toLowerCase()}.`,
        priority: bandFor(s),
        severityScore: s,
        confidence: confidenceForComparison(comparison.currentDays, spend, ctx.materialSpend),
        confidenceReason: `Based on ${comparison.currentDays} day(s) compared against the preceding ${comparison.previousDays} day(s) in this report. No data from outside the uploaded file was used.`,
        evidence: supporting,
        hypotheses,
        actions: buildActions(metric, comparison.deltas, ctx.currency),
        monitor: buildMonitor(metric),
        spendAtStake: spend,
        context: {
          currentPeriod: `${comparison.currentStart} to ${comparison.currentEnd}`,
          previousPeriod: `${comparison.previousStart} to ${comparison.previousEnd}`,
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
): string[] {
  const change = (k: MetricKey) => deltas[k]?.changePct ?? null;
  const out: string[] = [];

  if (metric === "cpa") {
    const ctr = change("ctr");
    const cvr = change("cvr");
    const cpm = change("cpm");
    const freq = change("frequency");

    if (cvr !== null && cvr <= -0.1) {
      out.push(
        "Conversion rate fell alongside CPA, which points to something after the click - landing page, offer, checkout, or conversion tracking - rather than to ad delivery.",
      );
    }
    if (ctr !== null && ctr <= -0.1) {
      out.push(
        "Click-through rate fell at the same time, which is consistent with creative fatigue or a less responsive audience.",
      );
    }
    if (cpm !== null && cpm >= 0.1) {
      out.push(
        "CPM rose as well, so part of the CPA increase may come from higher auction costs rather than from weaker ad performance.",
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
  _currency: string,
): string[] {
  const change = (k: MetricKey) => deltas[k]?.changePct ?? null;

  if (metric === "cpa") {
    const actions = [
      "Verify the conversion event is still recording correctly for this campaign before changing budgets.",
      "Break performance down by creative and by audience to find whether the increase is concentrated in one ad or spread evenly.",
    ];
    if ((change("ctr") ?? 0) <= -0.1) actions.push("Refresh the creative: CTR declined alongside CPA, so new ad variations are a reasonable first test.");
    if ((change("frequency") ?? 0) >= 0.15) actions.push("Expand or refresh the audience to reduce frequency before it erodes performance further.");
    if ((change("cvr") ?? 0) <= -0.1) actions.push("Audit the landing page and checkout flow - the drop appears after the click, not in the ad.");
    actions.push("Hold budget steady while diagnosing; cutting spend mid-diagnosis removes the data you need to confirm the cause.");
    return actions;
  }
  if (metric === "ctr") {
    return [
      "Compare CTR by individual ad to see whether one creative is dragging the average down.",
      "Check frequency: if it is climbing, rotate in new creative rather than increasing bids.",
      "Test a new hook or format against the current best performer instead of replacing everything at once.",
      "Leave targeting unchanged while testing creative, so the result is attributable.",
    ];
  }
  if (metric === "cpm") {
    return [
      "Check whether the audience definition or placement mix changed at the start of the more expensive period.",
      "Compare CPM against other campaigns in the same account to see whether this is account-wide or campaign-specific.",
      "If CPM is rising account-wide, treat it as an auction condition and judge campaigns on CPA/ROAS rather than CPM.",
    ];
  }
  if (metric === "roas") {
    return [
      "Confirm the attribution window and revenue tracking have not changed between the two periods.",
      "Break revenue down by campaign and product to see whether the drop is concentrated or broad.",
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
    "Break this metric down by campaign and ad to locate where the change is concentrated.",
    "Confirm no tracking or account setting changed during the reporting window.",
  ];
}

function buildMonitor(metric: MetricKey): string[] {
  const base: Record<string, string[]> = {
    cpa: ["Cost per conversion over the next 7 days", "Conversion volume, to confirm the CPA change is not just fewer conversions", "Conversion rate and CTR, to see which half of the funnel responded"],
    ctr: ["Click-through rate by individual ad", "Frequency", "CPC, which usually follows CTR"],
    cpm: ["CPM against the account average", "Impressions and reach", "Whether CPA follows CPM or stays stable"],
    cpc: ["Cost per click", "CTR and CPM separately"],
    roas: ["ROAS and revenue, allowing for attribution lag", "Average order value", "Conversion rate"],
    cvr: ["Conversion rate", "Landing page traffic vs. recorded conversions", "Conversion tag health"],
  };
  return base[metric as string] ?? ["The affected metric over the next reporting period."];
}

/** Entity materially worse than the spend-weighted account benchmark. */
function benchmarkDetector(metric: MetricKey, worseIsHigher: boolean, code: string, title: string): Detector {
  return (entity, ctx) => {
    const value = getMetric(entity.metrics, metric);
    const benchmark = ctx.benchmarks[metric];
    if (value === null || benchmark === null || benchmark === undefined || benchmark === 0) return [];

    const spend = getMetric(entity.metrics, "spend");
    if (spend === null || spend < ctx.materialSpend) return [];

    const ratio = value / benchmark;
    const isWorse = worseIsHigher ? ratio >= T.benchmarkWorse : ratio <= T.benchmarkBetter;
    if (!isWorse) return [];

    if (metric === "cpa") {
      const conv = getMetric(entity.metrics, "conversions");
      if (conv === null || conv < T.minConversions) return [];
    }
    if (metric === "ctr") {
      const impressions = getMetric(entity.metrics, "impressions");
      if (impressions === null || impressions < T.minImpressions) return [];
    }

    const share = spendShare(entity, ctx.accountSpend);
    const magnitude = worseIsHigher ? ratio - 1 : 1 - ratio;
    const peerValues = peerMetricValues(ctx.model, entity.level, metric);
    const z = robustZ(value, peerValues);
    const s = score(magnitude, share);

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
        headline: `${label(entity)} has a ${METRIC_META[metric].label} of ${fmtValue(
          value,
          METRIC_META[metric].format,
          ctx.currency,
        )} against an account average of ${fmtValue(benchmark, METRIC_META[metric].format, ctx.currency)}.`,
        priority: bandFor(s),
        severityScore: s,
        confidence: z !== null && Math.abs(z) >= 2 ? "high" : peerValues.length >= 4 ? "medium" : "low",
        confidenceReason:
          z !== null
            ? `Compared against ${peerValues.length} peers at the same level; this value is ${Math.abs(z).toFixed(1)} robust standard deviations from the median.`
            : `Only ${peerValues.length} peer(s) at this level were available, so this is a simple comparison against the spend-weighted account average rather than a statistical outlier test.`,
        evidence: [
          ev(METRIC_META[metric].label, metric, value, {
            comparison: benchmark,
            comparisonLabel: "Account average (spend-weighted)",
            changePct: pctChange(value, benchmark),
          }),
          ev("Spend", "spend", spend),
          ev("Share of account spend", null, share, { format: "percent" }),
        ],
        hypotheses: [
          `A ${METRIC_META[metric].label} this far from the account average usually means this entity is targeting a different audience, using different creative, or pursuing a different objective than the rest of the account.`,
          "It may also be earlier in its learning phase than the campaigns it is being compared against.",
          "Comparisons across different campaign objectives are not like-for-like; confirm the objective matches before treating this as underperformance.",
        ],
        actions: [
          `Compare this entity's setup against the account's best performer on ${METRIC_META[metric].label}: audience, placements, creative and objective.`,
          "Check how long it has been running - recently launched entities often sit outside the account average while the platform optimises.",
          spend !== null && share > 0.15
            ? `This carries ${fmtShare(share)} of account spend, so reallocating part of its budget toward better performers would have a measurable effect.`
            : "If the gap persists after a full learning period, reduce its share of budget.",
        ],
        monitor: [
          `${METRIC_META[metric].label} relative to the account average, not in isolation.`,
          "Spend share, to confirm any reallocation actually took effect.",
        ],
        spendAtStake: spend,
        context: { benchmark, ratio, peerCount: peerValues.length },
      },
    ];
  };
}

function peerMetricValues(model: PerformanceModel, level: EntityLevel, metric: MetricKey): number[] {
  const pool =
    level === "campaign" ? model.campaigns : level === "adset" ? model.adsets : level === "ad" ? model.ads : [];
  return pool
    .map((e) => getMetric(e.metrics, metric))
    .filter((v): v is number => v !== null && Number.isFinite(v));
}

/** Audience saturation: high frequency, optionally corroborated by CTR decline. */
const highFrequency: Detector = (entity, ctx) => {
  const freq = getMetric(entity.metrics, "frequency");
  const spend = getMetric(entity.metrics, "spend");
  if (freq === null || freq < T.frequencyHigh) return [];
  if (spend === null || spend < ctx.materialSpend) return [];

  const ctrDelta = entity.periodComparison?.deltas.ctr;
  const ctrFalling = ctrDelta?.changePct !== null && ctrDelta?.changePct !== undefined && ctrDelta.changePct <= -0.1;
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
          ? [ev("CTR", "ctr", ctrDelta.current, { comparison: ctrDelta.previous, comparisonLabel: "Prior period", changePct: ctrDelta.changePct })]
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
      monitor: ["Frequency", "CTR and CPC, which typically move first when fatigue sets in", "CPA, which follows"],
      spendAtStake: spend,
      context: { frequency: freq, ctrFalling: ctrFalling ? "yes" : "no" },
    },
  ];
};

/** Strong performer with room to scale - the opportunity side of the ledger. */
const scaleOpportunity: Detector = (entity, ctx) => {
  if (entity.level === "account") return [];
  const spend = getMetric(entity.metrics, "spend");
  if (spend === null || spend < ctx.materialSpend) return [];

  const roas = getMetric(entity.metrics, "roas");
  const roasBenchmark = ctx.benchmarks.roas;
  const cpa = getMetric(entity.metrics, "cpa");
  const cpaBenchmark = ctx.benchmarks.cpa;
  const conversions = getMetric(entity.metrics, "conversions");
  if (conversions === null || conversions < T.minConversions) return [];

  let metric: MetricKey | null = null;
  let value: number | null = null;
  let benchmark: number | null = null;
  let magnitude = 0;

  if (roas !== null && roasBenchmark) {
    const ratio = roas / roasBenchmark;
    if (ratio >= 1 / T.benchmarkBetter) {
      metric = "roas";
      value = roas;
      benchmark = roasBenchmark;
      magnitude = ratio - 1;
    }
  }
  if (metric === null && cpa !== null && cpaBenchmark) {
    const ratio = cpa / cpaBenchmark;
    if (ratio <= T.benchmarkBetter) {
      metric = "cpa";
      value = cpa;
      benchmark = cpaBenchmark;
      magnitude = 1 - ratio;
    }
  }
  if (metric === null || value === null || benchmark === null) return [];

  const share = spendShare(entity, ctx.accountSpend);
  // An efficient entity that is *small* is the interesting case - it has room
  // to grow. One already taking most of the budget has less headroom.
  const headroom = 1 - share;
  const s = Math.round(Math.min(100, 20 + Math.min(40, magnitude * 55) + headroom * 25));

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
      headline: `${label(entity)} is outperforming the account average on ${METRIC_META[metric].label} (${fmtValue(
        value,
        METRIC_META[metric].format,
        ctx.currency,
      )} vs ${fmtValue(benchmark, METRIC_META[metric].format, ctx.currency)}) while taking ${fmtShare(share)} of account spend.`,
      priority: bandFor(s, "opportunity"),
      severityScore: s,
      confidence: conversions >= 10 ? "high" : "medium",
      confidenceReason: `Based on ${conversions} recorded conversion(s). Efficiency measured on small conversion counts can move substantially with a few more data points.`,
      evidence: [
        ev(METRIC_META[metric].label, metric, value, {
          comparison: benchmark,
          comparisonLabel: "Account average (spend-weighted)",
          changePct: pctChange(value, benchmark),
        }),
        ev("Spend", "spend", spend),
        ev("Conversions", "conversions", conversions),
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
        `${METRIC_META[metric].label} after each budget increase - efficiency commonly declines as spend grows.`,
        "Frequency and CPM, the first indicators of audience saturation.",
        "Absolute conversion volume, not just efficiency.",
      ],
      spendAtStake: spend,
      context: { benchmark, share },
    },
  ];
};

/* -------------------------------------------------------------------------- */
/* Account-level detectors                                                    */
/* -------------------------------------------------------------------------- */

function accountDetectors(ctx: DetectorContext): Finding[] {
  const out: Finding[] = [];
  const { model, currency } = ctx;
  const account = model.account;
  const accountSpend = getMetric(account.metrics, "spend");
  const conversions = getMetric(account.metrics, "conversions");
  const clicks = getMetric(account.metrics, "clicks");

  // Conversion tracking appears absent account-wide.
  if (clicks !== null && clicks > 100 && (conversions === null || conversions === 0)) {
    out.push({
      id: "",
      code: "conversion_tracking_gap",
      kind: "issue",
      level: "account",
      entityName: "Account",
      campaign: null,
      adset: null,
      title: conversions === null ? "No conversion data in this report" : "No conversions recorded account-wide",
      headline:
        conversions === null
          ? `This report contains ${fmtNumber(clicks)} clicks but no conversion column, so cost-per-result and ROAS cannot be assessed.`
          : `This report contains ${fmtNumber(clicks)} clicks and 0 recorded conversions across the entire account.`,
      priority: "high",
      severityScore: 80,
      confidence: "high",
      confidenceReason:
        "This is a statement about what the uploaded file does or does not contain, not an inference about performance.",
      evidence: [
        ev("Clicks", "clicks", clicks),
        ev("Conversions", "conversions", conversions),
        ev("Spend", "spend", accountSpend),
      ],
      hypotheses:
        conversions === null
          ? [
              "The export may simply have been generated without conversion columns selected.",
              "The account may be running an awareness or traffic objective where conversions are not the goal.",
            ]
          : [
              "Conversion tracking may be broken - a missing pixel, a changed event name, or a consent banner blocking the tag.",
              "The attribution window may exclude conversions that did occur.",
              "The traffic may genuinely not be converting, which is a targeting and offer problem rather than a tracking one.",
            ],
      actions:
        conversions === null
          ? [
              "Re-export the report with conversion and conversion value columns included, then upload again for a full analysis.",
              "If the objective is awareness or traffic, set target CPC or CTR thresholds in Alerts so AdMate monitors the metrics that matter for this account.",
            ]
          : [
              "Test the conversion path yourself and confirm the event fires in the platform's event manager.",
              "Check whether the event name or attribution setting changed recently.",
              "Treat all cost-per-result figures as unreliable until tracking is confirmed - do not reallocate budget on them.",
            ],
      monitor: ["Whether conversions appear in the next export", "Platform event diagnostics"],
      spendAtStake: accountSpend,
      context: {},
    });
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
          "Set an alert on this campaign's CPA or ROAS - a change there moves most of the account.",
        ],
        monitor: [
          `${top.name}'s CPA/ROAS week over week`,
          "Whether smaller campaigns have enough spend to produce meaningful data",
        ],
        spendAtStake: topSpend,
        context: { share, campaignCount: model.campaigns.length },
      });
    }
  }

  // Long tail of non-converting small ads.
  if (model.ads.length >= 5 && accountSpend !== null && accountSpend > 0) {
    const wasteful = model.ads.filter((a) => {
      const spend = getMetric(a.metrics, "spend");
      const conv = getMetric(a.metrics, "conversions");
      return spend !== null && spend > 0 && conv === 0;
    });
    const wastedSpend = wasteful.reduce((sum, a) => sum + (getMetric(a.metrics, "spend") ?? 0), 0);
    const share = wastedSpend / accountSpend;
    if (wasteful.length >= 3 && share >= 0.08) {
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
        headline: `${wasteful.length} of ${model.ads.length} ads spent money without recording a conversion, totalling ${fmtMoney(wastedSpend, currency)} (${fmtShare(share)} of account spend).`,
        priority: bandFor(s, "opportunity"),
        severityScore: s,
        confidence: "medium",
        confidenceReason:
          "Individual ads often have too little traffic for zero conversions to be conclusive. The aggregate figure is more reliable than any single ad in the list.",
        evidence: [
          ev("Non-converting ads", null, wasteful.length, { format: "integer" }),
          ev("Total ads", null, model.ads.length, { format: "integer" }),
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
        monitor: ["Share of spend going to converting ads", "Account CPA after consolidation"],
        spendAtStake: wastedSpend,
        context: { count: wasteful.length, share },
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
  periodMovementDetector("roas", "down", T.roasDrop, "roas_drop", "Return on ad spend declined"),
  periodMovementDetector("ctr", "down", T.ctrDrop, "ctr_drop", "Click-through rate declined"),
  periodMovementDetector("cvr", "down", T.cvrDrop, "cvr_drop", "Conversion rate declined"),
  periodMovementDetector("cpm", "up", T.cpmSpike, "cpm_spike", "CPM increased"),
  periodMovementDetector("cpc", "up", T.cpcSpike, "cpc_spike", "Cost per click increased"),
  benchmarkDetector("cpa", true, "cpa_above_benchmark", "CPA well above account average"),
  benchmarkDetector("ctr", false, "ctr_below_benchmark", "CTR well below account average"),
  highFrequency,
  scaleOpportunity,
];

export interface DetectionResult {
  findings: Finding[];
  benchmarks: Partial<Record<MetricKey, number | null>>;
  materialSpend: number;
}

function computeBenchmarks(model: PerformanceModel): Partial<Record<MetricKey, number | null>> {
  // The account roll-up is itself the spend-weighted benchmark for ratio
  // metrics, because it is computed from summed inputs rather than averaged
  // ratios. That is the statistically correct comparison point.
  const out: Partial<Record<MetricKey, number | null>> = {};
  for (const metric of ["ctr", "cpc", "cpm", "cpa", "roas", "cvr", "aov", "frequency"] as MetricKey[]) {
    out[metric] = getMetric(model.account.metrics, metric);
  }
  // Sanity check with a weighted mean over campaigns where the account
  // roll-up is unavailable (e.g. metric only present on some rows).
  if (out.cpa === null && model.campaigns.length > 0) {
    out.cpa = weightedMean(
      model.campaigns
        .map((c) => ({ value: getMetric(c.metrics, "cpa"), weight: getMetric(c.metrics, "spend") ?? 0 }))
        .filter((p): p is { value: number; weight: number } => p.value !== null),
    );
  }
  return out;
}

export function detectFindings(model: PerformanceModel, currency: string): DetectionResult {
  const accountSpend = getMetric(model.account.metrics, "spend");
  const benchmarks = computeBenchmarks(model);

  // Materiality floor: ignore anything below 2% of account spend, so the
  // recommendation list stays about money that matters.
  const materialSpend = accountSpend !== null && accountSpend > 0 ? accountSpend * 0.02 : 0;

  const ctx: DetectorContext = { model, accountSpend, materialSpend, benchmarks, currency };

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

  const deduped = dedupe(findings);
  deduped.sort((a, b) => b.severityScore - a.severityScore);
  deduped.forEach((f, i) => {
    f.id = `${f.code}:${f.level}:${slug(f.entityName)}:${i}`;
  });

  return { findings: deduped, benchmarks, materialSpend };
}

/**
 * A CPA spike on a campaign usually reappears on its ad sets and ads. Keeping
 * all three would triple the recommendation list for one real problem, so the
 * highest-level occurrence wins and the deeper ones are dropped.
 */
function dedupe(findings: Finding[]): Finding[] {
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
    // Keep the shallowest, plus at most one deeper example if it is notably
    // more severe - that is the "which ad specifically" detail marketers want.
    out.push(group[0]);
    const deeper = group.find((f) => levelRank[f.level] > levelRank[group[0].level] && f.severityScore >= group[0].severityScore + 10);
    if (deeper) out.push(deeper);
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
