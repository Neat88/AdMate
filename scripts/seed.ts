/**
 * Seeds a demo account so the product can be explored without uploading
 * anything first. Idempotent: re-running replaces the demo user's data.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/lib/db/schema";
import { hashPassword, newId } from "../src/lib/db/auth";
import { createWorkspace, saveReport } from "../src/lib/db/queries";
import { parseCsv, normalizeRows } from "../src/lib/analysis/parse";
import { mapColumns, detectPlatform } from "../src/lib/analysis/columns";
import { analyzeAndSaveReport } from "../src/lib/analysis/analyze-report";

const DEMO_EMAIL = "demo@admate.app";
const DEMO_PASSWORD = "admate-demo-2026";

const SEEDS = [
  { file: "meta-ads-14-days.csv", workspace: "Acme Skincare", currency: "USD", objective: "Conversions / Sales" },
  { file: "google-ads-10-days.csv", workspace: "Acme Skincare", currency: "USD", objective: "Conversions / Sales" },
  { file: "tiktok-ads-no-dates.csv", workspace: "Northwind Apparel", currency: "USD", objective: "Traffic" },
];

async function main() {
  const db = getDb();

  // Start clean so the demo account is reproducible.
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(DEMO_EMAIL) as
    | { id: string }
    | undefined;
  if (existing) {
    db.prepare("DELETE FROM users WHERE id = ?").run(existing.id);
    console.log("removed previous demo account");
  }

  const userId = newId("usr");
  db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
    userId,
    DEMO_EMAIL,
    "Demo Marketer",
    hashPassword(DEMO_PASSWORD),
    new Date().toISOString(),
  );

  const workspaces = new Map<string, string>();

  for (const seed of SEEDS) {
    let workspaceId = workspaces.get(seed.workspace);
    if (!workspaceId) {
      workspaceId = createWorkspace(userId, seed.workspace, seed.currency).id;
      workspaces.set(seed.workspace, workspaceId);
    }

    const csv = fs.readFileSync(path.join(process.cwd(), "sample-data", seed.file), "utf8");
    const table = parseCsv(csv);
    const platform = detectPlatform(table.headers).platform;
    const mappings = mapColumns(table.headers, table.rows, platform);
    const normalized = normalizeRows(table, mappings);

    const reportId = saveReport({
      userId,
      workspaceId,
      filename: seed.file,
      platform,
      currency: seed.currency,
      objective: seed.objective,
      periodStart: normalized.dateRange?.start ?? null,
      periodEnd: normalized.dateRange?.end ?? null,
      mappings,
      issues: normalized.issues,
      rows: normalized.rows,
    });

    const { analysis } = await analyzeAndSaveReport({
      userId,
      reportId,
      workspaceId,
      rows: normalized.rows,
      platform,
      currency: seed.currency,
      objective: seed.objective,
      periodStart: normalized.dateRange?.start ?? null,
      periodEnd: normalized.dateRange?.end ?? null,
      issues: normalized.issues,
    });

    console.log(
      `seeded ${seed.file} -> ${seed.workspace}: ${analysis.findings.length} findings, ${analysis.alertEvents.length} alerts (${analysis.insights.engine} engine)`,
    );
  }

  console.log(`\nDemo account ready:\n  email:    ${DEMO_EMAIL}\n  password: ${DEMO_PASSWORD}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
