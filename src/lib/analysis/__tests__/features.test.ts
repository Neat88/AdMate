import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedRow } from "../types";
import { buildPerformanceModel } from "../metrics";
import { resolveCampaignObjectives } from "../objectives";
import { detectFindings } from "../detectors";
import { buildFacts } from "../facts";
import { compareReports } from "../history";
import { analyzeAndSaveReport } from "../analyze-report";
import * as q from "@/lib/db/queries";
import { getDb } from "@/lib/db/schema";

// The database opens lazily on first use, and every test file runs in its own
// process, so pointing it at a temp file here keeps it private to this file.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "admate-test-"));
process.env.ADMATE_DB_PATH = path.join(dbDir, "test.db");

function day(month: number, d: number): string {
  return `2026-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function rowsFor(month: number, days: number, cpaFactor: number, campaigns: string[]): NormalizedRow[] {
  const rows: NormalizedRow[] = [];
  for (let d = 1; d <= days; d++) {
    for (const c of campaigns) {
      rows.push({
        date: day(month, d),
        campaign: c,
        adset: "Set",
        ad: "Ad",
        metrics: { spend: 100, impressions: 10000, clicks: 200, conversions: Math.round(10 / cpaFactor) },
      });
    }
  }
  return rows;
}

test("a user's objective correction wins and changes what the campaign is judged on", () => {
  const rows = rowsFor(9, 14, 1, ["Prospecting", "Blog Push"]);
  const model = buildPerformanceModel(rows);
  const auto = resolveCampaignObjectives(model, rows, null);
  assert.equal(auto["Blog Push"].objective, "sales");
  const corrected = resolveCampaignObjectives(model, rows, null, { "Blog Push": "traffic" });
  assert.equal(corrected["Blog Push"].objective, "traffic");
  assert.equal(corrected["Blog Push"].source, "user");
});

test("report-over-report comparison normalises totals per day and tests efficiency changes", () => {
  const prevRows = rowsFor(8, 7, 1, ["A", "B", "Old"]);
  const currRows = rowsFor(9, 14, 2, ["A", "B", "New"]); // CPA doubled; 14 days vs 7
  const prevModel = buildPerformanceModel(prevRows);
  const model = buildPerformanceModel(currRows);
  const objectives = resolveCampaignObjectives(model, currRows, "Conversions / Sales");
  const { findings, accountObjective } = detectFindings(model, "USD", { objectives });
  const facts = buildFacts({ model, findings, objectives, accountObjective, issues: [], currency: "USD" });
  const h = compareReports(
    { model, facts, report: { periodStart: day(9, 1), periodEnd: day(9, 14) } },
    { model: prevModel, report: { id: "p", filename: "prev.csv", periodStart: day(8, 1), periodEnd: day(8, 7), createdAt: "" } },
  );
  const spend = h.account.find((m) => m.metric === "spend")!;
  assert.equal(spend.perDay, true);
  assert.ok(Math.abs(spend.changePct ?? 1) < 1e-9, "per-day spend was unchanged but a change was reported");
  const cpa = h.account.find((m) => m.metric === "cpa")!;
  assert.ok((cpa.changePct ?? 0) > 0.9);
  assert.equal(cpa.worsened, true);
  assert.equal(cpa.strength, "strong");
  assert.deepEqual(h.newCampaigns, ["New"]);
  assert.deepEqual(h.stoppedCampaigns, ["Old"]);
});

test("re-analysing keeps the user's recommendation statuses", async () => {
  const db = getDb();
  db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1','a@x','A','x',?)").run(new Date().toISOString());
  const ws = q.createWorkspace("u1", "WS");
  const rows = [...rowsFor(9, 7, 1, ["Sales A", "Sales B"]), ...rowsFor(9, 14, 1, ["Sales A"]).filter((r) => r.date! > day(9, 7)).map((r) => ({ ...r, metrics: { ...r.metrics, conversions: 3 } }))];
  const reportId = q.saveReport({
    userId: "u1", workspaceId: ws.id, filename: "r.csv", platform: "meta", currency: "USD", objective: null,
    periodStart: day(9, 1), periodEnd: day(9, 14), mappings: [], issues: [], rows,
  });
  const args = {
    userId: "u1", reportId, workspaceId: ws.id, rows, platform: "meta" as const, currency: "USD", objective: null,
    periodStart: day(9, 1), periodEnd: day(9, 14), issues: [],
  };
  const first = await analyzeAndSaveReport(args);
  const recs = q.listRecommendationsForAnalysis("u1", first.analysisId);
  assert.ok(recs.length > 0, "fixture produced no recommendations");
  q.updateRecommendationStatus("u1", recs[0].id, "action_taken", "done");

  const second = await analyzeAndSaveReport(args);
  const after = q.listRecommendationsForAnalysis("u1", second.analysisId).find(
    (r) => r.code === recs[0].code && r.entityName === recs[0].entityName,
  );
  assert.equal(after?.status, "action_taken");
  assert.equal(after?.note, "done");
});

test("only an answer from the user's own conversation on that report can be pinned", () => {
  const db = getDb();
  db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u2','b@x','B','x',?)").run(new Date().toISOString());
  const reports = q.listReports("u1");
  const reportId = reports[0].id;
  const conv = q.createConversation("u1", reportId);
  q.addMessage({ userId: "u1", conversationId: conv.id, role: "user", content: { text: "Why?" } });
  const answerId = q.addMessage({ userId: "u1", conversationId: conv.id, role: "assistant", content: { answer: { blocks: {} } } });

  const own = q.getAnswerWithQuestion("u1", reportId, answerId);
  assert.equal(own?.question, "Why?");
  assert.equal(q.getAnswerWithQuestion("u2", reportId, answerId), null, "another user could pin this answer");
  assert.equal(q.getAnswerWithQuestion("u1", "rep_other", answerId), null, "answer pinned to a different report");
});
