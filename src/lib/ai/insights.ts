import Anthropic from "@anthropic-ai/sdk";
import type { Finding } from "@/lib/analysis/detectors";
import { fmtValue } from "@/lib/analysis/detectors";
import { METRIC_META } from "@/lib/analysis/types";

/**
 * The AI analyst layer.
 *
 * Division of labour, deliberately strict:
 *   - Every number shown to the user is computed in src/lib/analysis.
 *   - The model receives those numbers as pre-formatted evidence and writes
 *     the *explanation* around them.
 *   - Anything the model returns is validated before display (see validate()).
 *
 * If ANTHROPIC_API_KEY is absent the product still works: `renderLocally`
 * produces the same five-part structure from the deterministic finding. The
 * insight content is thinner, but no number changes.
 */

export type InsightEngine = "claude" | "local";

/** The five-part framework every insight follows. */
export interface Insight {
  findingId: string;
  /** 1. What happened */
  whatHappened: string;
  /** 2. What data supports this (rendered from evidence, never from the model) */
  evidenceSummary: string;
  /** 3. Why this might be happening - explicitly hypotheses */
  possibleCauses: string[];
  /** 4. What to do next */
  recommendedActions: string[];
  /** 5. What to monitor afterwards */
  monitor: string[];
  /** Stated when the report lacks the data needed to explain the finding. */
  dataGaps: string[];
  engine: InsightEngine;
}

export interface InsightBundle {
  insights: Insight[];
  /** Short account-level narrative for the dashboard and report header. */
  executiveSummary: string;
  engine: InsightEngine;
  /** Populated when Claude was attempted but fell back. */
  fallbackReason: string | null;
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/* -------------------------------------------------------------------------- */
/* Evidence rendering (deterministic - shared by both engines)                */
/* -------------------------------------------------------------------------- */

function renderEvidence(finding: Finding, currency: string): string {
  const parts = finding.evidence
    .filter((e) => e.value !== null)
    .map((e) => {
      const value = fmtValue(e.value, e.format, currency);
      if (e.comparison !== null && e.comparison !== undefined) {
        const comp = fmtValue(e.comparison, e.format, currency);
        const change =
          e.changePct !== null && e.changePct !== undefined
            ? ` (${e.changePct > 0 ? "+" : ""}${(e.changePct * 100).toFixed(1)}%)`
            : "";
        return `${e.label}: ${value} vs ${comp} ${e.comparisonLabel ?? ""}${change}`.trim();
      }
      return `${e.label}: ${value}`;
    });
  return parts.join(" · ");
}

/** Metrics a finding would need in order to be explained but that are absent. */
function detectDataGaps(finding: Finding): string[] {
  const gaps: string[] = [];
  const present = new Set(finding.evidence.filter((e) => e.value !== null).map((e) => e.metric));

  if (finding.code.startsWith("cpa") || finding.code === "spend_no_conversions") {
    if (!present.has("cvr") && !present.has("clicks")) {
      gaps.push("Click data would separate a delivery problem from a conversion problem.");
    }
    if (!present.has("frequency")) {
      gaps.push("Frequency is not in this report, so audience saturation cannot be assessed.");
    }
  }
  if (finding.code === "ctr_drop" && !present.has("frequency")) {
    gaps.push("Frequency would confirm or rule out creative fatigue as the cause of the CTR decline.");
  }
  if (!present.has("revenue") && (finding.code.includes("cpa") || finding.code.includes("roas"))) {
    gaps.push("Conversion value is not in this report, so the change cannot be judged against revenue.");
  }
  return gaps;
}

/* -------------------------------------------------------------------------- */
/* Local (no-API-key) engine                                                  */
/* -------------------------------------------------------------------------- */

export function renderLocally(findings: Finding[], currency: string, accountSummary: string): InsightBundle {
  const insights: Insight[] = findings.map((finding) => ({
    findingId: finding.id,
    whatHappened: finding.headline,
    evidenceSummary: renderEvidence(finding, currency),
    possibleCauses: finding.hypotheses,
    recommendedActions: finding.actions,
    monitor: finding.monitor,
    dataGaps: detectDataGaps(finding),
    engine: "local" as const,
  }));

  return {
    insights,
    executiveSummary: accountSummary,
    engine: "local",
    fallbackReason: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Claude engine                                                              */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = `You are the analyst voice of AdMate, a paid-media analysis product.

You are given findings that have ALREADY been detected and calculated by a deterministic engine from a marketer's uploaded ad report. Your job is to write the explanation around those findings - not to compute, re-derive, or estimate anything.

Absolute rules:
1. Never state a number that is not present in the evidence you were given. Do not round differently, do not compute new ratios, do not extrapolate.
2. Never present a possible cause as a confirmed fact. The data shows correlation and magnitude; it rarely shows cause. Use language like "this pattern is consistent with", "a likely explanation is", "this would also be explained by".
3. Never promise an outcome. Do not say an action "will" improve performance. Say what it tests, or what it would tell the marketer.
4. Never reference campaigns, ad sets, ads, metrics, platforms or date ranges that are not in the input.
5. If the evidence is too thin to explain the finding, say what additional data would be needed. This is more useful than a confident guess.
6. Write for a working marketer: direct, specific, no filler, no marketing-speak. Avoid "leverage", "unlock", "supercharge", "game-changing".

Actions must be things a person can actually do this week in an ad account or on a website. Prefer diagnosis before spending changes, because acting on a tracking bug as though it were a performance problem makes things worse.

Return ONLY valid JSON matching the requested schema. No prose outside the JSON.`;

export interface ClaudePayloadInsight {
  findingId: string;
  whatHappened: string;
  possibleCauses: string[];
  recommendedActions: string[];
  monitor: string[];
  dataGaps?: string[];
}

interface ClaudePayload {
  executiveSummary: string;
  insights: ClaudePayloadInsight[];
}

function buildUserPrompt(
  findings: Finding[],
  currency: string,
  context: AnalysisContext,
): string {
  const lines: string[] = [];
  lines.push("# Report context");
  lines.push(`- Platform: ${context.platformLabel}`);
  lines.push(`- Currency: ${currency}`);
  lines.push(`- Reporting period: ${context.period}`);
  if (context.objective) lines.push(`- Stated campaign objective: ${context.objective}`);
  lines.push(`- Structure available: ${context.levels}`);
  lines.push(`- Metrics available in this report: ${context.availableMetrics}`);
  if (context.missingMetrics) lines.push(`- Metrics NOT in this report (do not discuss as if present): ${context.missingMetrics}`);
  lines.push("");
  lines.push("# Account totals");
  lines.push(context.accountTotals);
  lines.push("");
  lines.push("# Findings to narrate");

  findings.forEach((f, i) => {
    lines.push("");
    lines.push(`## Finding ${i + 1} (id: ${f.id})`);
    lines.push(`- Type: ${f.kind}`);
    lines.push(`- Entity: ${f.level} "${f.entityName}"${f.campaign && f.level !== "campaign" ? ` (in campaign "${f.campaign}")` : ""}`);
    lines.push(`- Detected: ${f.title}`);
    lines.push(`- Deterministic statement of fact: ${f.headline}`);
    lines.push(`- Priority: ${f.priority} (severity score ${f.severityScore}/100)`);
    lines.push(`- Confidence: ${f.confidence} - ${f.confidenceReason}`);
    lines.push("- Evidence (these are the ONLY numbers you may cite):");
    for (const e of f.evidence) {
      if (e.value === null) {
        lines.push(`    - ${e.label}: not reported in this file`);
        continue;
      }
      let line = `    - ${e.label}: ${fmtValue(e.value, e.format, currency)}`;
      if (e.comparison !== null && e.comparison !== undefined) {
        line += ` (vs ${fmtValue(e.comparison, e.format, currency)} ${e.comparisonLabel ?? ""}`;
        if (e.changePct !== null && e.changePct !== undefined) {
          line += `, change ${e.changePct > 0 ? "+" : ""}${(e.changePct * 100).toFixed(1)}%`;
        }
        line += ")";
      }
      lines.push(line);
    }
    if (f.hypotheses.length) {
      lines.push("- Candidate explanations identified by the engine (refine these; do not contradict the evidence):");
      f.hypotheses.forEach((h) => lines.push(`    - ${h}`));
    }
    lines.push("- Baseline actions from the engine (improve specificity where the evidence allows):");
    f.actions.forEach((a) => lines.push(`    - ${a}`));
  });

  lines.push("");
  lines.push("# Output");
  lines.push(
    `Return JSON: {"executiveSummary": string, "insights": [{"findingId": string, "whatHappened": string, "possibleCauses": string[], "recommendedActions": string[], "monitor": string[], "dataGaps": string[]}]}`,
  );
  lines.push("");
  lines.push("Requirements:");
  lines.push("- One insight object per finding, using the exact findingId given.");
  lines.push("- whatHappened: 1-2 sentences, plain statement of the observation with the key figures.");
  lines.push("- possibleCauses: 2-4 items, each phrased as a hypothesis, ordered most to least likely given the evidence.");
  lines.push("- recommendedActions: 2-4 concrete steps, ordered by what to do first. Diagnosis before budget changes.");
  lines.push("- monitor: 2-3 metrics or signals that would show whether the action worked.");
  lines.push("- dataGaps: list what extra data would sharpen the diagnosis, or [] if the evidence is sufficient.");
  lines.push(
    "- executiveSummary: 3-5 sentences for a marketer opening this report cold. State overall account health, the single most important issue, and what to look at first. Cite only figures from the account totals or the findings above.",
  );

  return lines.join("\n");
}

export interface AnalysisContext {
  platformLabel: string;
  period: string;
  objective: string | null;
  levels: string;
  availableMetrics: string;
  missingMetrics: string;
  accountTotals: string;
}

/**
 * Rejects model output that cites numbers or entities not present in the
 * evidence. A failed validation degrades that one insight to the deterministic
 * rendering rather than dropping it - the user still sees the finding.
 */
export function validateInsight(
  candidate: ClaudePayloadInsight,
  finding: Finding,
  currency: string,
): { ok: true } | { ok: false; reason: string } {
  const text = [
    candidate.whatHappened,
    ...(candidate.possibleCauses ?? []),
    ...(candidate.recommendedActions ?? []),
    ...(candidate.monitor ?? []),
  ].join(" ");

  if (!candidate.whatHappened || candidate.whatHappened.trim().length < 10) {
    return { ok: false, reason: "empty whatHappened" };
  }
  if (!Array.isArray(candidate.recommendedActions) || candidate.recommendedActions.length === 0) {
    return { ok: false, reason: "no recommended actions" };
  }

  // Build the set of numeric tokens the model is allowed to use: every
  // evidence value in each of its plausible renderings, plus the percentages.
  const allowed = new Set<string>();
  const allow = (n: number) => {
    for (const s of [
      n.toFixed(0),
      n.toFixed(1),
      n.toFixed(2),
      String(n),
      Math.round(n).toLocaleString("en-US"),
      (n * 100).toFixed(0),
      (n * 100).toFixed(1),
      (n * 100).toFixed(2),
    ]) {
      allowed.add(s.replace(/,/g, ""));
    }
  };
  for (const e of finding.evidence) {
    if (e.value !== null) allow(e.value);
    if (e.comparison !== null && e.comparison !== undefined) allow(e.comparison);
    if (e.changePct !== null && e.changePct !== undefined) {
      allow(e.changePct);
      allow(Math.abs(e.changePct));
    }
  }
  allow(finding.severityScore);
  for (const value of Object.values(finding.context)) {
    if (typeof value === "number") allow(value);
  }
  // Small integers are almost always structural prose ("the next 7 days",
  // "20-30%", "step 1"), not data claims. Allowing them avoids rejecting
  // perfectly good advice.
  for (let i = 0; i <= 100; i++) allowed.add(String(i));

  const numbers = text.match(/\d[\d,]*\.?\d*/g) ?? [];
  for (const raw of numbers) {
    const cleaned = raw.replace(/,/g, "");
    if (allowed.has(cleaned)) continue;
    const asNumber = Number(cleaned);
    if (!Number.isFinite(asNumber)) continue;
    // Tolerate rounding differences against any allowed value.
    const near = [...allowed].some((a) => {
      const an = Number(a);
      if (!Number.isFinite(an) || an === 0) return false;
      return Math.abs(an - asNumber) / Math.abs(an) < 0.02;
    });
    if (!near) {
      return { ok: false, reason: `cites unverifiable figure "${raw}"` };
    }
  }

  // Guard against forbidden certainty about outcomes.
  if (/\bwill (increase|improve|boost|double|guarantee|reduce your)\b/i.test(text)) {
    return { ok: false, reason: "promises a guaranteed outcome" };
  }

  void currency;
  return { ok: true };
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model response");
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function generateInsights(
  findings: Finding[],
  currency: string,
  context: AnalysisContext,
  accountSummary: string,
): Promise<InsightBundle> {
  const local = renderLocally(findings, currency, accountSummary);
  if (findings.length === 0) return local;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return local;

  // Narrate the highest-severity findings; the long tail keeps the
  // deterministic rendering, which keeps latency and cost predictable.
  const narrated = findings.slice(0, 12);

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: process.env.ADMATE_MODEL || "claude-sonnet-5",
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(narrated, currency, context) }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const payload = extractJson(text) as ClaudePayload;
    if (!payload || !Array.isArray(payload.insights)) throw new Error("Malformed response shape");

    const byId = new Map(payload.insights.map((i) => [i.findingId, i]));
    const rejected: string[] = [];

    const insights: Insight[] = findings.map((finding) => {
      const candidate = byId.get(finding.id);
      const fallback = local.insights.find((i) => i.findingId === finding.id)!;
      if (!candidate) return fallback;

      const check = validateInsight(candidate, finding, currency);
      if (!check.ok) {
        rejected.push(`${finding.id}: ${check.reason}`);
        return fallback;
      }

      return {
        findingId: finding.id,
        whatHappened: candidate.whatHappened.trim(),
        // Evidence is always rendered from the computed numbers, never echoed
        // back from the model.
        evidenceSummary: renderEvidence(finding, currency),
        possibleCauses:
          Array.isArray(candidate.possibleCauses) && candidate.possibleCauses.length > 0
            ? candidate.possibleCauses
            : finding.hypotheses,
        recommendedActions: candidate.recommendedActions,
        monitor:
          Array.isArray(candidate.monitor) && candidate.monitor.length > 0 ? candidate.monitor : finding.monitor,
        dataGaps: Array.isArray(candidate.dataGaps) ? candidate.dataGaps : detectDataGaps(finding),
        engine: "claude" as const,
      };
    });

    const summary =
      typeof payload.executiveSummary === "string" && payload.executiveSummary.trim().length > 30
        ? payload.executiveSummary.trim()
        : accountSummary;

    return {
      insights,
      executiveSummary: summary,
      engine: "claude",
      fallbackReason:
        rejected.length > 0
          ? `${rejected.length} insight(s) failed evidence validation and were rendered from the deterministic engine instead.`
          : null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ...local, fallbackReason: `Claude request failed (${reason}). Showing deterministic analysis.` };
  }
}

export { renderEvidence, detectDataGaps, METRIC_META };
