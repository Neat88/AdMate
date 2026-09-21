import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInsight, renderLocally, type ClaudePayloadInsight } from "@/lib/ai/insights";
import type { Finding } from "../detectors";

/**
 * The validation gate is the reason AdMate can put an LLM in front of budget
 * decisions. These tests pin the guarantee: a model response that cites a
 * number the evidence does not support must never reach the user.
 */

const finding: Finding = {
  id: "cpa_spike:campaign:summer:0",
  code: "cpa_spike",
  kind: "issue",
  level: "campaign",
  entityName: "Summer Skincare Promotion",
  campaign: "Summer Skincare Promotion",
  adset: null,
  title: "Cost per conversion increased",
  headline: "CPA moved from $10.77 to $22.26.",
  priority: "high",
  severityScore: 98,
  confidence: "high",
  confidenceReason: "7 days vs 7 days.",
  evidence: [
    { label: "CPA", metric: "cpa", value: 22.26, comparison: 10.77, comparisonLabel: "Prior period", changePct: 1.067, format: "currency" },
    { label: "Conversions", metric: "conversions", value: 134, comparison: 201, changePct: -0.333, format: "decimal" },
  ],
  hypotheses: ["Conversion rate fell."],
  actions: ["Check tracking."],
  monitor: ["CPA"],
  spendAtStake: 2982.5,
  context: {},
};

function candidate(overrides: Partial<ClaudePayloadInsight> = {}): ClaudePayloadInsight {
  return {
    findingId: finding.id,
    whatHappened: "CPA rose from $10.77 to $22.26 while conversions fell to 134.",
    possibleCauses: ["Conversion rate declined after the click."],
    recommendedActions: ["Verify the conversion event fires.", "Compare creative performance."],
    monitor: ["CPA over the next 7 days"],
    ...overrides,
  };
}

test("an insight citing only evidence figures is accepted", () => {
  assert.equal(validateInsight(candidate(), finding, "USD").ok, true);
});

test("an insight citing a figure absent from the evidence is rejected", () => {
  const result = validateInsight(
    candidate({ whatHappened: "CPA rose to $22.26 and ROAS fell to 1.87x." }),
    finding,
    "USD",
  );
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /unverifiable figure/);
});

test("a fabricated figure inside a recommended action is rejected", () => {
  const result = validateInsight(
    candidate({ recommendedActions: ["Cut the budget by $4,912 to protect margin."] }),
    finding,
    "USD",
  );
  assert.equal(result.ok, false);
});

test("guaranteed-outcome language is rejected", () => {
  const result = validateInsight(
    candidate({ recommendedActions: ["Refresh the creative — this will improve your CPA."] }),
    finding,
    "USD",
  );
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /guaranteed outcome/);
});

test("an insight with no actions is rejected", () => {
  assert.equal(validateInsight(candidate({ recommendedActions: [] }), finding, "USD").ok, false);
});

test("an empty observation is rejected", () => {
  assert.equal(validateInsight(candidate({ whatHappened: "" }), finding, "USD").ok, false);
});

test("ordinary prose numbers do not trigger a false rejection", () => {
  const result = validateInsight(
    candidate({
      recommendedActions: [
        "Increase budget by 20-30% at a time and re-measure after 7 days.",
        "Review the top 3 creatives before making changes.",
      ],
    }),
    finding,
    "USD",
  );
  assert.equal(result.ok, true, "rejected structural prose as if it were a data claim");
});

test("rounding within 2% of an evidence value is tolerated", () => {
  const result = validateInsight(
    candidate({ whatHappened: "CPA rose from $10.80 to $22.30, roughly 107%." }),
    finding,
    "USD",
  );
  assert.equal(result.ok, true);
});

test("the local engine produces the full five-part structure without an API key", () => {
  const bundle = renderLocally([finding], "USD", "Account summary text.");
  assert.equal(bundle.engine, "local");
  assert.equal(bundle.insights.length, 1);

  const insight = bundle.insights[0];
  assert.ok(insight.whatHappened.length > 0, "missing: what happened");
  assert.ok(insight.evidenceSummary.includes("22.26"), "evidence summary lost the computed figure");
  assert.ok(insight.possibleCauses.length > 0, "missing: possible causes");
  assert.ok(insight.recommendedActions.length > 0, "missing: recommended actions");
  assert.ok(insight.monitor.length > 0, "missing: what to monitor");
});

test("evidence summaries are rendered from computed values, not model text", () => {
  const bundle = renderLocally([finding], "USD", "summary");
  // Both engines call renderEvidence, so the figures are identical whichever
  // engine narrates the insight.
  assert.match(bundle.insights[0].evidenceSummary, /CPA: \$22\.26 vs \$10\.77/);
});
