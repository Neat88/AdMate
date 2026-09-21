import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/schema";
import {
  verifyPassword,
  createSession,
  setSessionCookie,
  assertSessionConfigured,
  ConfigurationError,
} from "@/lib/db/auth";

const schema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    assertSessionConfigured();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error("AdMate is misconfigured:", error.message);
      return NextResponse.json(
        { error: "AdMate is not fully configured on the server. Ask your administrator to set SESSION_SECRET." },
        { status: 503 },
      );
    }
    throw error;
  }

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
  }

  const row = getDb()
    .prepare("SELECT id, password_hash FROM users WHERE email = ?")
    .get(parsed.data.email) as { id: string; password_hash: string } | undefined;

  // Same message either way, so the response cannot be used to enumerate accounts.
  const invalid = NextResponse.json({ error: "Email or password is incorrect." }, { status: 401 });
  if (!row || !verifyPassword(parsed.data.password, row.password_hash)) return invalid;

  await setSessionCookie(createSession(row.id));
  return NextResponse.json({ ok: true });
}
