import { buildPerformanceModel, getMetric } from "./metrics";
import { detectFindings } from "./detectors";
import { evaluateAlerts } from "./alerts";
import { buildAccountSummary, buildAnalysisContext } from "./summary";
import { accountObjective as resolveAccountObjective, resolveCampaignObjectives } from "./objectives";
import { buildFacts, type ReportFacts } from "./facts";
import type { DataIssue } from "./parse";
import { generateInsights, type InsightBundle } from "@/lib/ai/insights";
import type { NormalizedRow, Platform, MetricKey } from "./types";
import { BASE_METRICS } from "./types";
import type { AlertRule, AlertEvent } from "./alerts";
import type { Finding } from "./detectors";
import type { PerformanceModel } from "./metrics";

/**
 * The analysis pipeline, in the order the product promises:
 *   parse & validate -> normalize & compute -> detect -> narrate -> validate output.
 *
 * Steps 1-3 are pure arithmetic and always run. Step 4 is the only place a
 * language model is involved, and step 5 rejects anything it produced that is
 * not supported by step 3's evidence.
 */

export interface AnalysisInput {
  rows: NormalizedRow[];
  platform: Platform;
  currency: string;
  objective: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  alertRules: AlertRule[];
  /** Data-quality issues from parsing, used to judge how far to trust the report. */
  issues?: DataIssue[];
}

export interface AnalysisOutput {
  model: PerformanceModel;
  findings: Finding[];
  insights: InsightBundle;
  alertEvents: AlertEvent[];
  summary: string;
  availableMetrics: MetricKey[];
  facts: ReportFacts;
}

export async function runAnalysis(input: AnalysisInput): Promise<AnalysisOutput> {
  const model = buildPerformanceModel(input.rows);

  const objectives = resolveCampaignObjectives(model, input.rows, input.objective);
  const accountObjective = resolveAccountObjective(model, objectives, input.objective);
  const { findings } = detectFindings(model, input.currency, { objectives, accountObjective });
  const facts = buildFacts({
    model,
    findings,
    objectives,
    accountObjective,
    issues: input.issues ?? [],
    currency: input.currency,
  });

  const availableMetrics = BASE_METRICS.filter((m) =>
    input.rows.some((r) => typeof r.metrics[m] === "number"),
  ) as MetricKey[];

  const summary = buildAccountSummary(model, findings, input.currency);

  const period =
    input.periodStart && input.periodEnd
      ? `${input.periodStart} to ${input.periodEnd}`
      : "not specified in the file";

  const context = buildAnalysisContext(
    model,
    input.platform,
    input.currency,
    period,
    input.objective,
    availableMetrics,
  );

  const insights = await generateInsights(findings, input.currency, context, summary, facts);
  const alertEvents = evaluateAlerts(input.alertRules, model, input.currency);

  return { model, findings, insights, alertEvents, summary, availableMetrics, facts };
}

/**
 * Trims the performance model before it is stored as JSON.
 *
 * Full per-entity trends on a 50k-row report would make the analyses table
 * unnecessarily large; the account trend plus per-entity totals is what the
 * analysis UI actually renders.
 */
export function serializeModel(model: PerformanceModel): string {
  return JSON.stringify({
    account: model.account,
    campaigns: model.campaigns.map(stripTrend),
    adsets: model.adsets.map(stripTrend),
    ads: model.ads.map(stripTrend),
    levelsPresent: model.levelsPresent,
    hasDates: model.hasDates,
    split: model.split ?? null,
  });
}

function stripTrend<T extends { trend?: unknown }>(entity: T): Omit<T, "trend"> {
  const { trend: _trend, ...rest } = entity;
  return rest;
}

export function deserializeModel(json: string): PerformanceModel {
  return JSON.parse(json) as PerformanceModel;
}

/** Convenience accessor used by the dashboard KPI row. */
export function accountKpis(model: PerformanceModel): { metric: MetricKey; value: number | null }[] {
  const keys: MetricKey[] = [
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
  ];
  return keys
    .map((metric) => ({ metric, value: getMetric(model.account.metrics, metric) }))
    .filter((kpi) => kpi.value !== null);
}
