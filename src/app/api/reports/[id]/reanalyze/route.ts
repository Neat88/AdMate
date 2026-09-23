import { NextResponse } from "next/server";
import { requireUser, UnauthorizedError } from "@/lib/db/auth";
import { getReport, getReportIssues, getReportRows } from "@/lib/db/queries";
import { analyzeAndSaveReport } from "@/lib/analysis/analyze-report";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Re-runs the analysis on a report's stored rows, so reports uploaded before
 * an engine change get the current findings, tiers and facts without being
 * uploaded again. Recommendation statuses belong to the old analysis and are
 * not carried over.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const limit = rateLimit(`reanalyze:${user.id}`, 5, 2);
    if (!limit.ok) {
      return NextResponse.json(
        { error: "Too many re-analyses in a short time. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }

    const report = getReport(user.id, id);
    if (!report) return NextResponse.json({ error: "Report not found." }, { status: 404 });

    const rows = getReportRows(user.id, id);
    const { analysisId, analysis } = await analyzeAndSaveReport({
      userId: user.id,
      reportId: report.id,
      workspaceId: report.workspaceId,
      rows,
      platform: report.platform,
      currency: report.currency,
      objective: report.objective,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      issues: getReportIssues(user.id, id),
    });
    return NextResponse.json({ ok: true, analysisId, findingCount: analysis.findings.length });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error("reanalyze failed:", error);
    return NextResponse.json({ error: "The report could not be re-analysed." }, { status: 500 });
  }
}
