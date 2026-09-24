import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseCsv, normalizeRows } from "../parse";
import { mapColumns } from "../columns";
import { buildPerformanceModel } from "../metrics";
import { detectFindings } from "../detectors";
import { resolveCampaignObjectives } from "../objectives";
import { buildFacts } from "../facts";
import type { ReportRecord } from "@/lib/db/queries";
import { NumberLedger } from "@/lib/ai/ledger";
import { questionContext, reportHeader, resolveTargets, type ReportContext } from "@/lib/assistant/context";
import { localAnswer, intentOf } from "@/lib/assistant/local";
import { checkAnswer } from "@/lib/assistant/engine";
import { buildOpener } from "@/lib/assistant/openers";

/**
 * The assistant's guarantees: it answers from the report it is attached to,
 * it resolves "this" from what the user clicked, and anything it says with a
 * number or a name that the report doesn't contain is caught before display.
 */

function buildContext(): ReportContext {
  const file = path.join(process.cwd(), "sample-data", "meta-ads-14-days.csv");
  const table = parseCsv(fs.readFileSync(file, "utf8"));
  const result = normalizeRows(table, mapColumns(table.headers, table.rows));
  const model = buildPerformanceModel(result.rows);
  const objectives = resolveCampaignObjectives(model, result.rows, "Conversions / Sales");
  const { findings, accountObjective } = detectFindings(model, "USD", { objectives });
  const facts = buildFacts({ model, findings, objectives, accountObjective, issues: result.issues, currency: "USD" });
  const report: ReportRecord = {
    id: "rep_test",
    workspaceId: "ws",
    filename: "meta.csv",
    platform: "meta",
    currency: "USD",
    objective: "Conversions / Sales",
    periodStart: "2026-08-25",
    periodEnd: "2026-09-07",
    rowCount: result.rows.length,
    createdAt: new Date().toISOString(),
  };
  return { report, model, facts, findings: new Map(findings.map((f) => [f.id, f])), loadRows: () => result.rows };
}

const ctx = buildContext();

test("a clicked recommendation is the context for 'should I pause it?'", () => {
  const d = ctx.facts.diagnoses[0];
  const targets = resolveTargets("Should I pause it?", { kind: "diagnosis", diagnosisId: d.id }, null, ctx);
  assert.ok(targets.diagnoses.includes(d));
  assert.equal(targets.entities[0]?.name, d.level === "account" ? "Account total" : d.entityName);
});

test("a follow-up without a focus inherits what the conversation was about", () => {
  const campaign = ctx.model.campaigns[0];
  const targets = resolveTargets("What caused that?", { kind: "report" }, { kind: "entity", entityId: campaign.id }, ctx);
  assert.equal(targets.entities[0].id, campaign.id);
});

test("an entity named in the question wins over the focus", () => {
  const targets = resolveTargets(
    "How is Retargeting - Cart Abandoners doing on CTR?",
    { kind: "entity", entityId: ctx.model.campaigns[0].id },
    null,
    ctx,
  );
  assert.ok(targets.entities.some((e) => e.name === "Retargeting - Cart Abandoners"));
  assert.ok(targets.metrics.includes("ctr"));
});

test("the context pack states what the report cannot answer", () => {
  assert.match(reportHeader(ctx), /NOT in this report/);
  assert.match(reportHeader(ctx), /placements/);
});

test("an answer citing only context figures passes; an invented figure is caught", () => {
  const targets = resolveTargets("Why did CPA go up?", { kind: "report" }, null, ctx);
  const header = reportHeader(ctx);
  const context = questionContext(ctx, targets);
  const ledger = new NumberLedger();
  ledger.addText(header);
  ledger.addText(context);
  const known = `${header}\n${context}`;

  const grounded = localAnswer(ctx, targets, "why_change");
  assert.equal(checkAnswer({ blocks: grounded.blocks, followUps: [] }, ledger, known), null, "rejected an answer built from the report");

  const invented = { ...grounded.blocks, observation: "CPA rose to $48.19 because CPM hit $91.37." };
  assert.match(checkAnswer({ blocks: invented, followUps: [] }, ledger, known) ?? "", /not in the data/);
});

test("an answer naming a campaign that doesn't exist is caught", () => {
  const ledger = new NumberLedger();
  const blocks = {
    observation: 'The problem is "Winter Clearance - Broad".',
    evidence: [],
    interpretation: "",
    recommendation: "",
    confidence: "",
    limitations: [],
  };
  assert.match(checkAnswer({ blocks, followUps: [] }, ledger, reportHeader(ctx)) ?? "", /does not appear/);
});

test("promised outcomes are caught", () => {
  const blocks = {
    observation: "Refreshing the creative will improve your CPA.",
    evidence: [],
    interpretation: "",
    recommendation: "",
    confidence: "",
    limitations: [],
  };
  assert.match(checkAnswer({ blocks, followUps: [] }, new NumberLedger(), "") ?? "", /promises/);
});

test("the built-in analyst answers every suggested question without an API key", () => {
  const ids = [
    "explain_metric", "why_change", "is_good", "what_to_do", "why_problem", "should_pause", "alternatives", "how_sure",
    "entity_health", "entity_drivers", "compare_peers", "which_first", "is_real", "prioritize", "biggest_problem", "whats_working", "vs_previous",
  ] as const;
  const d = ctx.facts.diagnoses[0];
  for (const id of ids) {
    const targets = resolveTargets("?", { kind: "diagnosis", diagnosisId: d.id }, null, ctx);
    const answer = localAnswer(ctx, targets, id);
    assert.ok(answer.blocks.observation.length > 0, `${id} produced no observation`);
    assert.equal(answer.engine, "local");
  }
});

test("free-text questions map to sensible intents", () => {
  assert.equal(intentOf("Should I pause it?"), "should_pause");
  assert.equal(intentOf("What if I don't want to pause it?"), "alternatives");
  assert.equal(intentOf("What should I prioritize today?"), "prioritize");
  assert.equal(intentOf("Why is CPA increasing?"), "why_change");
});

test("openers are deterministic sentences about the clicked number", () => {
  const opener = buildOpener({ kind: "metric", metric: "cpa", entityId: null }, { facts: ctx.facts, model: ctx.model, currency: "USD" });
  assert.match(opener.text, /\$/);
  assert.ok(opener.suggestions.length >= 3);
});

/* ------------------------- model path, with a fake client ----------------- */

import type Anthropic from "@anthropic-ai/sdk";
import { answerWithModel } from "@/lib/assistant/engine";

function message(content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"]): Anthropic.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "test",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

function fakeClient(replies: Anthropic.Message[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        calls.push(params);
        const next = replies.shift();
        if (!next) throw new Error("no more replies");
        return next;
      },
    },
  };
}

function text(t: string): Anthropic.ContentBlock {
  return { type: "text", text: t, citations: null } as unknown as Anthropic.ContentBlock;
}

test("the model can call a tool, and a grounded answer is returned as-is", async () => {
  const campaign = ctx.model.campaigns[0];
  const answer = {
    observation: `"${campaign.name}" is the largest campaign in the report.`,
    evidence: [],
    interpretation: "It carries most of the budget.",
    recommendation: "",
    confidence: "Based on the report's spend figures.",
    limitations: [],
    followUps: ["What changed?"],
  };
  const client = fakeClient([
    message([{ type: "tool_use", id: "t1", name: "get_entity", input: { name: campaign.name } } as unknown as Anthropic.ContentBlock], "tool_use"),
    message([text(JSON.stringify(answer))], "end_turn"),
  ]);
  const statuses: string[] = [];
  const targets = resolveTargets("Tell me about it", { kind: "entity", entityId: campaign.id }, null, ctx);
  const result = await answerWithModel({
    ctx, targets, message: "Tell me about it", history: [], earlierSummary: null, focusLabel: campaign.name,
    suggestionId: null, onStatus: (s) => statuses.push(s), client,
  });
  assert.equal(result.answer.engine, "claude");
  assert.equal(result.answer.blocks.observation, answer.observation);
  assert.ok(statuses.some((s) => s.startsWith("Looking up")));
  // The tool result went back to the model, and the report block is marked for caching.
  const second = client.calls[1];
  assert.ok(JSON.stringify(second.messages).includes("tool_result"));
  assert.ok(JSON.stringify(second.system).includes("ephemeral"));
});

test("an answer with an invented figure is retried once, then replaced by the built-in analyst", async () => {
  const bad = JSON.stringify({
    observation: "CPA will fall to $3.17 if you pause it.",
    evidence: ["CPA forecast: $3.17"],
    interpretation: "",
    recommendation: "",
    confidence: "",
    limitations: [],
    followUps: [],
  });
  const client = fakeClient([message([text(bad)], "end_turn"), message([text(bad)], "end_turn")]);
  const d = ctx.facts.diagnoses[0];
  const targets = resolveTargets("Should I pause it?", { kind: "diagnosis", diagnosisId: d.id }, null, ctx);
  const result = await answerWithModel({
    ctx, targets, message: "Should I pause it?", history: [], earlierSummary: null, focusLabel: d.title,
    suggestionId: "should_pause", onStatus: () => undefined, client,
  });
  assert.equal(client.calls.length, 2, "did not retry exactly once");
  assert.ok(JSON.stringify(client.calls[1].messages).includes("can't be shown"));
  assert.equal(result.answer.engine, "local");
  assert.ok(!JSON.stringify(result.answer).includes("3.17"), "the invented figure reached the user");
  assert.match(result.answer.notice ?? "", /accuracy check/);
});
