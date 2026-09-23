import type { MetricKey } from "./types";
import { METRIC_META } from "./types";
import { getMetric, type PerformanceModel } from "./metrics";
import type { Finding } from "./detectors";
import { fmtMoney, fmtPct, fmtShare, fmtValue } from "./detectors";
import { buildDiagnoses, type Diagnosis, type Tier } from "./diagnoses";
import { analyzeDrivers, mainDrivers, type DriverAnalysis } from "./drivers";
import {
  OBJECTIVE_PROFILES,
  metricLabel,
  objectiveLabel,
  primaryCostMetric,
  type Objective,
  type ObjectiveResolution,
} from "./objectives";
import type { DataIssue } from "./parse";

/**
 * The facts layer: everything deterministic AdMate knows about a report, in
 * one serialisable object. The report page renders from it, and the AI
 * assistant is only ever given slices of it - so the page and the assistant
 * can never disagree about a number.
 */

export const FACTS_VERSION = 1;

export interface DataConfidence {
  level: "good" | "fair" | "limited";
  reasons: string[];
}

export interface BriefingItem {
  diagnosisId: string;
  title: string;
  entityName: string;
  level: Diagnosis["level"];
  summary: string;
  actionLabel: string;
}

export interface Briefing {
  /** One-sentence answer to "what is happening?" */
  verdict: string;
  biggestProblem: BriefingItem | null;
  biggestImprovement: BriefingItem | null;
  biggestOpportunity: BriefingItem | null;
  dataConfidence: DataConfidence;
  counts: Record<Tier, number>;
}

export interface ReportFacts {
  version: number;
  objectives: Record<string, ObjectiveResolution>;
  accountObjective: Objective | "mixed";
  /** "last 7 days vs prior 7 days in this file", or null without dates. */
  comparisonLabel: string | null;
  diagnoses: Diagnosis[];
  /** Account-level change breakdowns, most important first. */
  whatChanged: DriverAnalysis[];
  briefing: Briefing;
}

function whatChangedMetrics(objective: Objective | "mixed", model: PerformanceModel): MetricKey[] {
  if (objective === "mixed") return ["cpm", "ctr", "cpc"];
  const profile = OBJECTIVE_PROFILES[objective];
  const primary = primaryCostMetric(model.account, objective)?.cost;
  const out: MetricKey[] = [];
  if (primary) out.push(primary);
  if (objective === "sales") out.push("roas");
  for (const m of ["ctr", "cpc", "cpm"] as MetricKey[]) if (profile.keyMetrics.includes(m) || m === "cpm") out.push(m);
  return [...new Set(out)];
}

function item(d: Diagnosis | undefined): BriefingItem | null {
  if (!d) return null;
  return {
    diagnosisId: d.id,
    title: d.title,
    entityName: d.entityName,
    level: d.level,
    summary: d.summary,
    actionLabel: d.actionLabel,
  };
}

function assessDataConfidence(model: PerformanceModel, findings: Finding[], issues: DataIssue[]): DataConfidence {
  const reasons: string[] = [];
  let penalty = 0;

  const days = model.account.trend?.length ?? 0;
  if (!model.hasDates) {
    reasons.push("No dates in the file, so nothing can be compared over time.");
    penalty += 2;
  } else if (days < 7) {
    reasons.push(`Only ${days} days of data - period comparisons rest on short windows.`);
    penalty += 1;
  } else {
    reasons.push(`${days} days of daily data, split into two equal halves for comparison.`);
  }

  const conversions = getMetric(model.account.metrics, "conversions");
  const leads = getMetric(model.account.metrics, "leads");
  const results = (conversions ?? 0) + (leads ?? 0);
  if (conversions === null && leads === null) {
    reasons.push("No conversion or lead column, so cost per result cannot be judged.");
    penalty += 1;
  } else if (results < 30) {
    reasons.push(`${Math.round(results)} results in total - small enough that single conversions move the numbers.`);
    penalty += 1;
  } else {
    reasons.push(`${Math.round(results)} results in total, enough for most comparisons.`);
  }

  const errors = issues.filter((i) => i.severity === "error" || i.severity === "warning").length;
  if (errors > 0) {
    reasons.push(`${errors} data quality warning${errors === 1 ? "" : "s"} in the file.`);
    penalty += 1;
  }
  const weak = findings.filter((f) => f.strength === "weak").length;
  if (weak > 0) reasons.push(`${weak} signal${weak === 1 ? " is" : "s are"} too small to confirm yet and marked "monitor".`);

  return { level: penalty === 0 ? "good" : penalty <= 1 ? "fair" : "limited", reasons };
}

function buildVerdict(
  model: PerformanceModel,
  whatChanged: DriverAnalysis[],
  counts: Record<Tier, number>,
  objective: Objective | "mixed",
  currency: string,
): string {
  const parts: string[] = [];
  const headline = whatChanged.find((w) => w.changePct !== null && Math.abs(w.changePct) >= 0.1);
  if (headline) {
    const label = metricLabel(headline.metric, objective);
    const fmt = METRIC_META[headline.metric].format;
    const drivers = mainDrivers(headline);
    const by = drivers.length > 0 ? `, driven mainly by "${drivers[0].name}"` : "";
    parts.push(
      `${label} ${headline.change > 0 ? "rose" : "fell"} ${fmtPct(Math.abs(headline.changePct ?? 0)).replace("+", "")} (${fmtValue(headline.previousValue, fmt, currency)} → ${fmtValue(headline.currentValue, fmt, currency)})${by}.`,
    );
  } else if (whatChanged.length > 0) {
    parts.push("Headline efficiency was broadly stable between the two halves of the report.");
  } else {
    const spend = getMetric(model.account.metrics, "spend");
    parts.push(`This report covers ${fmtMoney(spend, currency)} of spend across ${model.campaigns.length} campaign${model.campaigns.length === 1 ? "" : "s"}.`);
  }
  const act = counts.critical + counts.attention;
  const bits: string[] = [];
  if (counts.critical > 0) bits.push(`${counts.critical} critical`);
  if (counts.attention > 0) bits.push(`${counts.attention} to review`);
  if (counts.monitor > 0) bits.push(`${counts.monitor} to monitor`);
  if (counts.performing > 0) bits.push(`${counts.performing} performing well`);
  if (bits.length > 0) parts.push(`${bits.join(", ")}.`.replace(/^./, (c) => c.toUpperCase()));
  if (act === 0 && bits.length > 0) parts.push("Nothing needs action today.");
  return parts.join(" ");
}

export function buildFacts(input: {
  model: PerformanceModel;
  findings: Finding[];
  objectives: Record<string, ObjectiveResolution>;
  accountObjective: Objective | "mixed";
  issues: DataIssue[];
  currency: string;
}): ReportFacts {
  const { model, findings, objectives, accountObjective, issues, currency } = input;
  const diagnoses = buildDiagnoses(findings);

  const whatChanged: DriverAnalysis[] = [];
  if (model.account.periodComparison) {
    for (const metric of whatChangedMetrics(accountObjective, model)) {
      const analysis = analyzeDrivers(model, model.account, metric);
      if (analysis) whatChanged.push(analysis);
    }
  }

  const counts: Record<Tier, number> = { critical: 0, attention: 0, monitor: 0, performing: 0 };
  for (const d of diagnoses) counts[d.tier]++;

  const problems = diagnoses.filter((d) => d.tier === "critical" || d.tier === "attention");
  const wins = diagnoses.filter((d) => d.action === "keep_running");
  const opportunities = diagnoses.filter((d) => d.action === "scale_gradually" || (d.tier !== "critical" && d.primaryFindingId.startsWith("long_tail")));

  const comparison = model.account.periodComparison;
  return {
    version: FACTS_VERSION,
    objectives,
    accountObjective,
    comparisonLabel: comparison
      ? `${comparison.currentLabel.toLowerCase()} vs ${comparison.previousLabel.toLowerCase()} in this file`
      : null,
    diagnoses,
    whatChanged,
    briefing: {
      verdict: buildVerdict(model, whatChanged, counts, accountObjective, currency),
      biggestProblem: item(problems[0]),
      biggestImprovement: item(wins.sort((a, b) => b.severityScore - a.severityScore)[0]),
      biggestOpportunity: item(opportunities[0]),
      dataConfidence: assessDataConfidence(model, findings, issues),
      counts,
    },
  };
}

/** Plain-language sentence for one driver analysis, used on the page and by the assistant. */
export function describeChange(analysis: DriverAnalysis, objective: Objective | "mixed", currency: string): string {
  const label = metricLabel(analysis.metric, objective);
  const fmt = METRIC_META[analysis.metric].format;
  const dir = analysis.change > 0 ? "rose" : analysis.change < 0 ? "fell" : "was unchanged";
  const pct = analysis.changePct !== null ? ` (${fmtPct(analysis.changePct)})` : "";
  let sentence = `${label} ${dir} from ${fmtValue(analysis.previousValue, fmt, currency)} to ${fmtValue(analysis.currentValue, fmt, currency)}${pct}.`;
  const drivers = mainDrivers(analysis);
  if (drivers.length > 0 && analysis.changePct !== null && Math.abs(analysis.changePct) >= 0.05) {
    const d = drivers[0];
    const share = d.shareOfChange !== null && d.shareOfChange <= 1 ? `${fmtShare(d.shareOfChange)} of the change` : "most of the change";
    sentence += ` "${d.name}" accounts for ${share}`;
    if (d.previousValue !== null && d.currentValue !== null) {
      sentence += ` (its own ${label} went from ${fmtValue(d.previousValue, fmt, currency)} to ${fmtValue(d.currentValue, fmt, currency)})`;
    }
    sentence += ".";
  }
  return sentence;
}

export { objectiveLabel };
