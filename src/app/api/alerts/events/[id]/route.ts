import { NextResponse } from "next/server";
import { requireUser, UnauthorizedError } from "@/lib/db/auth";
import { acknowledgeAlertEvent } from "@/lib/db/queries";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const ok = acknowledgeAlertEvent(user.id, id);
    if (!ok) return NextResponse.json({ error: "Alert not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Could not acknowledge that alert." }, { status: 500 });
  }
}
