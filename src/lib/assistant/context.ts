import type { EntityPerformance, MetricKey, NormalizedRow } from "@/lib/analysis/types";
import { METRIC_META, PLATFORM_LABELS } from "@/lib/analysis/types";
import { buildTrend, getMetric, type PerformanceModel } from "@/lib/analysis/metrics";
import type { ReportFacts } from "@/lib/analysis/facts";
import { describeChange } from "@/lib/analysis/facts";
import type { Finding } from "@/lib/analysis/detectors";
import { fmtPct, fmtShare, fmtValue } from "@/lib/analysis/detectors";
import type { Diagnosis } from "@/lib/analysis/diagnoses";
import { TIER_META } from "@/lib/analysis/diagnoses";
import { analyzeDrivers, childrenOf } from "@/lib/analysis/drivers";
import {
  OBJECTIVE_PROFILES,
  metricLabel,
  objectiveForEntity,
  objectiveLabel,
  primaryCostMetric,
  type Objective,
} from "@/lib/analysis/objectives";
import { GLOSSARY, relevanceNote } from "@/lib/analysis/glossary";
import type { ReportRecord } from "@/lib/db/queries";
import type { AssistantFocus } from "./types";
import { findEntity } from "./openers";

/**
 * Context retrieval for the assistant.
 *
 * The model never sees the whole report. For each question AdMate works out
 * which entities and metrics are in play - from the focus the user clicked,
 * names and metric words in the question, and what the conversation was last
 * about - and assembles a compact, pre-formatted context pack for just those.
 * Every number in the pack comes from the deterministic engine; the pack text
 * itself is then the ledger the answer is validated against.
 */

export interface ReportContext {
  report: ReportRecord;
  model: PerformanceModel;
  facts: ReportFacts;
  findings: Map<string, Finding>;
  /** Loaded lazily - only a daily-trend question needs raw rows. */
  loadRows: () => NormalizedRow[];
}

export interface Targets {
  entities: EntityPerformance[];
  metrics: MetricKey[];
  diagnoses: Diagnosis[];
  /** How the targets were chosen, for the prompt ("from the card you clicked"). */
  reason: string;
}

const METRIC_WORDS: [RegExp, MetricKey][] = [
  [/\bcost per (lead|lead)s?\b|\bcpl\b/i, "cpl"],
  [/\bcpa\b|cost per (acquisition|conversion|purchase|result)|cost per sale/i, "cpa"],
  [/\broas\b|return on ad ?spend/i, "roas"],
  [/\bctr\b|click[- ]?through/i, "ctr"],
  [/\bcpc\b|cost per click/i, "cpc"],
  [/\bcpm\b|cost per (1,?000|thousand|mille)/i, "cpm"],
  [/conversion rate|\bcvr\b/i, "cvr"],
  [/lead rate/i, "leadRate"],
  [/frequency|fatigue|saturat/i, "frequency"],
  [/\bspend|budget|spent\b/i, "spend"],
  [/\bconversions?\b|\bpurchases?\b|\bsales\b/i, "conversions"],
  [/\bleads?\b/i, "leads"],
  [/\brevenue\b|conversion value/i, "revenue"],
  [/\breach\b/i, "reach"],
  [/\bimpressions?\b/i, "impressions"],
  [/\bclicks?\b/i, "clicks"],
  [/landing page/i, "costPerLpv"],
  [/order value|\baov\b/i, "aov"],
];

export function allEntities(model: PerformanceModel): EntityPerformance[] {
  return [...model.campaigns, ...model.adsets, ...model.ads];
}

/** Entities whose name appears in the text. Longer names first so "Ad A2" beats "Ad A". */
export function entitiesMentioned(text: string, model: PerformanceModel): EntityPerformance[] {
  const lower = text.toLowerCase();
  const out: EntityPerformance[] = [];
  const candidates = allEntities(model)
    .filter((e) => e.name.length >= 3)
    .sort((a, b) => b.name.length - a.name.length);
  const claimed: string[] = [];
  for (const e of candidates) {
    const name = e.name.toLowerCase();
    if (!lower.includes(name)) continue;
    // Skip a shorter name that is only matched as part of a longer one already found.
    if (claimed.some((c) => c.includes(name) && c !== name)) continue;
    claimed.push(name);
    out.push(e);
    if (out.length >= 4) break;
  }
  return out;
}

export function metricsMentioned(text: string): MetricKey[] {
  const out: MetricKey[] = [];
  for (const [re, m] of METRIC_WORDS) if (re.test(text) && !out.includes(m)) out.push(m);
  return out.slice(0, 4);
}

export function resolveTargets(
  message: string,
  focus: AssistantFocus,
  previousFocus: AssistantFocus | null,
  ctx: ReportContext,
): Targets {
  const { model, facts } = ctx;
  const mentioned = entitiesMentioned(message, model);
  const metrics = metricsMentioned(message);
  const diagnoses: Diagnosis[] = [];
  let entities: EntityPerformance[] = [];
  let reason = "";

  const fromFocus = (f: AssistantFocus): void => {
    if (f.kind === "diagnosis") {
      const d = facts.diagnoses.find((x) => x.id === f.diagnosisId);
      if (d) {
        diagnoses.push(d);
        const e = entityForDiagnosis(d, model);
        if (e) entities.push(e);
      }
    } else if (f.kind === "metric") {
      const e = findEntity(model, f.entityId);
      if (e) entities.push(e);
      if (!metrics.includes(f.metric)) metrics.unshift(f.metric);
    } else if (f.kind === "entity") {
      const e = findEntity(model, f.entityId);
      if (e) entities.push(e);
    } else if (f.kind === "change") {
      entities.push(model.account);
      if (!metrics.includes(f.metric)) metrics.unshift(f.metric);
    }
  };

  if (mentioned.length > 0) {
    entities = mentioned;
    reason = "named in the question";
    if (focus.kind === "diagnosis") fromFocus(focus);
  } else if (focus.kind !== "report") {
    fromFocus(focus);
    reason = "what the user clicked";
  } else if (previousFocus && previousFocus.kind !== "report") {
    fromFocus(previousFocus);
    reason = "what the conversation was last about";
  } else {
    entities = [model.account];
    reason = "the whole report";
  }

  // Diagnoses attached to the target entities.
  for (const e of entities) {
    for (const d of facts.diagnoses) {
      if (d.level === e.level && d.entityName === e.name && (e.level === "account" || d.campaign === e.campaign)) {
        if (!diagnoses.includes(d)) diagnoses.push(d);
      }
    }
  }
  // De-duplicate entities.
  entities = entities.filter((e, i) => entities.findIndex((x) => x.id === e.id) === i).slice(0, 4);
  return { entities, metrics: metrics.slice(0, 4), diagnoses: diagnoses.slice(0, 4), reason };
}

export function entityForDiagnosis(d: Diagnosis, model: PerformanceModel): EntityPerformance | null {
  if (d.level === "account") return model.account;
  const pool = d.level === "campaign" ? model.campaigns : d.level === "adset" ? model.adsets : model.ads;
  return pool.find((e) => e.name === d.entityName && e.campaign === d.campaign && (d.level !== "ad" || e.adset === d.adset)) ?? null;
}

/** Strips anything in a user-supplied name that could be read as structure or instructions. */
export function safeName(name: string): string {
  return name.replace(/[\u0000-\u001f<>`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function entityTitle(e: EntityPerformance): string {
  if (e.level === "account") return "Account total";
  const noun = e.level === "adset" ? "Ad set" : e.level === "ad" ? "Ad" : "Campaign";
  const parent =
    e.level === "ad"
      ? ` (in ad set "${safeName(e.adset ?? "")}", campaign "${safeName(e.campaign ?? "")}")`
      : e.level === "adset"
        ? ` (in campaign "${safeName(e.campaign ?? "")}")`
        : "";
  return `${noun} "${safeName(e.name)}"${parent}`;
}

const DETAIL_METRICS: MetricKey[] = [
  "spend",
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "conversions",
  "cvr",
  "cpa",
  "revenue",
  "roas",
  "aov",
  "leads",
  "cpl",
  "landingPageViews",
  "costPerLpv",
  "engagements",
  "cpe",
  "thruplays",
  "costPerThruplay",
];

/** Every metric the entity has, with its change vs the prior half when available. */
export function describeEntityMetrics(e: EntityPerformance, objective: Objective | "mixed", currency: string, only?: MetricKey[]): string[] {
  const lines: string[] = [];
  for (const m of only ?? DETAIL_METRICS) {
    const v = getMetric(e.metrics, m);
    if (v === null) continue;
    const d = e.periodComparison?.deltas[m];
    const fmt = METRIC_META[m].format;
    let line = `${metricLabel(m, objective)}: ${fmtValue(v, fmt, currency)}`;
    if (d && d.previous !== null && d.current !== null) {
      line += ` (${fmtValue(d.previous, fmt, currency)} → ${fmtValue(d.current, fmt, currency)} between halves${d.changePct !== null ? `, ${fmtPct(d.changePct)}` : ""})`;
    }
    lines.push(line);
  }
  return lines;
}

function breakdownLines(ctx: ReportContext, parent: EntityPerformance, metric: MetricKey, objective: Objective | "mixed"): string[] {
  const { model, report } = ctx;
  const analysis = analyzeDrivers(model, parent, metric);
  if (!analysis) return [];
  const fmt = METRIC_META[metric].format;
  const lines = [`Breakdown of the ${metricLabel(metric, objective)} change for ${entityTitle(parent)}: ${describeChange(analysis, objective, report.currency)}`];
  for (const c of analysis.contributions.slice(0, 6)) {
    if (c.shareOfChange === null) continue;
    lines.push(
      `  - "${safeName(c.name)}": ${fmtShare(Math.abs(c.shareOfChange))} of the change (${c.shareOfChange > 0 ? "pushed in the same direction" : "offset it"}); ${metricLabel(metric, objective)} ${fmtValue(c.previousValue, fmt, report.currency)} → ${fmtValue(c.currentValue, fmt, report.currency)}; spend share now ${fmtShare(c.currentShare)}; ${c.rateEffect !== null && c.mixEffect !== null ? (Math.abs(c.rateEffect) >= Math.abs(c.mixEffect) ? "mainly its own efficiency changed" : "mainly budget moved toward/away from it") : "new or without results in one half"}`,
    );
  }
  return lines;
}

function diagnosisLines(d: Diagnosis, ctx: ReportContext): string[] {
  const primary = ctx.findings.get(d.primaryFindingId);
  const lines = [
    `Diagnosis "${d.title}" on ${d.level === "account" ? "the account" : `"${safeName(d.entityName)}"`} — tier: ${TIER_META[d.tier].label}; AdMate's action: ${d.actionLabel}; confidence: ${d.confidence}; statistical strength: ${d.strength}.`,
    `  Fact: ${d.summary}`,
    `  Recommended: ${d.recommendation} ${d.recheck}`,
    `  Alternatives: ${d.alternatives.join(" | ")}`,
    `  Signals combined: ${d.signals.join("; ")}`,
  ];
  if (primary) {
    lines.push(`  Confidence reasoning: ${primary.confidenceReason}`);
    if (primary.trigger) {
      lines.push(`  Why it was raised (${primary.trigger.rule}):`);
      for (const c of primary.trigger.checks) lines.push(`    - ${c.label}: ${c.observed} [rule: ${c.rule}; ${c.passed ? "met" : "not met"}]`);
    }
    if (primary.hypotheses.length) lines.push(`  Possible causes (hypotheses, not facts): ${primary.hypotheses.join(" | ")}`);
    if (primary.dataNeeded) lines.push(`  Data needed to confirm: ${primary.dataNeeded}`);
  }
  return lines;
}

const NOT_IN_EXPORTS =
  "audience/demographic breakdowns (age, gender, interests), placements, geography, device, creative content or visuals, landing page content, budget and bid settings, change history, lead quality, profit margins, and anything outside this uploaded file";

/** The per-report block: stable for the whole conversation, so it is cached. */
export function reportHeader(ctx: ReportContext): string {
  const { report, model, facts } = ctx;
  const lines: string[] = [];
  lines.push(`Platform: ${PLATFORM_LABELS[report.platform]}. Currency: ${report.currency}.`);
  lines.push(
    `Reporting period: ${report.periodStart && report.periodEnd ? `${report.periodStart} to ${report.periodEnd}` : "not specified"}.`,
  );
  lines.push(
    facts.comparisonLabel
      ? `Comparisons are ${facts.comparisonLabel} (the file split into two equal halves; there is no data from before the file).`
      : "The file has no usable dates, so nothing can be compared over time - only entities against each other.",
  );
  lines.push(`Account objective: ${objectiveLabel(facts.accountObjective)}.`);
  lines.push(`Structure: ${model.campaigns.length} campaigns, ${model.adsets.length} ad sets, ${model.ads.length} ads.`);
  lines.push("Campaigns (objective, and how AdMate determined it):");
  for (const c of model.campaigns.slice(0, 40)) {
    const o = facts.objectives[c.name];
    const spend = getMetric(c.metrics, "spend");
    lines.push(`  - "${safeName(c.name)}": ${o ? `${objectiveLabel(o.objective)} (from ${o.detail})` : "unknown"}; spend ${fmtValue(spend, "currency", report.currency)}`);
  }
  if (model.campaigns.length > 40) lines.push(`  - ...and ${model.campaigns.length - 40} more campaigns (ask for them by name).`);
  lines.push("Account totals:");
  for (const l of describeEntityMetrics(model.account, facts.accountObjective, report.currency)) lines.push(`  - ${l}`);
  lines.push(`Briefing: ${facts.briefing.verdict}`);
  lines.push("All diagnoses (most urgent first):");
  for (const d of facts.diagnoses.slice(0, 20)) {
    lines.push(`  - [${TIER_META[d.tier].label}] ${d.title} — ${d.level === "account" ? "account" : `${d.level} "${safeName(d.entityName)}"`} — action: ${d.actionLabel}`);
  }
  if (facts.whatChanged.length) {
    lines.push("What changed at account level:");
    for (const w of facts.whatChanged) lines.push(`  - ${describeChange(w, facts.accountObjective, report.currency)}`);
  }
  lines.push(`Data confidence: ${facts.briefing.dataConfidence.level} — ${facts.briefing.dataConfidence.reasons.join(" ")}`);
  lines.push(`NOT in this report (never claim knowledge of these): ${NOT_IN_EXPORTS}.`);
  return lines.join("\n");
}

/** The per-question block: only the entities, metrics and diagnoses in play. */
export function questionContext(ctx: ReportContext, targets: Targets): string {
  const { report, model, facts } = ctx;
  const lines: string[] = [];
  lines.push(`Context selected from ${targets.reason}.`);
  for (const e of targets.entities) {
    const objective = objectiveForEntity(e, facts.objectives, facts.accountObjective);
    lines.push("");
    lines.push(`## ${entityTitle(e)} — judged as ${objectiveLabel(objective)}`);
    if (objective !== "mixed") lines.push(`How to judge it: ${OBJECTIVE_PROFILES[objective].guidance}`);
    const accountSpend = getMetric(model.account.metrics, "spend");
    const spend = getMetric(e.metrics, "spend");
    if (e.level !== "account" && accountSpend && spend !== null) lines.push(`Share of account spend: ${fmtShare(spend / accountSpend)}`);
    for (const l of describeEntityMetrics(e, objective, report.currency)) lines.push(`- ${l}`);

    // Like-for-like comparison with peers at the same level and objective.
    const primary = primaryCostMetric(e, objective);
    if (e.level !== "account" && primary) {
      const peers = (e.level === "campaign" ? model.campaigns : e.level === "adset" ? model.adsets : model.ads).filter(
        (p) => p.id !== e.id && objectiveForEntity(p, facts.objectives, facts.accountObjective) === objective,
      );
      const vals = peers
        .map((p) => ({ name: p.name, v: getMetric(p.metrics, primary.cost) }))
        .filter((p): p is { name: string; v: number } => p.v !== null)
        .sort((a, b) => a.v - b.v)
        .slice(0, 5);
      if (vals.length) {
        lines.push(
          `Peers with the same objective, ${metricLabel(primary.cost, objective)}: ${vals.map((p) => `"${safeName(p.name)}" ${fmtValue(p.v, METRIC_META[primary.cost].format, report.currency)}`).join("; ")}`,
        );
      }
    }

    // Which children moved the metrics in question.
    const metricsToBreak = new Set<MetricKey>(targets.metrics.filter((m) => m !== "spend"));
    if (primary) metricsToBreak.add(primary.cost);
    for (const m of [...metricsToBreak].slice(0, 3)) {
      if (childrenOf(model, e).length >= 2) lines.push(...breakdownLines(ctx, e, m, objective));
    }
  }

  for (const d of targets.diagnoses) {
    lines.push("");
    lines.push(...diagnosisLines(d, ctx));
  }

  for (const m of targets.metrics) {
    const g = GLOSSARY[m];
    if (!g) continue;
    lines.push("");
    lines.push(`Metric reference — ${METRIC_META[m].label}: ${g.what} ${g.reading} ${g.diagnose}`);
    const note = relevanceNote(m, targets.entities[0] ? objectiveForEntity(targets.entities[0], facts.objectives, facts.accountObjective) : facts.accountObjective);
    if (note) lines.push(`Relevance: ${note}`);
  }
  return lines.join("\n");
}

/* ------------------------------- tool calls ------------------------------ */

function lookup(ctx: ReportContext, name: string): EntityPerformance[] {
  const n = name.trim().toLowerCase();
  if (n === "" || n === "account" || n === "account total") return [ctx.model.account];
  const all = allEntities(ctx.model);
  const exact = all.filter((e) => e.name.toLowerCase() === n);
  if (exact.length) return exact.slice(0, 3);
  return all.filter((e) => e.name.toLowerCase().includes(n)).slice(0, 3);
}

export function toolGetEntity(ctx: ReportContext, name: string): string {
  const found = lookup(ctx, name);
  if (found.length === 0) return `No campaign, ad set or ad named "${safeName(name)}" exists in this report.`;
  return found
    .map((e) => {
      const objective = objectiveForEntity(e, ctx.facts.objectives, ctx.facts.accountObjective);
      return [`${entityTitle(e)} — ${objectiveLabel(objective)}`, ...describeEntityMetrics(e, objective, ctx.report.currency).map((l) => `- ${l}`)].join("\n");
    })
    .join("\n\n");
}

export function toolBreakdown(ctx: ReportContext, name: string, metric: string): string {
  if (!(metric in METRIC_META)) return `Unknown metric "${safeName(metric)}".`;
  const found = lookup(ctx, name);
  if (found.length === 0) return `No entity named "${safeName(name)}" exists in this report.`;
  const e = found[0];
  const objective = objectiveForEntity(e, ctx.facts.objectives, ctx.facts.accountObjective);
  const children = childrenOf(ctx.model, e);
  if (children.length < 2) return `${entityTitle(e)} has fewer than two children in this report, so there is nothing to break down.`;
  const lines = breakdownLines(ctx, e, metric as MetricKey, objective);
  if (lines.length > 0) return lines.join("\n");
  // No period comparison: list the children side by side instead.
  const fmt = METRIC_META[metric as MetricKey].format;
  return [
    `${metricLabel(metric as MetricKey, objective)} by child of ${entityTitle(e)} (no period comparison available):`,
    ...children.slice(0, 10).map((c) => `- "${safeName(c.name)}": ${fmtValue(getMetric(c.metrics, metric as MetricKey), fmt, ctx.report.currency)}; spend ${fmtValue(getMetric(c.metrics, "spend"), "currency", ctx.report.currency)}`),
  ].join("\n");
}

export function toolDailyTrend(ctx: ReportContext, name: string, metric: string): string {
  if (!(metric in METRIC_META)) return `Unknown metric "${safeName(metric)}".`;
  const found = lookup(ctx, name);
  if (found.length === 0) return `No entity named "${safeName(name)}" exists in this report.`;
  const e = found[0];
  const rows = ctx.loadRows().filter((r) => {
    if (e.level === "account") return true;
    if (e.level === "campaign") return r.campaign === e.name;
    if (e.level === "adset") return r.campaign === e.campaign && r.adset === e.name;
    return r.campaign === e.campaign && r.adset === e.adset && r.ad === e.name;
  });
  const trend = buildTrend(rows);
  if (trend.length === 0) return "This report has no daily data for that entity.";
  const fmt = METRIC_META[metric as MetricKey].format;
  return [
    `Daily ${METRIC_META[metric as MetricKey].label} for ${entityTitle(e)}:`,
    ...trend.slice(-31).map((t) => `- ${t.date}: ${fmtValue(getMetric(t.metrics, metric as MetricKey), fmt, ctx.report.currency)}`),
  ].join("\n");
}

export function toolCompare(ctx: ReportContext, names: string[]): string {
  const found = names.flatMap((n) => lookup(ctx, n).slice(0, 1)).slice(0, 4);
  if (found.length < 2) return "At least two entities that exist in this report are needed to compare.";
  return found
    .map((e) => {
      const objective = objectiveForEntity(e, ctx.facts.objectives, ctx.facts.accountObjective);
      const keys = objective === "mixed" ? undefined : ["spend" as MetricKey, ...OBJECTIVE_PROFILES[objective].keyMetrics, "frequency" as MetricKey];
      return [`${entityTitle(e)} — ${objectiveLabel(objective)}`, ...describeEntityMetrics(e, objective, ctx.report.currency, keys).map((l) => `- ${l}`)].join("\n");
    })
    .join("\n\n");
}
