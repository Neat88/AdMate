import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, UnauthorizedError } from "@/lib/db/auth";
import {
  parseFile,
  normalizeRows,
  ParseError,
  MAX_UPLOAD_BYTES,
} from "@/lib/analysis/parse";
import type { ColumnMapping } from "@/lib/analysis/columns";
import { runAnalysis, serializeModel } from "@/lib/analysis/pipeline";
import {
  getWorkspace,
  saveReport,
  saveAnalysis,
  listAlertRules,
  saveAlertEvents,
} from "@/lib/db/queries";
import type { Platform } from "@/lib/analysis/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const contextSchema = z.object({
  workspaceId: z.string().min(1),
  platform: z.enum(["meta", "tiktok", "google", "linkedin", "other"]),
  currency: z.string().trim().length(3).toUpperCase(),
  objective: z.string().trim().max(120).optional().nullable(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

/**
 * Step 2: re-parse the file with the user's confirmed mapping, run the full
 * pipeline, and persist the report, its analysis and any alert events.
 *
 * The file is re-sent rather than cached server-side between the two steps:
 * it keeps unconfirmed advertising data from sitting in server storage, and
 * makes the confirm step idempotent.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0 || file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "The file was missing or too large." }, { status: 400 });
    }

    const parsedContext = contextSchema.safeParse(JSON.parse(String(form.get("context") ?? "{}")));
    if (!parsedContext.success) {
      return NextResponse.json(
        { error: `Missing or invalid report details: ${parsedContext.error.issues[0].path.join(".")}` },
        { status: 400 },
      );
    }
    const context = parsedContext.data;

    // The workspace must belong to this user.
    const workspace = getWorkspace(user.id, context.workspaceId);
    if (!workspace) {
      return NextResponse.json({ error: "That workspace was not found." }, { status: 404 });
    }

    let mappings: ColumnMapping[];
    try {
      mappings = JSON.parse(String(form.get("mappings") ?? "[]")) as ColumnMapping[];
    } catch {
      return NextResponse.json({ error: "The column mapping was malformed." }, { status: 400 });
    }
    if (!Array.isArray(mappings) || mappings.length === 0) {
      return NextResponse.json({ error: "No column mapping was provided." }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    const table = parseFile(file.name, buffer);
    const normalized = normalizeRows(table, mappings);

    const blocking = normalized.issues.filter((i) => i.severity === "error");
    if (blocking.length > 0) {
      return NextResponse.json(
        { error: blocking[0].message, issues: normalized.issues },
        { status: 422 },
      );
    }

    const periodStart = context.periodStart ?? normalized.dateRange?.start ?? null;
    const periodEnd = context.periodEnd ?? normalized.dateRange?.end ?? null;

    const reportId = saveReport({
      userId: user.id,
      workspaceId: workspace.id,
      filename: file.name,
      platform: context.platform as Platform,
      currency: context.currency,
      objective: context.objective ?? null,
      periodStart,
      periodEnd,
      mappings,
      issues: normalized.issues,
      rows: normalized.rows,
    });

    const rules = listAlertRules(user.id, workspace.id);
    const analysis = await runAnalysis({
      rows: normalized.rows,
      platform: context.platform as Platform,
      currency: context.currency,
      objective: context.objective ?? null,
      periodStart,
      periodEnd,
      alertRules: rules,
    });

    const analysisId = saveAnalysis({
      userId: user.id,
      reportId,
      engine: analysis.insights.engine,
      fallbackReason: analysis.insights.fallbackReason,
      summary: analysis.insights.executiveSummary,
      modelJson: serializeModel(analysis.model),
      findings: analysis.findings,
      insights: analysis.insights.insights,
    });

    saveAlertEvents(user.id, analysisId, reportId, analysis.alertEvents);

    return NextResponse.json({
      ok: true,
      reportId,
      analysisId,
      findingCount: analysis.findings.length,
      alertCount: analysis.alertEvents.length,
      engine: analysis.insights.engine,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ParseError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error("upload/confirm failed:", error);
    return NextResponse.json({ error: "The analysis could not be completed." }, { status: 500 });
  }
}
