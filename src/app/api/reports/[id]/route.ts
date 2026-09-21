import { NextResponse } from "next/server";
import { requireUser, UnauthorizedError } from "@/lib/db/auth";
import { deleteReport } from "@/lib/db/queries";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    // Cascade removes the rows, analysis, recommendations and alert events.
    const ok = deleteReport(user.id, id);
    if (!ok) return NextResponse.json({ error: "Report not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Could not delete that report." }, { status: 500 });
  }
}
