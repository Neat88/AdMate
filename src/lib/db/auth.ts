import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { getDb } from "./schema";

/**
 * Session auth, deliberately small.
 *
 * Passwords: scrypt with a per-user salt. Sessions: random opaque id stored
 * server-side, handed to the browser in an HttpOnly cookie that also carries
 * an HMAC so a tampered cookie is rejected before it reaches the database.
 */

const SESSION_COOKIE = "admate_session";
const SESSION_TTL_DAYS = 30;

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new ConfigurationError(
      "SESSION_SECRET is not set. AdMate will not sign session cookies with a default secret in production. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  // Development convenience only. Sessions reset when the server restarts.
  return "admate-development-only-secret-do-not-use-in-production";
}

/**
 * Fails fast on misconfiguration.
 *
 * Called at the top of any route that creates an account, so a missing
 * SESSION_SECRET is reported before a user row is written rather than after —
 * otherwise signup leaves an orphaned account that can never be signed into.
 */
export function assertSessionConfigured(): void {
  sessionSecret();
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sign(sessionId: string): string {
  const mac = createHmac("sha256", sessionSecret()).update(sessionId).digest("hex").slice(0, 32);
  return `${sessionId}.${mac}`;
}

function unsign(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const sessionId = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", sessionSecret()).update(sessionId).digest("hex").slice(0, 32);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return sessionId;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function createSession(userId: string): string {
  const db = getDb();
  const id = newId("sess");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    userId,
    expiresAt,
    new Date().toISOString(),
  );
  return sign(id);
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 86400,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const sessionId = unsign(token);
    if (sessionId) getDb().prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }
  store.delete(SESSION_COOKIE);
}

export async function getCurrentUser(): Promise<User | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const sessionId = unsign(token);
  if (!sessionId) return null;

  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.created_at AS createdAt, s.expires_at AS expiresAt
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .get(sessionId) as (User & { expiresAt: string }) | undefined;

  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, createdAt: row.createdAt };
}

/** Throws when unauthenticated - use in route handlers and server actions. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("You must be signed in to do that.");
    this.name = "UnauthorizedError";
  }
}
