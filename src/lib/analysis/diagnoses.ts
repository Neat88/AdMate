import type { EntityLevel } from "./types";
import type { EvidenceItem, Finding, Confidence, EvidenceStrength, FindingDriver } from "./detectors";
import type { Objective } from "./objectives";

/**
 * From findings to decisions.
 *
 * Detectors produce *signals*: "CPA rose", "CTR fell", "frequency is 4.6".
 * Several signals on the same campaign are usually one problem, and a
 * marketer wants one card that says what the problem is and what to do -
 * not five cards to reconcile themselves. A diagnosis groups the signals on
 * one entity, names the pattern they form, and picks exactly one action from
 * a fixed vocabulary, with the alternatives for when that action isn't an
 * option.
 *
 * The action rules are deterministic and conservative on purpose: "pause"
 * requires strong evidence, weak evidence becomes "wait for data", and a
 * possible tracking fault always comes before a performance action.
 */

export type ActionType =
  | "fix_tracking"
  | "pause_or_reduce"
  | "refresh_creative"
  | "adjust_audience"
  | "check_landing_page"
  | "reallocate_budget"
  | "investigate"
  | "scale_gradually"
  | "wait_for_data"
  | "keep_running";

export type Tier = "critical" | "attention" | "monitor" | "performing";

export const TIER_META: Record<Tier, { label: string; description: string }> = {
  critical: { label: "Critical", description: "Act now - material spend and clear evidence." },
  attention: { label: "Needs attention", description: "Review this week." },
  monitor: { label: "Monitor", description: "A signal, but not enough data to act on yet." },
  performing: { label: "Performing well", description: "Wins and room to scale." },
};

export const ACTION_META: Record<ActionType, { label: string; alternatives: string[] }> = {
  fix_tracking: {
    label: "Check conversion tracking",
    alternatives: [
      "Hold budget changes until tracking is confirmed - every cost-per-result figure depends on it.",
      "Compare platform-reported conversions with your analytics or CRM for the same days.",
    ],
  },
  pause_or_reduce: {
    label: "Reduce or pause",
    alternatives: [
      "Cut the budget by 30-50% instead of pausing, so data keeps arriving and learning is not reset.",
      "Swap in a new creative or audience inside the same ad set before giving up on it.",
      "Set a cost cap at your target cost per result and let delivery shrink on its own.",
    ],
  },
  refresh_creative: {
    label: "Refresh creative",
    alternatives: [
      "Keep the current ad running and add 1-2 new variations alongside it, rather than replacing it.",
      "Broaden the audience to bring frequency down while new creative is prepared.",
      "Lower this entity's share of budget while testing, instead of pausing it.",
    ],
  },
  adjust_audience: {
    label: "Adjust audience or placements",
    alternatives: [
      "Test broader targeting, or let the platform expand the audience automatically.",
      "Shift budget toward placements with lower CPM.",
      "Accept the higher cost if the cost per result is still within target - CPM is a means, not the goal.",
    ],
  },
  check_landing_page: {
    label: "Check the landing page",
    alternatives: [
      "Complete the purchase or lead form yourself on mobile and desktop.",
      "Check page speed, stock, pricing and recent site changes for the dates of the drop.",
      "Compare with a campaign that sends traffic to a different page.",
    ],
  },
  reallocate_budget: {
    label: "Rebalance budget",
    alternatives: [
      "Move 20-30% of budget from the weaker entity to a stronger one and re-measure after a few days.",
      "Keep budgets as they are and fix the weaker entity's creative or audience first.",
      "Consolidate into fewer ad sets so each gets enough data to optimise.",
    ],
  },
  investigate: {
    label: "Investigate the driver",
    alternatives: [
      "Break the driver down by placement, audience and creative in the ad platform.",
      "Check the account change history for edits at the start of the weaker period.",
    ],
  },
  scale_gradually: {
    label: "Scale gradually",
    alternatives: [
      "Duplicate into a new ad set with a higher budget and leave the original untouched.",
      "Increase in 20-30% steps every 3-4 days rather than in one jump.",
      "Widen the audience before adding budget, so frequency does not climb.",
    ],
  },
  wait_for_data: {
    label: "Wait for more data",
    alternatives: [
      "Cap the budget meanwhile if the risk worries you, rather than pausing.",
      "Set an alert so AdMate flags it when the next report crosses the threshold.",
    ],
  },
  keep_running: {
    label: "Keep running",
    alternatives: [
      "Avoid edits that reset the platform's learning while this holds.",
      "Note what changed before the improvement, so it can be repeated elsewhere.",
    ],
  },
};

export interface Diagnosis {
  id: string;
  tier: Tier;
  action: ActionType;
  actionLabel: string;
  /** Name of the pattern, e.g. "Creative fatigue likely". */
  title: string;
  /** One-sentence factual summary - the primary finding's headline. */
  summary: string;
  level: EntityLevel;
  entityName: string;
  campaign: string | null;
  adset: string | null;
  objective: Objective | "mixed" | null;
  primaryFindingId: string;
  findingIds: string[];
  /** Titles of every signal that fed this diagnosis. */
  signals: string[];
  /** The 2-4 numbers that best support it. */
  keyEvidence: EvidenceItem[];
  drivers: FindingDriver[];
  confidence: Confidence;
  strength: EvidenceStrength;
  /** The one action, phrased for this entity. */
  recommendation: string;
  alternatives: string[];
  /** When to look again. */
  recheck: string;
  spendAtStake: number | null;
  severityScore: number;
}

const TIER_ORDER: Record<Tier, number> = { critical: 0, attention: 1, monitor: 2, performing: 3 };

const COST_CODES = new Set(["cpa_spike", "cpl_spike", "roas_drop"]);
const STRUCTURAL_CODES = new Set(["conversion_tracking_gap", "budget_concentration", "long_tail_waste"]);

function groupKey(f: Finding): string {
  const positive = f.kind === "issue" ? "issue" : "positive";
  const structural = STRUCTURAL_CODES.has(f.code) ? f.code : "";
  return [positive, structural, f.level, f.campaign ?? "", f.adset ?? "", f.entityName].join("\u0000");
}

function entityLabel(f: Finding): string {
  if (f.level === "account") return "the account";
  const noun = f.level === "adset" ? "ad set" : f.level;
  return `${noun} "${f.entityName}"`;
}

/** Picks the pattern and action for a set of signals on one entity. */
function classify(group: Finding[]): { title: string; action: ActionType; recommendation: string } {
  const codes = new Set(group.map((f) => f.code));
  const primary = group[0];
  const who = entityLabel(primary);
  const drivers = group.find((f) => f.drivers && f.drivers.length > 0)?.drivers ?? [];
  const strength = primary.strength ?? "moderate";
  const hasCostMove = [...codes].some((c) => COST_CODES.has(c));
  const fatigue =
    codes.has("ctr_drop") ||
    group.some((f) => f.code === "high_frequency" && f.context.ctrFalling === "yes");

  if (codes.has("conversion_tracking_gap")) {
    return {
      title: primary.title,
      action: "fix_tracking",
      recommendation:
        "Confirm conversion tracking before acting on any cost-per-result number in this report - a tracking fault and a performance problem need opposite fixes.",
    };
  }
  if (codes.has("budget_concentration")) {
    return {
      title: primary.title,
      action: "reallocate_budget",
      recommendation: `Make sure the campaign carrying most of the budget is also the most efficient, and keep a second campaign funded enough to fall back on.`,
    };
  }
  if (codes.has("long_tail_waste")) {
    return {
      title: primary.title,
      action: "reallocate_budget",
      recommendation: "Consolidate budget into the ads that convert; review only the non-converting ads with meaningful spend.",
    };
  }
  if (codes.has("scale_opportunity")) {
    return {
      title: "Efficient - room to scale",
      action: "scale_gradually",
      recommendation: `Raise the budget on ${who} by 20-30% and re-measure before the next step.`,
    };
  }
  if (primary.kind === "win") {
    return {
      title: primary.title,
      action: "keep_running",
      recommendation: `Leave ${who} running as it is and note what changed, so it can be repeated.`,
    };
  }
  const inconclusiveZero = primary.code === "spend_no_conversions" && strength !== "strong";
  if (strength === "weak" || inconclusiveZero) {
    return {
      title: `${primary.title} - not yet conclusive`,
      action: "wait_for_data",
      recommendation: `Don't change ${who} on this evidence yet: ${primary.dataNeeded ?? "more data is needed to tell this apart from normal fluctuation"}.`,
    };
  }
  const zero = group.find((f) => f.code === "spend_no_conversions");
  if (zero && zero.strength === "strong") {
    return {
      title: primary.code === "spend_no_conversions" ? primary.title : "Spending without results",
      action: "pause_or_reduce",
      recommendation: `After confirming tracking fires, reduce or pause ${who} - its traffic would normally have produced results by now.`,
    };
  }
  if (hasCostMove && fatigue) {
    return {
      title: "Creative fatigue likely",
      action: "refresh_creative",
      recommendation: `Add fresh creative to ${who}: response to the ads fell while cost per result rose.`,
    };
  }
  if (hasCostMove && codes.has("cvr_drop") && !codes.has("ctr_drop")) {
    return {
      title: "Conversion rate fell after the click",
      action: "check_landing_page",
      recommendation: `Check the landing page and conversion flow for ${who} - clicks held up but fewer of them converted.`,
    };
  }
  if (hasCostMove && drivers[0]?.kind === "mix") {
    return {
      title: "Budget shifted toward a weaker performer",
      action: "reallocate_budget",
      recommendation: `Rebalance budget inside ${who}: spend moved toward "${drivers[0].name}", which converts less efficiently.`,
    };
  }
  if (hasCostMove && codes.has("cpm_spike") && !codes.has("cvr_drop")) {
    return {
      title: "Rising auction costs",
      action: "adjust_audience",
      recommendation: `Test broader audiences or placements for ${who}: the cost of reaching people rose, not the ads' performance.`,
    };
  }
  if (hasCostMove && drivers.length > 0) {
    return {
      title: "Efficiency decline",
      action: "investigate",
      recommendation: `Look at "${drivers[0].name}" first inside ${who} - it accounts for most of the change.`,
    };
  }
  if (hasCostMove) {
    return {
      title: "Efficiency decline",
      action: "investigate",
      recommendation: `Break ${who} down by creative, audience and placement to find where the decline sits.`,
    };
  }
  if (codes.has("cvr_drop")) {
    return { title: primary.title, action: "check_landing_page", recommendation: `Test the conversion path for ${who} end to end.` };
  }
  if (codes.has("ctr_drop") || codes.has("ctr_below_benchmark")) {
    return {
      title: fatigue ? "Creative fatigue likely" : primary.title,
      action: "refresh_creative",
      recommendation: `Test new creative for ${who}: fewer people are clicking after seeing the ads.`,
    };
  }
  if (codes.has("high_frequency")) {
    return {
      title: primary.title,
      action: "adjust_audience",
      recommendation: `Broaden the audience or lower the budget for ${who} before frequency erodes response.`,
    };
  }
  if (codes.has("cpm_spike") || codes.has("cpc_spike")) {
    return {
      title: primary.title,
      action: "adjust_audience",
      recommendation: `Review audience and placements for ${who}; judge it on cost per result before reacting to delivery costs.`,
    };
  }
  if ([...codes].some((c) => c.endsWith("_above_benchmark"))) {
    const share = primary.evidence.find((e) => e.label === "Share of account spend")?.value ?? 0;
    const confident = primary.strength === "strong" && primary.confidence !== "low";
    return share > 0.15 || !confident
      ? {
          title: primary.title,
          action: "reallocate_budget",
          recommendation: `Shift part of ${who}'s budget toward better-performing comparable campaigns, and fix its setup before restoring it.`,
        }
      : {
          title: primary.title,
          action: "pause_or_reduce",
          recommendation: `Reduce ${who}'s budget - it is consistently less efficient than comparable campaigns.`,
        };
  }
  return { title: primary.title, action: "investigate", recommendation: primary.actions[0] ?? "Investigate this signal." };
}

function tierFor(group: Finding[], action: ActionType): Tier {
  const primary = group[0];
  if (primary.kind !== "issue") return "performing";
  if (action === "wait_for_data") return "monitor";
  if (primary.code === "budget_concentration") return "monitor";
  const strength = primary.strength ?? "moderate";
  if (primary.code === "conversion_tracking_gap") return strength === "strong" ? "critical" : "attention";
  if (primary.priority === "high" && strength === "strong" && primary.confidence !== "low") return "critical";
  if (primary.priority === "low") return "monitor";
  return "attention";
}

function recheckFor(primary: Finding, action: ActionType): string {
  if (action === "wait_for_data" && primary.dataNeeded) return `Recheck when ${primary.dataNeeded.replace(/ would make this conclusive$/, " have accumulated")}.`;
  if (action === "fix_tracking") return "Recheck after the next export once tracking is confirmed.";
  if (action === "scale_gradually") return "Recheck 3-4 days after each budget step.";
  if (primary.metric === "frequency") return "Recheck in 3-4 days.";
  const conv = primary.evidence.find((e) => e.metric === "conversions" || e.metric === "leads");
  if (conv && conv.value !== null && conv.value > 0) {
    const n = Math.max(10, Math.round(conv.value));
    return `Recheck after roughly ${n} more results or 7 days, whichever comes first.`;
  }
  return "Recheck in 7 days.";
}

export function buildDiagnoses(findings: Finding[]): Diagnosis[] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = groupKey(f);
    const bucket = groups.get(key);
    if (bucket) bucket.push(f);
    else groups.set(key, [f]);
  }

  const out: Diagnosis[] = [];
  for (const group of groups.values()) {
    // Strongest evidence first, then severity: a strong moderate-size signal
    // is a better anchor than a large weak one.
    const rank = { strong: 0, moderate: 1, weak: 2 } as const;
    group.sort(
      (a, b) =>
        rank[a.strength ?? "moderate"] - rank[b.strength ?? "moderate"] || b.severityScore - a.severityScore,
    );
    const primary = group[0];
    const { title, action, recommendation } = classify(group);
    const tier = tierFor(group, action);

    const keyEvidence: EvidenceItem[] = [];
    const seen = new Set<string>();
    for (const f of group) {
      const e = f.evidence.find((x) => x.value !== null && !seen.has(x.label));
      if (e) {
        keyEvidence.push(e);
        seen.add(e.label);
      }
      if (keyEvidence.length >= 3) break;
    }
    for (const e of primary.evidence) {
      if (keyEvidence.length >= 3) break;
      if (e.value !== null && !seen.has(e.label)) {
        keyEvidence.push(e);
        seen.add(e.label);
      }
    }

    out.push({
      id: `dx:${primary.id}`,
      tier,
      action,
      actionLabel: ACTION_META[action].label,
      title,
      summary: primary.headline,
      level: primary.level,
      entityName: primary.entityName,
      campaign: primary.campaign,
      adset: primary.adset,
      objective: primary.objective ?? null,
      primaryFindingId: primary.id,
      findingIds: group.map((f) => f.id),
      signals: group.map((f) => f.title),
      keyEvidence,
      drivers: group.find((f) => f.drivers && f.drivers.length > 0)?.drivers ?? [],
      confidence: primary.confidence,
      strength: primary.strength ?? "moderate",
      recommendation,
      alternatives: ACTION_META[action].alternatives,
      recheck: recheckFor(primary, action),
      spendAtStake: primary.spendAtStake,
      severityScore: Math.max(...group.map((f) => f.severityScore)),
    });
  }

  out.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.severityScore - a.severityScore);
  return out;
}
