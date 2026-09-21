import type { MetricKey, Platform } from "./types";
import { METRIC_META, PLATFORM_LABELS, BASE_METRICS, DERIVED_METRICS } from "./types";
import { getMetric, type PerformanceModel } from "./metrics";
import { fmtMoney, fmtValue, type Finding } from "./detectors";
import type { AnalysisContext } from "@/lib/ai/insights";

/**
 * Deterministic account narrative.
 *
 * Doubles as the no-API-key executive summary and as the grounding context
 * handed to Claude, so both engines start from identical facts.
 */
export function buildAccountSummary(
  model: PerformanceModel,
  findings: Finding[],
  currency: string,
): string {
  const spend = getMetric(model.account.metrics, "spend");
  const conversions = getMetric(model.account.metrics, "conversions");
  const cpa = getMetric(model.account.metrics, "cpa");
  const roas = getMetric(model.account.metrics, "roas");
  const ctr = getMetric(model.account.metrics, "ctr");

  const sentences: string[] = [];

  const scale =
    spend !== null
      ? `This report covers ${fmtMoney(spend, currency)} of spend across ${model.campaigns.length || "an unspecified number of"} campaign${model.campaigns.length === 1 ? "" : "s"}.`
      : `This report covers ${model.campaigns.length} campaign${model.campaigns.length === 1 ? "" : "s"}; no spend column was available.`;
  sentences.push(scale);

  const outcomes: string[] = [];
  if (conversions !== null) outcomes.push(`${fmtValue(conversions, "decimal", currency)} conversions`);
  if (cpa !== null) outcomes.push(`a blended CPA of ${fmtMoney(cpa, currency)}`);
  if (roas !== null) outcomes.push(`ROAS of ${roas.toFixed(2)}x`);
  if (ctr !== null) outcomes.push(`CTR of ${(ctr * 100).toFixed(2)}%`);
  if (outcomes.length > 0) sentences.push(`It recorded ${joinList(outcomes)}.`);

  const issues = findings.filter((f) => f.kind === "issue");
  const high = issues.filter((f) => f.priority === "high");
  const opportunities = findings.filter((f) => f.kind === "opportunity");

  if (high.length > 0) {
    const top = high[0];
    sentences.push(
      `${high.length} issue${high.length === 1 ? "" : "s"} ${high.length === 1 ? "needs" : "need"} attention first, led by: ${top.headline}`,
    );
  } else if (issues.length > 0) {
    sentences.push(
      `No high-priority issues were detected. ${issues.length} item${issues.length === 1 ? "" : "s"} ${issues.length === 1 ? "is" : "are"} worth reviewing when you have time.`,
    );
  } else {
    sentences.push(
      "No issues crossed AdMate's detection thresholds in this report. That means nothing stood out against the account's own averages - it is not a judgement on whether the results meet your business targets.",
    );
  }

  if (opportunities.length > 0) {
    sentences.push(
      `${opportunities.length} scaling or efficiency opportunit${opportunities.length === 1 ? "y was" : "ies were"} also identified.`,
    );
  }

  if (!model.hasDates) {
    sentences.push(
      "This report has no date column, so all comparisons are between campaigns rather than over time.",
    );
  }

  return sentences.join(" ");
}

export function buildAnalysisContext(
  model: PerformanceModel,
  platform: Platform,
  currency: string,
  period: string,
  objective: string | null,
  availableMetrics: MetricKey[],
): AnalysisContext {
  const available = new Set<MetricKey>(availableMetrics);
  for (const d of DERIVED_METRICS) {
    if (getMetric(model.account.metrics, d) !== null) available.add(d);
  }

  const allKeys: MetricKey[] = [...BASE_METRICS, ...DERIVED_METRICS];
  const missing = allKeys.filter((m) => !available.has(m));

  const totals: string[] = [];
  for (const metric of allKeys) {
    const value = getMetric(model.account.metrics, metric);
    if (value === null) continue;
    totals.push(`- ${METRIC_META[metric].label}: ${fmtValue(value, METRIC_META[metric].format, currency)}`);
  }

  const levels = [
    `${model.campaigns.length} campaigns`,
    model.adsets.length > 0 ? `${model.adsets.length} ad sets/groups` : null,
    model.ads.length > 0 ? `${model.ads.length} ads` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    platformLabel: PLATFORM_LABELS[platform],
    period,
    objective,
    levels: levels || "account totals only",
    availableMetrics: [...available].map((m) => METRIC_META[m].label).join(", "),
    missingMetrics: missing.map((m) => METRIC_META[m].label).join(", "),
    accountTotals: totals.join("\n") || "- No account totals could be computed.",
  };
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
