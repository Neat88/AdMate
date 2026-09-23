import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, UnauthorizedError } from "@/lib/db/auth";
import {
  addMessage,
  createConversation,
  deleteConversation,
  getAnalysisFacts,
  getAnalysisModel,
  getConversation,
  getLatestAnalysis,
  getReport,
  getReportRows,
  getUsageToday,
  listMessages,
  listRecommendationsForAnalysis,
  recordUsage,
  updateConversation,
} from "@/lib/db/queries";
import { deserializeModel } from "@/lib/analysis/pipeline";
import type { Finding } from "@/lib/analysis/detectors";
import type { NormalizedRow } from "@/lib/analysis/types";
import { METRIC_META } from "@/lib/analysis/types";
import { isAiConfigured } from "@/lib/ai/insights";
import { rateLimit } from "@/lib/rate-limit";
import { resolveTargets, type ReportContext } from "@/lib/assistant/context";
import { answerToText, answerWithModel, type HistoryTurn } from "@/lib/assistant/engine";
import { intentOf, localAnswer } from "@/lib/assistant/local";
import { focusLabel } from "@/lib/assistant/openers";
import type { AssistantAnswer, AssistantEvent, AssistantFocus, ChatMessage, SuggestionId } from "@/lib/assistant/types";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Daily cap on model-backed answers per user. Suggested questions still work locally beyond it. */
function dailyLimit(): number {
  const n = Number(process.env.ADMATE_AI_DAILY_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

const metricKey = z.string().refine((k) => k in METRIC_META, "unknown metric");
const focusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("report") }),
  z.object({ kind: z.literal("metric"), metric: metricKey, entityId: z.string().max(600).nullable() }),
  z.object({ kind: z.literal("diagnosis"), diagnosisId: z.string().max(400) }),
  z.object({ kind: z.literal("entity"), entityId: z.string().max(600) }),
  z.object({ kind: z.literal("change"), metric: metricKey }),
]);
const SUGGESTION_IDS = [
  "explain_metric", "why_change", "is_good", "what_to_do", "why_problem", "should_pause", "alternatives", "how_sure",
  "entity_health", "entity_drivers", "compare_peers", "which_first", "is_real", "prioritize", "biggest_problem", "whats_working",
] as const;
const bodySchema = z.object({
  message: z.string().trim().min(1).max(600),
  focus: focusSchema,
  suggestionId: z.enum(SUGGESTION_IDS).nullable().optional(),
});

/**
 * Everything the assistant may read about a report, loaded through the
 * user-scoped queries: a report id that isn't the caller's yields null, and
 * nothing from any other report is ever loaded into the context.
 */
function loadContext(userId: string, reportId: string): ReportContext | null {
  const report = getReport(userId, reportId);
  if (!report) return null;
  const analysis = getLatestAnalysis(userId, reportId);
  if (!analysis) return null;
  const facts = getAnalysisFacts(userId, analysis.id);
  const modelJson = getAnalysisModel(userId, analysis.id);
  if (!facts || !modelJson) return null;
  const findings = new Map<string, Finding>();
  for (const r of listRecommendationsForAnalysis(userId, analysis.id)) findings.set(r.findingId, r.finding);
  let rows: NormalizedRow[] | null = null;
  return {
    report,
    model: deserializeModel(modelJson),
    facts,
    findings,
    loadRows: () => (rows ??= getReportRows(userId, reportId)),
  };
}

function toChatMessage(m: { id: string; role: "user" | "assistant"; contentJson: string; createdAt: string }): ChatMessage {
  const content = JSON.parse(m.contentJson) as { text?: string; answer?: AssistantAnswer; focusLabel?: string };
  return { id: m.id, role: m.role, text: content.text, answer: content.answer, focusLabel: content.focusLabel ?? null, createdAt: m.createdAt };
}

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 401 });
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!getReport(user.id, id)) return NextResponse.json({ error: "Report not found." }, { status: 404 });
    const conversation = getConversation(user.id, id);
    const messages = conversation ? listMessages(user.id, conversation.id, 60).map(toChatMessage) : [];
    return NextResponse.json({
      messages,
      aiEnabled: isAiConfigured(),
      usage: { used: getUsageToday(user.id).requests, limit: dailyLimit() },
    });
  } catch (error) {
    return errorResponse(error, "Could not load the conversation.");
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!getReport(user.id, id)) return NextResponse.json({ error: "Report not found." }, { status: 404 });
    deleteConversation(user.id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Could not clear the conversation.");
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = (await requireUser()).id;
  } catch (error) {
    return errorResponse(error, "Not signed in.");
  }
  const { id } = await params;

  const limit = rateLimit(`assistant:${userId}`, 8, 6);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "You're asking faster than AdMate can answer. Try again in a moment." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That question couldn't be read." }, { status: 400 });
  const { message } = parsed.data;
  const focus = parsed.data.focus as AssistantFocus;
  const suggestionId = (parsed.data.suggestionId ?? null) as SuggestionId | null;

  const ctx = loadContext(userId, id);
  if (!ctx) {
    return NextResponse.json(
      { error: getReport(userId, id) ? "Re-analyse this report to use the assistant." : "Report not found." },
      { status: getReport(userId, id) ? 409 : 404 },
    );
  }

  const conversation = getConversation(userId, id) ?? createConversation(userId, id);
  const previous = listMessages(userId, conversation.id, 40);
  const previousFocus = conversation.focusJson ? (JSON.parse(conversation.focusJson) as AssistantFocus) : null;
  const label = focusLabel(focus, { facts: ctx.facts, model: ctx.model, currency: ctx.report.currency });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: AssistantEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        addMessage({ userId, conversationId: conversation.id, role: "user", content: { text: message, focusLabel: label }, focus });

        const targets = resolveTargets(message, focus, previousFocus, ctx);
        const intent = suggestionId ?? intentOf(message);
        let answer: AssistantAnswer;
        let inputTokens: number | null = null;
        let outputTokens: number | null = null;

        if (!isAiConfigured()) {
          answer = localAnswer(ctx, targets, intent, suggestionId ? null : "Answered by the built-in analyst (no AI key is configured).");
        } else if (getUsageToday(userId).requests >= dailyLimit()) {
          answer = localAnswer(ctx, targets, intent, "You've reached today's AI question limit, so the built-in analyst answered this.");
        } else {
          // Recent turns verbatim; older ones collapse into a list of what was asked.
          const turns: HistoryTurn[] = previous.map((m) => {
            const c = JSON.parse(m.contentJson) as { text?: string; answer?: AssistantAnswer };
            return { role: m.role, text: m.role === "user" ? (c.text ?? "") : c.answer ? answerToText(c.answer) : "" };
          }).filter((t) => t.text);
          const recent = turns.slice(-8);
          while (recent.length && recent[0].role !== "user") recent.shift();
          const older = turns.slice(0, turns.length - recent.length).filter((t) => t.role === "user");
          const earlierSummary = older.length ? `Earlier the user asked: ${older.map((t) => t.text.slice(0, 120)).join(" | ")}` : null;

          const result = await answerWithModel({
            ctx,
            targets,
            message,
            history: recent,
            earlierSummary,
            focusLabel: label,
            suggestionId,
            onStatus: (text) => emit({ type: "status", text }),
          });
          answer = result.answer;
          inputTokens = result.inputTokens;
          outputTokens = result.outputTokens;
          recordUsage(userId, result.inputTokens, result.outputTokens);
        }

        const messageId = addMessage({
          userId,
          conversationId: conversation.id,
          role: "assistant",
          content: { answer },
          focus,
          engine: answer.engine,
          inputTokens,
          outputTokens,
        });
        updateConversation(userId, conversation.id, { focusJson: JSON.stringify(focus) });
        emit({
          type: "answer",
          message: { id: messageId, role: "assistant", answer, focusLabel: label, createdAt: new Date().toISOString() },
        });
      } catch (error) {
        console.error("assistant failed:", error);
        emit({ type: "error", error: "AdMate couldn't answer that just now. Please try again." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
