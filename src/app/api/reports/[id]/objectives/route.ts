import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, UnauthorizedError } from "@/lib/db/auth";
import {
  getAnalysisModel,
  getLatestAnalysis,
  getObjectiveOverrides,
  getReport,
  getReportIssues,
  getReportRows,
  setObjectiveOverrides,
} from "@/lib/db/queries";
import { deserializeModel } from "@/lib/analysis/pipeline";
import { analyzeAndSaveReport } from "@/lib/analysis/analyze-report";
import { OBJECTIVES, type Objective } from "@/lib/analysis/objectives";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  campaign: z.string().min(1).max(500),
  /** null clears the correction and returns to AdMate's own detection. */
  objective: z.enum(OBJECTIVES as [Objective, ...Objective[]]).nullable(),
});

/**
 * Corrects the objective AdMate detected for one campaign, then re-analyses
 * the report so every finding, benchmark and diagnosis uses it. Statuses on
 * existing recommendations carry over.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const limit = rateLimit(`objectives:${user.id}`, 10, 5);
    if (!limit.ok) {
      return NextResponse.json({ error: "Too many changes at once. Try again shortly." }, { status: 429 });
    }
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid objective." }, { status: 400 });

    const report = getReport(user.id, id);
    if (!report) return NextResponse.json({ error: "Report not found." }, { status: 404 });
    const analysis = getLatestAnalysis(user.id, id);
    const modelJson = analysis ? getAnalysisModel(user.id, analysis.id) : null;
    const model = modelJson ? deserializeModel(modelJson) : null;
    if (!model?.campaigns.some((c) => c.name === parsed.data.campaign)) {
      return NextResponse.json({ error: "That campaign is not in this report." }, { status: 404 });
    }

    const overrides = getObjectiveOverrides(user.id, id);
    if (parsed.data.objective) overrides[parsed.data.campaign] = parsed.data.objective;
    else delete overrides[parsed.data.campaign];
    setObjectiveOverrides(user.id, id, overrides);

    await analyzeAndSaveReport({
      userId: user.id,
      reportId: report.id,
      workspaceId: report.workspaceId,
      rows: getReportRows(user.id, id),
      platform: report.platform,
      currency: report.currency,
      objective: report.objective,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      issues: getReportIssues(user.id, id),
      objectiveOverrides: overrides,
    });
    return NextResponse.json({ ok: true, overrides });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 401 });
    console.error("objective update failed:", error);
    return NextResponse.json({ error: "Could not update the objective." }, { status: 500 });
  }
}
