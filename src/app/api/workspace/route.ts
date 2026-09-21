import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, UnauthorizedError } from "@/lib/db/auth";
import { createWorkspace } from "@/lib/db/queries";
import { setActiveWorkspace } from "@/lib/session";

const schema = z.object({
  name: z.string().trim().min(1).max(60),
  currency: z.string().trim().length(3).toUpperCase(),
});

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Enter a name and a 3-letter currency code." }, { status: 400 });
    }

    const workspace = createWorkspace(user.id, parsed.data.name, parsed.data.currency);
    await setActiveWorkspace(workspace.id);
    return NextResponse.json({ ok: true, workspace });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Could not create that workspace." }, { status: 500 });
  }
}
