import type { MetricKey } from "./types";
import type { Objective } from "./objectives";

/**
 * Plain-language metric explanations: what it measures, how to read a move,
 * and whether it matters for a given objective. Deterministic content, shown
 * in the metric info popovers and handed to the assistant when a user asks
 * "what does this mean?" - so the explanation never depends on a model.
 */

export interface MetricExplanation {
  what: string;
  /** How to read an increase / decrease. */
  reading: string;
  /** Which neighbouring metrics explain a move in this one. */
  diagnose: string;
}

export const GLOSSARY: Partial<Record<MetricKey, MetricExplanation>> = {
  spend: {
    what: "Money spent on delivery in the period.",
    reading: "Neither good nor bad on its own - judge it by what it bought (results, cost per result).",
    diagnose: "If spend rose, check whether results rose in proportion.",
  },
  impressions: {
    what: "How many times the ads were shown.",
    reading: "More impressions at the same spend means cheaper delivery (lower CPM).",
    diagnose: "Pair with reach and frequency to see whether you are reaching new people or the same ones.",
  },
  reach: {
    what: "How many different people saw the ads.",
    reading: "Growing reach means new people; flat reach with rising impressions means repetition.",
    diagnose: "Divide impressions by reach to get frequency.",
  },
  frequency: {
    what: "How many times, on average, each person saw the ads.",
    reading: "Above about 3 in a short window, response often starts to fall (ad fatigue). Retargeting tolerates more.",
    diagnose: "If frequency rises while CTR falls, fatigue is the likely story.",
  },
  clicks: {
    what: "Clicks recorded by the platform (usually link clicks).",
    reading: "More clicks is good only if cost per click and conversion rate hold.",
    diagnose: "CTR tells you whether clicks rose because of more delivery or better response.",
  },
  ctr: {
    what: "Click-through rate: the share of impressions that led to a click.",
    reading: "A falling CTR means fewer people are responding to what they see - usually creative, offer or audience fit.",
    diagnose: "Check frequency (fatigue) and whether delivery expanded into a broader audience.",
  },
  cpc: {
    what: "Cost per click: spend divided by clicks.",
    reading: "CPC rises either because impressions got more expensive (CPM up) or fewer people click (CTR down).",
    diagnose: "CPC = CPM ÷ (CTR × 1,000): compare CPM and CTR to see which one moved.",
  },
  cpm: {
    what: "Cost per 1,000 impressions - the price of reaching people.",
    reading: "Rising CPM usually reflects auction competition, seasonality or a narrower audience, not ad quality.",
    diagnose: "Judge conversion campaigns on cost per result; a higher CPM is fine if results keep pace.",
  },
  conversions: {
    what: "Conversions (results) attributed by the platform.",
    reading: "Attributed conversions lag - the most recent days are often under-counted.",
    diagnose: "Separate volume from efficiency: look at conversion rate and cost per conversion.",
  },
  cpa: {
    what: "Cost per acquisition: spend divided by conversions.",
    reading: "Rising CPA means each result costs more. It is driven by CPM (cost to reach), CTR (response) and conversion rate (after the click).",
    diagnose: "CPA = CPC ÷ conversion rate: check which of the two moved.",
  },
  cvr: {
    what: "Conversion rate: conversions divided by clicks.",
    reading: "A drop with steady clicks points after the click - landing page, offer, checkout or tracking.",
    diagnose: "Test the conversion path and confirm tracking before changing ads.",
  },
  revenue: {
    what: "Conversion value attributed by the platform.",
    reading: "Attributed revenue, not your bank balance - compare with your store data for truth.",
    diagnose: "Split into conversions × average order value.",
  },
  roas: {
    what: "Return on ad spend: revenue divided by spend.",
    reading: "3.0x means $3 of attributed revenue per $1 spent. Whether that is profitable depends on your margins.",
    diagnose: "ROAS = conversion rate × average order value ÷ CPC.",
  },
  aov: {
    what: "Average order value: revenue divided by conversions.",
    reading: "A falling AOV lowers ROAS even when CPA holds.",
    diagnose: "Check for discounts or a shift toward cheaper products.",
  },
  leads: {
    what: "Leads (forms or lead events) recorded by the platform.",
    reading: "Volume says nothing about quality - check how many become customers.",
    diagnose: "Look at cost per lead and lead rate together.",
  },
  cpl: {
    what: "Cost per lead: spend divided by leads.",
    reading: "A cheaper lead is only better if lead quality holds downstream.",
    diagnose: "CPL = CPC ÷ lead rate: check which moved.",
  },
  leadRate: {
    what: "Lead rate: leads divided by clicks.",
    reading: "A drop points at the form or landing page more than the ad.",
    diagnose: "Test the form yourself on mobile.",
  },
  landingPageViews: {
    what: "Clicks that loaded the landing page.",
    reading: "A big gap between clicks and landing page views suggests slow pages or accidental clicks.",
    diagnose: "Compare with clicks, and check page speed.",
  },
  costPerLpv: {
    what: "Cost per landing page view.",
    reading: "The truest cost of a traffic campaign - it ignores clicks that never loaded the page.",
    diagnose: "If it rises faster than CPC, the page may be loading slowly.",
  },
  engagements: {
    what: "Post engagements: reactions, comments, shares, saves and clicks.",
    reading: "Useful for social proof and cheap audiences; rarely a business outcome on its own.",
    diagnose: "Pair with engagement rate.",
  },
  cpe: {
    what: "Cost per engagement.",
    reading: "Lower is better for engagement campaigns.",
    diagnose: "Driven by CPM and engagement rate.",
  },
  engagementRate: {
    what: "Engagements divided by impressions.",
    reading: "Falling engagement rate is an early sign of creative fatigue.",
    diagnose: "Check frequency.",
  },
  videoViews: {
    what: "Video views as counted by the platform (often 2-3 seconds).",
    reading: "Short views are cheap and noisy - ThruPlays are a better quality signal.",
    diagnose: "Compare views to ThruPlays for hold rate.",
  },
  thruplays: {
    what: "Video plays watched to completion or for at least 15 seconds.",
    reading: "A better measure of real attention than short views.",
    diagnose: "Pair with cost per ThruPlay.",
  },
  costPerThruplay: {
    what: "Cost per ThruPlay.",
    reading: "The main efficiency measure for video view campaigns.",
    diagnose: "Driven by CPM and how many viewers keep watching.",
  },
};

const RELEVANCE: Record<Objective, Partial<Record<MetricKey, string>>> = {
  sales: {
    cpa: "The main efficiency metric for this objective.",
    roas: "The main value metric for this objective.",
    ctr: "A diagnostic here, not a goal.",
    cpm: "A diagnostic here, not a goal.",
  },
  leads: { cpl: "The main efficiency metric for this objective.", cpa: "Cost per lead when leads come through the conversions column." },
  traffic: {
    cpc: "The main efficiency metric for this objective.",
    ctr: "A key quality signal for traffic campaigns.",
    cpa: "Not what traffic campaigns optimise for - AdMate does not judge them on it.",
  },
  awareness: {
    cpm: "The main efficiency metric for this objective.",
    frequency: "Watch it: awareness budgets saturate audiences quickly.",
    cpa: "Not relevant: awareness campaigns are not optimised for conversions.",
    ctr: "Secondary for awareness campaigns.",
  },
  engagement: { cpe: "The main efficiency metric for this objective." },
  video: { costPerThruplay: "The main efficiency metric for this objective." },
  app: { cpa: "Cost per install for this objective." },
};

export function relevanceNote(metric: MetricKey, objective: Objective | "mixed" | null): string | null {
  if (!objective || objective === "mixed") return null;
  return RELEVANCE[objective][metric] ?? null;
}
