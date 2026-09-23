import { runAnalysis, serializeModel, type AnalysisOutput } from "./pipeline";
import type { NormalizedRow, Platform } from "./types";
import type { DataIssue } from "./parse";
import { listAlertRules, saveAnalysis, saveAlertEvents } from "@/lib/db/queries";

/**
 * Runs the full pipeline for a stored report and persists the result. Shared by
 * upload, re-analysis and the seed script so all three produce identical
 * analyses (facts, tiers and alert events included).
 */
export async function analyzeAndSaveReport(input: {
  userId: string;
  reportId: string;
  workspaceId: string;
  rows: NormalizedRow[];
  platform: Platform;
  currency: string;
  objective: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  issues: DataIssue[];
}): Promise<{ analysisId: string; analysis: AnalysisOutput }> {
  const rules = listAlertRules(input.userId, input.workspaceId);
  const analysis = await runAnalysis({
    rows: input.rows,
    platform: input.platform,
    currency: input.currency,
    objective: input.objective,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    alertRules: rules,
    issues: input.issues,
  });

  const analysisId = saveAnalysis({
    userId: input.userId,
    reportId: input.reportId,
    engine: analysis.insights.engine,
    fallbackReason: analysis.insights.fallbackReason,
    summary: analysis.insights.executiveSummary,
    modelJson: serializeModel(analysis.model),
    findings: analysis.findings,
    insights: analysis.insights.insights,
    facts: analysis.facts,
  });
  saveAlertEvents(input.userId, analysisId, input.reportId, analysis.alertEvents);
  return { analysisId, analysis };
}
