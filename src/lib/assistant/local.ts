import type { EntityPerformance, MetricKey } from "@/lib/analysis/types";
import { METRIC_META } from "@/lib/analysis/types";
import { getMetric } from "@/lib/analysis/metrics";
import { describeChange } from "@/lib/analysis/facts";
import { fmtPct, fmtShare, fmtValue, movementSignificance } from "@/lib/analysis/detectors";
import type { Diagnosis } from "@/lib/analysis/diagnoses";
import { TIER_META } from "@/lib/analysis/diagnoses";
import { analyzeDrivers, mainDrivers } from "@/lib/analysis/drivers";
import { metricLabel, objectiveForEntity, objectiveLabel, primaryCostMetric, type Objective } from "@/lib/analysis/objectives";
import { GLOSSARY, relevanceNote } from "@/lib/analysis/glossary";
import type { AnswerBlocks, AssistantAnswer, SuggestionId } from "./types";
import { describeEntityMetrics, entityForDiagnosis, historyLines, safeName, type ReportContext, type Targets } from "./context";

/**
 * The built-in analyst: deterministic answers to the suggested questions.
 *
 * Used when no API key is configured, when the daily AI quota is spent, and
 * as the fallback when a model answer fails validation. It can only say what
 * the facts layer knows, which is also exactly what makes it safe.
 */

function blocks(partial: Partial<AnswerBlocks>): AnswerBlocks {
  return {
    observation: partial.observation ?? "",
    evidence: partial.evidence ?? [],
    interpretation: partial.interpretation ?? "",
    recommendation: partial.recommendation ?? "",
    confidence: partial.confidence ?? "",
    limitations: partial.limitations ?? [],
  };
}

function who(e: EntityPerformance): string {
  if (e.level === "account") return "the account";
  const noun = e.level === "adset" ? "ad set" : e.level;
  return `${noun} "${safeName(e.name)}"`;
}

const FOLLOW_UPS: Partial<Record<SuggestionId, string[]>> = {
  why_change: ["Which ad should I check first?", "Is this change real or noise?", "What should I do?"],
  explain_metric: ["Why did this change?", "Is this good?", "What should I do?"],
  is_good: ["Why did this change?", "What should I do?"],
  what_to_do: ["What if I don't want to do that?", "How sure are you?"],
  why_problem: ["Should I pause it?", "How sure are you?"],
  should_pause: ["What if I don't want to do that?", "How sure are you?"],
  alternatives: ["How sure are you?", "What should I prioritize today?"],
  how_sure: ["What should I do?", "What if I don't want to do that?"],
  entity_health: ["What's driving its results?", "Compare it with similar campaigns"],
  entity_drivers: ["What should I do with it?", "Is this change real or noise?"],
  compare_peers: ["What should I do with it?"],
  which_first: ["Why do you think this is the problem?", "What should I do?"],
  is_real: ["What caused this?", "What should I do?"],
  prioritize: ["Show me the biggest problem", "What's working well?"],
  biggest_problem: ["Why do you think this is the problem?", "What if I don't want to do that?"],
  whats_working: ["What should I prioritize today?"],
  vs_previous: ["What should I prioritize today?", "Show me the biggest problem"],
};

/** Maps a free-text question onto the closest suggestion, for the no-key path. */
export function intentOf(message: string): SuggestionId {
  const m = message.toLowerCase();
  if (/priorit|today|first|focus on/.test(m)) return /\bad\b|which/.test(m) ? "which_first" : "prioritize";
  if (/biggest problem|worst/.test(m)) return "biggest_problem";
  if (/working|best|winning/.test(m)) return "whats_working";
  if (/(don['’]t|do not|rather not|instead|alternative|other option)/.test(m)) return "alternatives";
  if (/pause|stop|turn off|kill/.test(m)) return "should_pause";
  if (/sure|confident|certain|trust/.test(m)) return "how_sure";
  if (/real|noise|significant|chance/.test(m)) return "is_real";
  if (/previous|last (upload|report|file|week|month)|since last|before this/.test(m)) return "vs_previous";
  if (/compare|versus|vs\.?\b/.test(m)) return "compare_peers";
  if (/good|bad|ok\b|healthy|normal/.test(m)) return "is_good";
  if (/mean|explain|what is|what does|definition/.test(m)) return "explain_metric";
  if (/why|cause|driv|reason/.test(m)) return "why_change";
  if (/should i|what (should|do|can)|next|recommend|scale|budget/.test(m)) return "what_to_do";
  return "entity_health";
}

export function localAnswer(
  ctx: ReportContext,
  targets: Targets,
  intent: SuggestionId,
  notice: string | null = null,
): AssistantAnswer {
  const b = answerBlocks(ctx, targets, intent);
  return { blocks: b, followUps: FOLLOW_UPS[intent] ?? [], engine: "local", notice };
}

function answerBlocks(ctx: ReportContext, targets: Targets, intent: SuggestionId): AnswerBlocks {
  const { facts, model, report } = ctx;
  const currency = report.currency;
  const entity = targets.entities[0] ?? model.account;
  const objective = objectiveForEntity(entity, facts.objectives, facts.accountObjective);
  const primary = primaryCostMetric(entity, objective);
  const metric: MetricKey | null = targets.metrics.find((m) => m !== "spend") ?? primary?.cost ?? null;
  const diagnosis: Diagnosis | undefined =
    targets.diagnoses[0] ?? facts.diagnoses.find((d) => d.tier === "critical" || d.tier === "attention");

  switch (intent) {
    case "prioritize": {
      const urgent = facts.diagnoses.filter((d) => d.tier === "critical" || d.tier === "attention").slice(0, 4);
      const monitor = facts.diagnoses.filter((d) => d.tier === "monitor").length;
      if (urgent.length === 0) {
        return blocks({
          observation: "Nothing in this report needs action right now.",
          evidence: [facts.briefing.verdict],
          interpretation: monitor > 0 ? `${monitor} signal(s) are worth watching but not strong enough to act on yet.` : "No signal crossed AdMate's thresholds.",
          recommendation: "Keep running; re-upload next week to compare.",
          confidence: `Data confidence is ${facts.briefing.dataConfidence.level}.`,
        });
      }
      return blocks({
        observation: `${urgent.length} item(s) need attention, in this order:`,
        evidence: urgent.map((d, i) => `${i + 1}. [${TIER_META[d.tier].label}] ${d.title} — ${d.level === "account" ? "account" : `"${safeName(d.entityName)}"`}: ${d.actionLabel}`),
        interpretation: "They are ordered by tier, then by money at stake and size of the change.",
        recommendation: `Start with #1: ${urgent[0].recommendation}`,
        confidence: `${urgent[0].title} rests on ${urgent[0].confidence} confidence.`,
        limitations: monitor > 0 ? [`${monitor} weaker signal(s) are in the Monitor tier and left out here.`] : [],
      });
    }
    case "biggest_problem":
    case "why_problem":
    case "what_to_do":
    case "should_pause":
    case "alternatives":
    case "how_sure": {
      if (!diagnosis) {
        const m = primary?.cost;
        return blocks({
          observation: `AdMate did not flag anything for ${who(entity)}.`,
          evidence: describeEntityMetrics(entity, objective, currency, m ? ["spend", m] : ["spend"]),
          interpretation: "Nothing moved enough, or with enough data, to be worth acting on.",
          recommendation: intent === "should_pause" ? "No - there is no evidence here that pausing would help." : "No change needed; keep monitoring its main KPI.",
          confidence: "This reflects AdMate's thresholds, not your business targets.",
        });
      }
      const f = ctx.findings.get(diagnosis.primaryFindingId);
      const evidence = diagnosis.keyEvidence.map(
        (e) => `${e.label}: ${fmtValue(e.value, e.format, currency)}${e.comparison != null ? ` (vs ${fmtValue(e.comparison, e.format, currency)}${e.changePct != null ? `, ${fmtPct(e.changePct)}` : ""})` : ""}`,
      );
      const drivers = diagnosis.drivers.map((d) => `"${safeName(d.name)}" accounts for ${d.share > 1 ? "more than the whole" : fmtShare(d.share) + " of the"} change`);
      const base = {
        observation: diagnosis.summary,
        evidence: [...evidence, ...drivers],
        confidence: `${diagnosis.confidence[0].toUpperCase()}${diagnosis.confidence.slice(1)} confidence. ${f?.confidenceReason ?? ""}`.trim(),
        limitations: f?.dataNeeded ? [`To confirm: ${f.dataNeeded}.`] : [],
      };
      if (intent === "why_problem") {
        return blocks({
          ...base,
          evidence: [...base.evidence, ...(f?.trigger?.checks.map((c) => `${c.label}: ${c.observed}`) ?? [])],
          interpretation: f?.hypotheses.slice(0, 2).join(" ") ?? "",
          recommendation: diagnosis.recommendation,
        });
      }
      if (intent === "should_pause") {
        const pause = diagnosis.action === "pause_or_reduce";
        return blocks({
          ...base,
          interpretation: pause
            ? "The evidence is strong enough that reducing or pausing is reasonable - once tracking is confirmed."
            : `AdMate's suggested action is "${diagnosis.actionLabel.toLowerCase()}", not pausing: pausing removes the data needed to confirm the cause, and the evidence points at something more specific.`,
          recommendation: pause ? `${diagnosis.recommendation} A softer option: ${diagnosis.alternatives[0]}` : diagnosis.recommendation,
        });
      }
      if (intent === "alternatives") {
        return blocks({
          ...base,
          evidence: [],
          interpretation: `AdMate's first suggestion is "${diagnosis.actionLabel.toLowerCase()}". If that isn't an option:`,
          recommendation: diagnosis.alternatives.map((a, i) => `${i + 1}. ${a}`).join(" "),
          confidence: diagnosis.recheck,
        });
      }
      if (intent === "how_sure") {
        return blocks({
          ...base,
          interpretation: `Statistical strength: ${diagnosis.strength}. ${diagnosis.strength === "strong" ? "A change this size is unlikely to be chance." : diagnosis.strength === "moderate" ? "Probably real, but a few more days of data would firm it up." : "Could still be normal fluctuation."}`,
          recommendation: diagnosis.recheck,
        });
      }
      return blocks({
        ...base,
        interpretation: f?.hypotheses[0] ?? "",
        recommendation: `${diagnosis.recommendation} ${diagnosis.recheck}`,
      });
    }
    case "why_change":
    case "entity_drivers":
    case "which_first": {
      if (intent === "which_first" && entity.level === "account" && diagnosis) {
        const target = diagnosis.drivers[0]?.name ?? diagnosis.entityName;
        return blocks({
          observation: `Start with "${safeName(target)}".`,
          evidence: [diagnosis.summary],
          interpretation: `It sits inside the most urgent item: ${diagnosis.title.toLowerCase()} (${TIER_META[diagnosis.tier].label.toLowerCase()}).`,
          recommendation: diagnosis.recommendation,
          confidence: `${diagnosis.confidence} confidence.`,
        });
      }
      if (!metric) {
        return blocks({ observation: `There is no comparable metric to break down for ${who(entity)}.`, limitations: ["The report may lack dates or the needed columns."] });
      }
      const analysis = analyzeDrivers(model, entity, metric);
      if (!analysis) {
        const d = entity.periodComparison?.deltas[metric];
        return blocks({
          observation: d?.changePct != null ? `${metricLabel(metric, objective)} for ${who(entity)} moved ${fmtPct(d.changePct)} between the two halves.` : `No period comparison is available for ${who(entity)}.`,
          interpretation: "There is no lower level in the file to attribute the change to.",
          limitations: ["A breakdown needs at least two campaigns, ad sets or ads under this entity, and dated rows."],
        });
      }
      const drivers = mainDrivers(analysis);
      return blocks({
        observation: describeChange(analysis, objective, currency),
        evidence: analysis.contributions.slice(0, 4).map(
          (c) =>
            `"${safeName(c.name)}": ${c.shareOfChange !== null ? fmtShare(Math.abs(c.shareOfChange)) : "—"} ${c.shareOfChange !== null && c.shareOfChange < 0 ? "offset" : "of the change"}; ${metricLabel(metric, objective)} ${fmtValue(c.previousValue, METRIC_META[metric].format, currency)} → ${fmtValue(c.currentValue, METRIC_META[metric].format, currency)}`,
        ),
        interpretation:
          drivers.length === 0
            ? "The change is spread across several entities rather than concentrated in one."
            : drivers[0].rateEffect !== null && drivers[0].mixEffect !== null && Math.abs(drivers[0].mixEffect) > Math.abs(drivers[0].rateEffect)
              ? `Most of "${safeName(drivers[0].name)}"'s effect comes from budget moving toward it, not from it getting worse.`
              : `"${safeName(drivers[0].name)}" itself got ${analysis.worsened ? "less" : "more"} efficient - look at what changed there.`,
        recommendation: drivers.length ? `Check "${safeName(drivers[0].name)}" first.` : "Look at the largest spenders first.",
        confidence: "The split is exact arithmetic on your data; the reasons behind it are hypotheses.",
        limitations: ["The file has no placement, audience or creative detail, so the cause inside that entity can't be pinned down from here."],
      });
    }
    case "is_real": {
      const m = metric ?? "spend";
      const cmp = entity.periodComparison;
      if (!cmp) return blocks({ observation: "There is no period comparison to test.", limitations: ["The report needs dated rows."] });
      const d = cmp.deltas[m];
      const worse = d?.changePct != null && (METRIC_META[m].higherIsBetter === false ? d.changePct > 0 : d.changePct < 0);
      const sig = movementSignificance(m, cmp, worse);
      return blocks({
        observation: d?.changePct != null ? `${metricLabel(m, objective)} moved ${fmtPct(d.changePct)} for ${who(entity)}.` : "No comparable change.",
        evidence: [sig.description],
        interpretation:
          sig.strength === "strong" ? "Unlikely to be chance." : sig.strength === "moderate" ? "Probably real, but not certain." : "Could easily be normal fluctuation.",
        recommendation: sig.strength === "weak" ? "Wait for more data before acting on it." : "Treat it as a real change and diagnose it.",
        confidence: `Statistical strength: ${sig.strength}.`,
      });
    }
    case "explain_metric":
    case "is_good": {
      const m = metric ?? "spend";
      const g = GLOSSARY[m];
      const value = getMetric(entity.metrics, m);
      const acct = getMetric(model.account.metrics, m);
      const d = entity.periodComparison?.deltas[m];
      const fmt = METRIC_META[m].format;
      const evidence = [`${metricLabel(m, objective)} for ${who(entity)}: ${fmtValue(value, fmt, currency)}`];
      if (entity.level !== "account" && acct !== null) evidence.push(`Account overall: ${fmtValue(acct, fmt, currency)}`);
      if (d?.previous != null && d.current != null) evidence.push(`Prior half ${fmtValue(d.previous, fmt, currency)} → latest half ${fmtValue(d.current, fmt, currency)}`);
      let verdict = "";
      if (intent === "is_good" && value !== null && acct !== null && entity.level !== "account" && METRIC_META[m].higherIsBetter !== null) {
        const better = METRIC_META[m].higherIsBetter ? value >= acct : value <= acct;
        verdict = `Compared with the account overall, this is ${better ? "better" : "worse"} than average.`;
      }
      return blocks({
        observation: g ? `${METRIC_META[m].label}: ${g.what}` : METRIC_META[m].description,
        evidence,
        interpretation: [verdict, g?.reading, relevanceNote(m, objective)].filter(Boolean).join(" "),
        recommendation: g?.diagnose ?? "",
        confidence: "Definitions are standard; the figures come straight from your file.",
        limitations: intent === "is_good" ? ["AdMate compares within your own account only - it has no industry benchmarks, which vary too much to be reliable."] : [],
      });
    }
    case "compare_peers": {
      if (targets.entities.length >= 2) {
        const list = targets.entities.slice(0, 4);
        const objs = list.map((e) => objectiveForEntity(e, facts.objectives, facts.accountObjective));
        const same = objs.every((o) => o === objs[0]);
        const m = same ? primaryCostMetric(list[0], objs[0])?.cost ?? "cpm" : "cpm";
        const fmt = METRIC_META[m].format;
        const ranked = list
          .map((e) => ({ e, v: getMetric(e.metrics, m) }))
          .filter((x): x is { e: EntityPerformance; v: number } => x.v !== null)
          .sort((a, b) => (METRIC_META[m].higherIsBetter ? b.v - a.v : a.v - b.v));
        return blocks({
          observation: ranked.length
            ? `On ${metricLabel(m, same ? objs[0] : null)}, ${who(ranked[0].e)} is doing best.`
            : "These entities don't share a comparable metric.",
          evidence: list.flatMap((e, i) => [
            `${who(e)} (${objectiveLabel(objs[i])}): ${describeEntityMetrics(e, objs[i], currency, ["spend", m, "ctr", "frequency"]).join("; ")}`,
          ]),
          interpretation: same
            ? `All are judged as ${objectiveLabel(objs[0]).toLowerCase()}, so this is like for like.`
            : "They have different objectives, so only delivery cost is compared - efficiency on results isn't comparable.",
          recommendation: ranked.length >= 2 ? `If budget moves, it would move toward ${who(ranked[0].e)} - gradually, re-measuring as you go.` : "",
          confidence: `Figures straight from the report; ${fmt === "currency" ? "costs" : "rates"} rest on each entity's own volume.`,
        });
      }
      const peers = (entity.level === "campaign" ? model.campaigns : entity.level === "adset" ? model.adsets : model.ads).filter(
        (p) => objectiveForEntity(p, facts.objectives, facts.accountObjective) === objective,
      );
      const m = primary?.cost ?? "cpm";
      const fmt = METRIC_META[m].format;
      const ranked = peers
        .map((p) => ({ p, v: getMetric(p.metrics, m) }))
        .filter((x): x is { p: EntityPerformance; v: number } => x.v !== null)
        .sort((a, b) => (METRIC_META[m].higherIsBetter ? b.v - a.v : a.v - b.v));
      const rank = ranked.findIndex((x) => x.p.id === entity.id);
      return blocks({
        observation: `${who(entity)} ranks ${rank >= 0 ? `${rank + 1} of ${ranked.length}` : "—"} on ${metricLabel(m, objective)} among ${objectiveLabel(objective as Objective | "mixed").toLowerCase()} ${entity.level === "adset" ? "ad sets" : `${entity.level}s`}.`,
        evidence: ranked.slice(0, 5).map((x) => `"${safeName(x.p.name)}": ${fmtValue(x.v, fmt, currency)} on ${fmtValue(getMetric(x.p.metrics, "spend"), "currency", currency)} spend`),
        interpretation: "Only entities with the same objective are compared, so this is like for like.",
        confidence: "Figures straight from the report.",
      });
    }
    case "vs_previous": {
      if (!ctx.history) {
        return blocks({
          observation: "There is no earlier upload for this workspace and platform to compare with.",
          interpretation: "Within this file, AdMate compares the latest half of the period with the half before it instead.",
          recommendation: "Upload next period's export to the same workspace and AdMate will compare the two automatically.",
        });
      }
      const h = ctx.history;
      const lines = historyLines(ctx);
      const worse = h.campaigns.filter((c) => c.cost?.worsened && c.cost.strength !== "weak");
      return blocks({
        observation: `Compared with "${safeName(h.previous.filename)}":`,
        evidence: lines.slice(1, 7).map((l) => l.replace(/^\s*-\s*/, "")),
        interpretation: worse.length
          ? `${worse.length} campaign(s) got meaningfully less efficient: ${worse.map((c) => `"${safeName(c.name)}"`).join(", ")}.`
          : "No campaign got meaningfully less efficient since the previous upload.",
        recommendation: worse.length ? `Look at "${safeName(worse[0].name)}" first.` : "",
        confidence: "Each change is tested on the underlying counts; \"could be noise\" means the volumes are too small to tell.",
        limitations:
          h.previousDays && h.currentDays && h.previousDays !== h.currentDays
            ? ["The two uploads cover different numbers of days, so totals are compared per day."]
            : [],
      });
    }
    case "whats_working": {
      const good = facts.diagnoses.filter((d) => d.tier === "performing");
      if (good.length === 0) {
        return blocks({
          observation: "No entity stood out as a clear win in this report.",
          interpretation: "That means nothing improved or outperformed by enough, with enough data, to call it - not that nothing works.",
        });
      }
      return blocks({
        observation: `${good.length} thing(s) are working well:`,
        evidence: good.slice(0, 4).map((d) => `${d.title} — "${safeName(d.entityName)}": ${d.summary}`),
        recommendation: good[0].recommendation,
        confidence: `${good[0].confidence} confidence.`,
      });
    }
    case "entity_health":
    default: {
      const flagged = facts.diagnoses.filter((d) => {
        const e = entityForDiagnosis(d, model);
        return e?.id === entity.id;
      });
      return blocks({
        observation: `${who(entity)} is judged as ${objectiveLabel(objective).toLowerCase()}.`,
        evidence: describeEntityMetrics(entity, objective, currency, primary ? ["spend", primary.result, primary.cost, "ctr", "frequency"] : undefined),
        interpretation: flagged.length ? `AdMate flagged: ${flagged.map((d) => `${d.title} (${TIER_META[d.tier].label})`).join("; ")}.` : "AdMate did not flag anything here.",
        recommendation: flagged[0]?.recommendation ?? "No action needed on current evidence.",
        confidence: flagged[0] ? `${flagged[0].confidence} confidence.` : "",
      });
    }
  }
}

/** Plain-text rendering of an answer, for conversation history sent to the model. */
export function answerToText(a: AssistantAnswer): string {
  const b = a.blocks;
  return [b.observation, b.evidence.join("; "), b.interpretation, b.recommendation, b.confidence, b.limitations.join(" ")]
    .filter(Boolean)
    .join("\n");
}
