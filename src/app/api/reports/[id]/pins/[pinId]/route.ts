import { NextResponse } from "next/server";
import { requireUser, UnauthorizedError } from "@/lib/db/auth";
import { deletePinnedInsight } from "@/lib/db/queries";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; pinId: string }> }) {
  try {
    const user = await requireUser();
    const { id, pinId } = await params;
    if (!deletePinnedInsight(user.id, id, pinId)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 401 });
    return NextResponse.json({ error: "Could not remove that answer." }, { status: 500 });
  }
}
