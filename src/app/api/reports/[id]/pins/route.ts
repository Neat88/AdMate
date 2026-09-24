import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, UnauthorizedError } from "@/lib/db/auth";
import { addPinnedInsight, getAnswerWithQuestion, getReport, listPinnedInsights } from "@/lib/db/queries";

const bodySchema = z.object({ messageId: z.string().min(1).max(100) });

/**
 * Pins an assistant answer to the client report. Pins are made from a stored
 * message id - never from text sent by the browser - so only answers that
 * passed AdMate's validation can appear in something a client will read.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    if (!getReport(user.id, id)) return NextResponse.json({ error: "Report not found." }, { status: 404 });
    if (listPinnedInsights(user.id, id).length >= 20) {
      return NextResponse.json({ error: "A report can hold up to 20 pinned answers." }, { status: 409 });
    }
    const source = getAnswerWithQuestion(user.id, id, parsed.data.messageId);
    if (!source) return NextResponse.json({ error: "Answer not found." }, { status: 404 });
    const content = JSON.parse(source.contentJson) as { answer?: unknown };
    if (!content.answer) return NextResponse.json({ error: "Answer not found." }, { status: 404 });
    const pinId = addPinnedInsight(user.id, id, source.question, content.answer);
    return NextResponse.json({ ok: true, pinId });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 401 });
    console.error("pin failed:", error);
    return NextResponse.json({ error: "Could not pin that answer." }, { status: 500 });
  }
}
