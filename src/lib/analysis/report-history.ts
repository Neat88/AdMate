import { findPreviousReport, getAnalysisModel, getLatestAnalysis, type ReportRecord } from "@/lib/db/queries";
import { deserializeModel } from "./pipeline";
import type { PerformanceModel } from "./metrics";
import type { ReportFacts } from "./facts";
import { compareReports, type HistoryComparison } from "./history";

/** Loads the comparison with the user's previous upload, or null when there is none. */
export function loadHistory(
  userId: string,
  report: ReportRecord,
  model: PerformanceModel,
  facts: ReportFacts,
): HistoryComparison | null {
  const previous = findPreviousReport(userId, report);
  if (!previous) return null;
  const analysis = getLatestAnalysis(userId, previous.id);
  const json = analysis ? getAnalysisModel(userId, analysis.id) : null;
  if (!json) return null;
  return compareReports(
    { model, facts, report },
    {
      model: deserializeModel(json),
      report: {
        id: previous.id,
        filename: previous.filename,
        periodStart: previous.periodStart,
        periodEnd: previous.periodEnd,
        createdAt: previous.createdAt,
      },
    },
  );
}
