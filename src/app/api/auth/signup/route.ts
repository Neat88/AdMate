import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/schema";
import {
  hashPassword,
  createSession,
  setSessionCookie,
  newId,
  assertSessionConfigured,
  ConfigurationError,
} from "@/lib/db/auth";
import { createWorkspace } from "@/lib/db/queries";

const schema = z.object({
  name: z.string().trim().min(1, "Please enter your name.").max(80),
  email: z.string().trim().toLowerCase().email("Please enter a valid email address."),
  password: z.string().min(8, "Use at least 8 characters.").max(200),
});

export async function POST(request: Request) {
  try {
    assertSessionConfigured();
  } catch (error) {
    // Report the misconfiguration before writing anything, so a failed signup
    // does not leave behind an account with no way to sign in.
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
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { name, email, password } = parsed.data;
  const db = getDb();

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    return NextResponse.json(
      { error: "An account with that email already exists. Try signing in." },
      { status: 409 },
    );
  }

  const id = newId("usr");
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, email, name, hashPassword(password), new Date().toISOString());

  createWorkspace(id, "My workspace");
  await setSessionCookie(createSession(id));

  return NextResponse.json({ ok: true });
}
