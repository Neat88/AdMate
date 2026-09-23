import type { BaseMetric, EntityPerformance, MetricKey, NormalizedRow } from "./types";
import { METRIC_META } from "./types";
import { getMetric, type PerformanceModel } from "./metrics";

/**
 * Campaign objectives.
 *
 * A traffic campaign with a £0.40 CPC and no purchases is doing its job; a
 * sales campaign with the same numbers is not. Judging every campaign by the
 * same metrics produces confident, wrong advice, so every detector asks this
 * module which metrics matter for the entity it is looking at.
 *
 * Objectives are resolved per campaign, because real exports mix them.
 */

export type Objective = "sales" | "leads" | "traffic" | "awareness" | "engagement" | "video" | "app";

/** Where the objective came from - shown to the user so a guess is never presented as fact. */
export type ObjectiveSource = "result_type" | "campaign_name" | "report_setting" | "data_shape";

export interface ObjectiveResolution {
  objective: Objective;
  source: ObjectiveSource;
  /** Human explanation, e.g. `campaign name contains "LEADS"`. */
  detail: string;
}

export interface ObjectiveProfile {
  objective: Objective;
  label: string;
  /** The result this objective buys, in order of preference. */
  resultMetrics: BaseMetric[];
  /** Cost-per-result metric, matched index-for-index with resultMetrics. */
  costMetrics: MetricKey[];
  /** Metrics that describe efficiency for this objective, most important first. */
  keyMetrics: MetricKey[];
  /** Metrics whose movement is worth an alert for this objective. */
  watchMetrics: MetricKey[];
  /** One-line explanation used in metric tooltips and by the assistant. */
  guidance: string;
}

export const OBJECTIVE_PROFILES: Record<Objective, ObjectiveProfile> = {
  sales: {
    objective: "sales",
    label: "Sales / conversions",
    resultMetrics: ["conversions"],
    costMetrics: ["cpa"],
    keyMetrics: ["cpa", "roas", "cvr", "ctr", "cpc", "cpm"],
    watchMetrics: ["cpa", "roas", "cvr", "ctr", "cpc", "cpm", "frequency"],
    guidance:
      "Judge on cost per conversion and ROAS first. CTR, CPC and CPM explain *why* those moved, but are not goals on their own.",
  },
  leads: {
    objective: "leads",
    label: "Leads",
    // Lead-gen exports often carry leads under "Results"/"Conversions", so
    // conversions are an accepted stand-in when no dedicated leads column exists.
    resultMetrics: ["leads", "conversions"],
    costMetrics: ["cpl", "cpa"],
    keyMetrics: ["cpl", "cpa", "leadRate", "cvr", "ctr", "cpc", "cpm"],
    watchMetrics: ["cpl", "cpa", "leadRate", "cvr", "ctr", "cpc", "cpm", "frequency"],
    guidance:
      "Judge on cost per lead and lead volume. Lead quality is not in an ad export, so a cheaper lead is only better if it converts downstream.",
  },
  traffic: {
    objective: "traffic",
    label: "Traffic",
    resultMetrics: ["landingPageViews", "clicks"],
    costMetrics: ["costPerLpv", "cpc"],
    keyMetrics: ["cpc", "ctr", "costPerLpv", "cpm"],
    watchMetrics: ["cpc", "ctr", "cpm", "frequency"],
    guidance:
      "Judge on cost per click (or per landing page view) and CTR. Conversions are not what this campaign is optimised for, so AdMate does not judge it on CPA.",
  },
  awareness: {
    objective: "awareness",
    label: "Awareness / reach",
    resultMetrics: ["reach", "impressions"],
    costMetrics: ["cpm", "cpm"],
    keyMetrics: ["cpm", "frequency", "reach", "impressions"],
    watchMetrics: ["cpm", "frequency"],
    guidance:
      "Judge on CPM, reach and frequency. Clicks and conversions are side effects here, not the goal.",
  },
  engagement: {
    objective: "engagement",
    label: "Engagement",
    resultMetrics: ["engagements"],
    costMetrics: ["cpe"],
    keyMetrics: ["cpe", "engagementRate", "cpm", "ctr"],
    watchMetrics: ["cpe", "engagementRate", "cpm", "frequency"],
    guidance: "Judge on cost per engagement and engagement rate.",
  },
  video: {
    objective: "video",
    label: "Video views",
    resultMetrics: ["thruplays", "videoViews"],
    costMetrics: ["costPerThruplay", "costPerThruplay"],
    keyMetrics: ["costPerThruplay", "cpm", "frequency"],
    watchMetrics: ["costPerThruplay", "cpm", "frequency"],
    guidance: "Judge on cost per completed view and CPM.",
  },
  app: {
    objective: "app",
    label: "App installs",
    resultMetrics: ["conversions"],
    costMetrics: ["cpa"],
    keyMetrics: ["cpa", "cvr", "ctr", "cpc", "cpm"],
    watchMetrics: ["cpa", "cvr", "ctr", "cpc", "cpm", "frequency"],
    guidance: "Judge on cost per install. AdMate treats the conversions column as installs for this objective.",
  },
};

/** Maps the free-text objective chosen at upload onto a canonical objective. */
export function objectiveFromSetting(setting: string | null | undefined): Objective | null {
  if (!setting) return null;
  return matchObjectiveText(setting);
}

/**
 * Matches a platform result-type or objective label. Deliberately strict:
 * returns null rather than guessing when nothing recognisable is present.
 */
export function matchObjectiveText(text: string): Objective | null {
  const t = text.toLowerCase();
  if (/purchase|conversion|sales|checkout|add[_ ]?to[_ ]?cart|complete[_ ]?payment|value|roas|catalog|shopping/.test(t)) return "sales";
  if (/lead|form|registration|sign[_ -]?up|contact|submit/.test(t)) return "leads";
  if (/install|app[_ ]?(promotion|event)/.test(t)) return "app";
  if (/thruplay|video[_ ]?view|video_p|views|video/.test(t)) return "video";
  if (/landing[_ ]?page|link[_ ]?click|traffic|click/.test(t)) return "traffic";
  if (/engagement|like|follow|comment|message|interaction/.test(t)) return "engagement";
  if (/reach|awareness|impression|brand[_ ]?awareness|recall/.test(t)) return "awareness";
  return null;
}

/**
 * Campaign-name conventions. Media buyers routinely encode the objective in
 * the name ("TOF | CONV | Broad", "LEADS - UK"), which is a useful but
 * fallible signal - it is reported as a guess, with its source.
 */
const NAME_PATTERNS: { re: RegExp; objective: Objective; token: string }[] = [
  { re: /\b(conv|conversions?|sales|purchases?|shop(ping)?|catalog|dpa|asc|advantage\+? shopping)\b/i, objective: "sales", token: "sales" },
  { re: /\b(leads?|lead ?gen|signups?|sign-?ups?|registrations?|forms?)\b/i, objective: "leads", token: "leads" },
  { re: /\b(app ?installs?|installs?)\b/i, objective: "app", token: "app installs" },
  { re: /\b(traffic|lpv|clicks?|visits?)\b/i, objective: "traffic", token: "traffic" },
  { re: /\b(awareness|reach|brand ?awareness|tof ?reach)\b/i, objective: "awareness", token: "awareness" },
  { re: /\b(engagement|post ?engagement)\b/i, objective: "engagement", token: "engagement" },
  { re: /\b(video ?views?|vv|thruplay)\b/i, objective: "video", token: "video views" },
];

export function objectiveFromName(name: string | null): { objective: Objective; token: string } | null {
  if (!name) return null;
  for (const p of NAME_PATTERNS) {
    const m = name.match(p.re);
    if (m) return { objective: p.objective, token: m[0] };
  }
  return null;
}

function dataShapeObjective(entity: EntityPerformance): Objective {
  const has = (m: BaseMetric) => getMetric(entity.metrics, m) !== null;
  const conversions = getMetric(entity.metrics, "conversions");
  const leads = getMetric(entity.metrics, "leads");
  if (has("revenue") || (conversions !== null && conversions > 0)) return "sales";
  if (leads !== null && leads > 0) return "leads";
  if (has("conversions")) return "sales";
  if (has("clicks")) return "traffic";
  if (has("thruplays")) return "video";
  if (has("engagements")) return "engagement";
  return "awareness";
}

/**
 * Resolves each campaign's objective. Order of precedence:
 *   1. a result-type column in the file (the platform said so),
 *   2. an objective token in the campaign name,
 *   3. the objective chosen at upload,
 *   4. what the data looks like (conversion value present -> sales, ...).
 */
export function resolveCampaignObjectives(
  model: PerformanceModel,
  rows: NormalizedRow[],
  reportSetting: string | null,
): Record<string, ObjectiveResolution> {
  const setting = objectiveFromSetting(reportSetting);

  // Majority result type per campaign, weighted by spend.
  const resultTypeVotes = new Map<string, Map<Objective, number>>();
  for (const row of rows) {
    if (!row.resultType) continue;
    const obj = matchObjectiveText(row.resultType);
    if (!obj) continue;
    const key = row.campaign ?? "(not set)";
    const votes = resultTypeVotes.get(key) ?? new Map<Objective, number>();
    votes.set(obj, (votes.get(obj) ?? 0) + (row.metrics.spend ?? 1));
    resultTypeVotes.set(key, votes);
  }

  const out: Record<string, ObjectiveResolution> = {};
  for (const campaign of model.campaigns) {
    const votes = resultTypeVotes.get(campaign.name);
    if (votes && votes.size > 0) {
      const [objective] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
      out[campaign.name] = {
        objective,
        source: "result_type",
        detail: "the result type reported in your export",
      };
      continue;
    }
    const fromName = objectiveFromName(campaign.name);
    if (fromName) {
      out[campaign.name] = {
        objective: fromName.objective,
        source: "campaign_name",
        detail: `the campaign name contains "${fromName.token}"`,
      };
      continue;
    }
    if (setting) {
      out[campaign.name] = {
        objective: setting,
        source: "report_setting",
        detail: "the objective you selected at upload",
      };
      continue;
    }
    out[campaign.name] = {
      objective: dataShapeObjective(campaign),
      source: "data_shape",
      detail: "the metrics present for this campaign (no objective was stated)",
    };
  }
  return out;
}

/**
 * The account's objective: the one carrying at least 80% of spend, or
 * "mixed". Account-level cost-per-result comparisons are only meaningful when
 * the account is not mixing objectives.
 */
export function accountObjective(
  model: PerformanceModel,
  objectives: Record<string, ObjectiveResolution>,
  reportSetting: string | null,
): Objective | "mixed" {
  if (model.campaigns.length === 0) {
    return objectiveFromSetting(reportSetting) ?? dataShapeObjective(model.account);
  }
  const spendBy = new Map<Objective, number>();
  let total = 0;
  for (const c of model.campaigns) {
    const obj = objectives[c.name]?.objective ?? "sales";
    const spend = getMetric(c.metrics, "spend") ?? 0;
    spendBy.set(obj, (spendBy.get(obj) ?? 0) + spend);
    total += spend;
  }
  if (total <= 0) {
    const first = model.campaigns[0];
    return objectives[first.name]?.objective ?? "sales";
  }
  const [top, topSpend] = [...spendBy.entries()].sort((a, b) => b[1] - a[1])[0];
  return topSpend / total >= 0.8 ? top : "mixed";
}

export function objectiveForEntity(
  entity: EntityPerformance,
  objectives: Record<string, ObjectiveResolution>,
  account: Objective | "mixed",
): Objective | "mixed" {
  if (entity.level === "account") return account;
  const campaignName = entity.level === "campaign" ? entity.name : entity.campaign;
  if (campaignName && objectives[campaignName]) return objectives[campaignName].objective;
  return account;
}

/**
 * Whether a metric is a legitimate basis for judging an entity with this
 * objective. "mixed" allows only delivery metrics, which mean the same thing
 * across objectives.
 */
export function metricRelevant(metric: MetricKey, objective: Objective | "mixed"): boolean {
  if (objective === "mixed") return ["cpm", "ctr", "cpc", "frequency"].includes(metric);
  const profile = OBJECTIVE_PROFILES[objective];
  return profile.watchMetrics.includes(metric) || profile.keyMetrics.includes(metric);
}

/**
 * The primary cost-per-result metric for an entity: the first one in the
 * profile that the entity actually has data for.
 */
export function primaryCostMetric(
  entity: EntityPerformance,
  objective: Objective | "mixed",
): { cost: MetricKey; result: BaseMetric } | null {
  if (objective === "mixed") return null;
  const profile = OBJECTIVE_PROFILES[objective];
  for (let i = 0; i < profile.resultMetrics.length; i++) {
    const result = profile.resultMetrics[i];
    const cost = profile.costMetrics[i];
    if (getMetric(entity.metrics, result) !== null && getMetric(entity.metrics, cost) !== null) {
      return { cost, result };
    }
  }
  return null;
}

/**
 * Objective-aware labels: in a lead campaign where leads arrive through the
 * conversions column, "CPA" is really a cost per lead, and saying so avoids a
 * marketer reading the number against the wrong target.
 */
export function metricLabel(metric: MetricKey, objective: Objective | "mixed" | null | undefined): string {
  if (objective === "leads") {
    if (metric === "conversions") return "Leads (from results column)";
    if (metric === "cpa") return "Cost per lead";
    if (metric === "cvr") return "Lead rate";
  }
  if (objective === "app") {
    if (metric === "conversions") return "Installs";
    if (metric === "cpa") return "Cost per install";
  }
  return METRIC_META[metric].label;
}

export function objectiveLabel(objective: Objective | "mixed"): string {
  return objective === "mixed" ? "Mixed objectives" : OBJECTIVE_PROFILES[objective].label;
}


