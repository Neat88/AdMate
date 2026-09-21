import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, UnauthorizedError } from "@/lib/db/auth";
import { updateRecommendationStatus } from "@/lib/db/queries";

const schema = z.object({
  status: z.enum(["new", "in_review", "action_taken", "dismissed"]),
  note: z.string().trim().max(2000).optional().nullable(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }

    // Scoped by user id, so one user cannot update another's recommendation.
    const updated = updateRecommendationStatus(user.id, id, parsed.data.status, parsed.data.note);
    if (!updated) {
      return NextResponse.json({ error: "Recommendation not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, status: parsed.data.status });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Could not update that recommendation." }, { status: 500 });
  }
}
