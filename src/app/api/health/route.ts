import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * Health check for the hosting platform.
 *
 * Deliberately exercises the database rather than just returning 200: on a
 * container host the most likely failure is a persistent volume that did not
 * mount, and an endpoint that ignores storage would report "healthy" while
 * every signup fails.
 */
export async function GET() {
  try {
    const db = getDb();
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };

    return NextResponse.json({
      status: "ok",
      database: "reachable",
      users: n,
      // Surfaces which analyst engine is live without exposing the key itself.
      analyst: process.env.ANTHROPIC_API_KEY ? "claude" : "local",
      time: new Date().toISOString(),
    });
  } catch (error) {
    console.error("health check failed:", error);
    return NextResponse.json(
      {
        status: "error",
        database: "unreachable",
        hint: "Check that the persistent volume is mounted and ADMATE_DB_PATH points into it.",
      },
      { status: 503 },
    );
  }
}
