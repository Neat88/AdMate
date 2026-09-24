import type { EntityPerformance, MetricKey } from "@/lib/analysis/types";
import { METRIC_META } from "@/lib/analysis/types";
import { getMetric, type PerformanceModel } from "@/lib/analysis/metrics";
import type { ReportFacts } from "@/lib/analysis/facts";
import { describeChange } from "@/lib/analysis/facts";
import { fmtPct, fmtValue } from "@/lib/analysis/detectors";
import { metricLabel, objectiveForEntity, objectiveLabel, primaryCostMetric } from "@/lib/analysis/objectives";
import { relevanceNote } from "@/lib/analysis/glossary";
import type { AssistantFocus, Suggestion } from "./types";

/**
 * Deterministic conversation openers.
 *
 * When a user clicks "Ask" on a number, the panel opens instantly with a
 * factual sentence about that number and a few questions worth asking - no
 * model call, so it is free and immediate, and the first thing the assistant
 * says can never be wrong about the data.
 */

export interface OpenerContext {
  facts: ReportFacts;
  model: PerformanceModel;
  currency: string;
}

export interface Opener {
  label: string;
  text: string;
  suggestions: Suggestion[];
}

export function findEntity(model: PerformanceModel, entityId: string | null): EntityPerformance | null {
  if (!entityId || entityId === model.account.id) return model.account;
  return (
    model.campaigns.find((e) => e.id === entityId) ??
    model.adsets.find((e) => e.id === entityId) ??
    model.ads.find((e) => e.id === entityId) ??
    null
  );
}

export function entityDisplay(entity: EntityPerformance): string {
  if (entity.level === "account") return "the account";
  const noun = entity.level === "adset" ? "Ad set" : entity.level === "ad" ? "Ad" : "Campaign";
  return `${noun} "${entity.name}"`;
}

const SUGGESTIONS: Record<AssistantFocus["kind"], Suggestion[]> = {
  report: [
    { id: "prioritize", text: "What should I prioritize today?" },
    { id: "biggest_problem", text: "Show me the biggest problem" },
    { id: "whats_working", text: "What's working well?" },
    { id: "which_first", text: "Which ad should I check first?" },
    { id: "vs_previous", text: "How does this compare with my previous upload?" },
  ],
  metric: [
    { id: "why_change", text: "Why did this change?" },
    { id: "is_good", text: "Is this good?" },
    { id: "explain_metric", text: "Explain this metric" },
    { id: "what_to_do", text: "What should I do?" },
  ],
  diagnosis: [
    { id: "why_problem", text: "Why do you think this is the problem?" },
    { id: "should_pause", text: "Should I pause it?" },
    { id: "alternatives", text: "What if I don't want to do that?" },
    { id: "how_sure", text: "How sure are you?" },
  ],
  entity: [
    { id: "entity_health", text: "How is this doing?" },
    { id: "entity_drivers", text: "What's driving its results?" },
    { id: "what_to_do", text: "What should I do with it?" },
    { id: "compare_peers", text: "Compare it with similar campaigns" },
  ],
  change: [
    { id: "why_change", text: "What caused this?" },
    { id: "which_first", text: "Which ad should I check first?" },
    { id: "is_real", text: "Is this change real or noise?" },
  ],
};

export function focusLabel(focus: AssistantFocus, ctx: OpenerContext): string {
  switch (focus.kind) {
    case "report":
      return "Whole report";
    case "metric": {
      const entity = findEntity(ctx.model, focus.entityId);
      const objective = entity ? objectiveForEntity(entity, ctx.facts.objectives, ctx.facts.accountObjective) : null;
      const where = entity && entity.level !== "account" ? ` · ${entity.name}` : " · Account";
      return `${metricLabel(focus.metric, objective)}${where}`;
    }
    case "diagnosis": {
      const d = ctx.facts.diagnoses.find((x) => x.id === focus.diagnosisId);
      return d ? `${d.title} · ${d.entityName}` : "Recommendation";
    }
    case "entity": {
      const entity = findEntity(ctx.model, focus.entityId);
      return entity ? `${entity.level === "account" ? "Account" : entity.name}` : "Entity";
    }
    case "change":
      return `What changed · ${metricLabel(focus.metric, ctx.facts.accountObjective)}`;
  }
}

export function buildOpener(focus: AssistantFocus, ctx: OpenerContext): Opener {
  const { facts, model, currency } = ctx;
  const label = focusLabel(focus, ctx);
  const suggestions = SUGGESTIONS[focus.kind];

  if (focus.kind === "report") {
    return { label, text: `${facts.briefing.verdict} Ask me about anything in this report.`, suggestions };
  }

  if (focus.kind === "diagnosis") {
    const d = facts.diagnoses.find((x) => x.id === focus.diagnosisId);
    if (!d) return { label, text: "Ask me about this recommendation.", suggestions };
    return {
      label,
      text: `${d.summary} I've grouped this as "${d.title}" and suggest: ${d.actionLabel.toLowerCase()}. I can walk you through the evidence, how sure I am, or other options.`,
      suggestions,
    };
  }

  if (focus.kind === "change") {
    const w = facts.whatChanged.find((x) => x.metric === focus.metric);
    return {
      label,
      text: w
        ? `${describeChange(w, facts.accountObjective, currency)} I can explain what caused it and where to look first.`
        : "Ask me what changed between the two halves of this report.",
      suggestions,
    };
  }

  const entity =
    focus.kind === "entity" ? findEntity(model, focus.entityId) : findEntity(model, focus.entityId);
  if (!entity) return { label, text: "Ask me about this.", suggestions };
  const objective = objectiveForEntity(entity, facts.objectives, facts.accountObjective);

  if (focus.kind === "entity") {
    const primary = primaryCostMetric(entity, objective);
    const spend = getMetric(entity.metrics, "spend");
    const parts = [`${entityDisplay(entity)} is judged as ${objectiveLabel(objective).toLowerCase()}.`];
    if (spend !== null) parts.push(`It spent ${fmtValue(spend, "currency", currency)}.`);
    if (primary) {
      const v = getMetric(entity.metrics, primary.cost);
      const change = entity.periodComparison?.deltas[primary.cost]?.changePct ?? null;
      parts.push(
        `${metricLabel(primary.cost, objective)} is ${fmtValue(v, METRIC_META[primary.cost].format, currency)}${change !== null ? ` (${fmtPct(change)} vs the prior half)` : ""}.`,
      );
    }
    const flagged = facts.diagnoses.filter((d) => d.entityName === entity.name && d.level === entity.level);
    if (flagged.length > 0) parts.push(`AdMate flagged: ${flagged.map((d) => d.title.toLowerCase()).join("; ")}.`);
    return { label, text: parts.join(" "), suggestions };
  }

  // Metric focus.
  const metric = focus.metric;
  const value = getMetric(entity.metrics, metric);
  const delta = entity.periodComparison?.deltas[metric];
  const mLabel = metricLabel(metric, objective);
  const parts: string[] = [];
  parts.push(
    `${mLabel}${entity.level === "account" ? "" : ` for ${entityDisplay(entity)}`} is ${fmtValue(value, METRIC_META[metric].format, currency)}${
      delta?.changePct != null && delta.previous !== null
        ? `, ${delta.changePct > 0 ? "up" : "down"} ${fmtPct(Math.abs(delta.changePct)).replace("+", "")} from ${fmtValue(delta.previous, METRIC_META[metric].format, currency)} in the prior half of the report`
        : ""
    }.`,
  );
  const note = relevanceNote(metric, objective);
  if (note) parts.push(note);
  parts.push("I can explain what it means, what moved it, or what to do about it.");
  return { label, text: parts.join(" "), suggestions };
}

export function isMetric(key: string): key is MetricKey {
  return key in METRIC_META;
}
