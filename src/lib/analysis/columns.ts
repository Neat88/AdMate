import type { ColumnKey, Platform } from "./types";

/**
 * Cross-platform header matching.
 *
 * Meta, TikTok, Google and LinkedIn all export the same underlying ideas under
 * different labels ("Amount spent (USD)" / "Cost" / "Total Spent"). Rather than
 * maintaining one parser per platform, we normalize headers to a comparable
 * form and score them against a synonym dictionary. The best score wins, and
 * anything below `MIN_CONFIDENCE` is left unmapped for the user to fix in the
 * mapping review step.
 */

export interface ColumnCandidate {
  key: ColumnKey;
  /** 0..1 - how sure we are about this mapping. */
  confidence: number;
}

export interface ColumnMapping {
  /** Source header text, exactly as it appeared in the file. */
  header: string;
  /** Column index in the source file. */
  index: number;
  /** Mapped canonical key, or null if unmapped / ignored. */
  key: ColumnKey | null;
  confidence: number;
  /** Other plausible interpretations, offered in the mapping UI. */
  alternatives: ColumnCandidate[];
  /** A few non-empty sample values, for the preview table. */
  samples: string[];
}

export const MIN_CONFIDENCE = 0.55;

/**
 * Synonyms per canonical key. `exact` entries are full normalized headers and
 * score 1.0; `contains` entries are substrings and score lower, so that a
 * header matching an exact synonym always beats a loose substring hit.
 */
interface SynonymSpec {
  exact: string[];
  contains?: string[];
  /** Headers that must NOT appear, to stop near-misses hijacking a column. */
  reject?: string[];
}

const SYNONYMS: Record<ColumnKey, SynonymSpec> = {
  date: {
    exact: [
      "date",
      "day",
      "reporting starts",
      "reporting start",
      "week",
      "month",
      "start date",
      "stat time day",
      "time",
      "date start",
    ],
    contains: ["date", "day"],
    reject: ["end date", "reporting ends", "date end", "updated"],
  },
  campaign: {
    exact: [
      "campaign",
      "campaign name",
      "campaign title",
      "campaign group name",
      "campaign id name",
    ],
    contains: ["campaign name", "campaign"],
    reject: ["campaign id", "campaign objective", "campaign status", "campaign budget", "campaign delivery"],
  },
  adset: {
    exact: [
      "ad set name",
      "adset name",
      "ad set",
      "adset",
      "ad group",
      "ad group name",
      "adgroup name",
      "campaign group name",
      "ad squad name",
    ],
    contains: ["ad set name", "ad group name", "adset name"],
    reject: ["ad set id", "ad group id", "ad set status", "ad group status"],
  },
  ad: {
    exact: ["ad name", "ad", "creative name", "ad title", "ad creative name", "headline"],
    contains: ["ad name", "creative name"],
    reject: ["ad id", "ad set", "ad group", "ad status", "ad delivery", "ad account"],
  },
  impressions: {
    exact: ["impressions", "impr", "impr.", "impressions total", "total impressions", "imps"],
    contains: ["impression"],
    reject: ["cost per 1,000 impressions", "cpm", "impression share", "unique impressions"],
  },
  reach: {
    exact: ["reach", "unique reach", "people reached", "unique users reached"],
    contains: ["reach"],
    reject: ["reach rate"],
  },
  clicks: {
    exact: [
      "clicks",
      "clicks all",
      "link clicks",
      "clicks destination",
      "total clicks",
      "clicks link",
      "interactions",
    ],
    contains: ["link click", "clicks"],
    reject: ["click through rate", "ctr", "cost per click", "cpc", "unique clicks", "click share"],
  },
  spend: {
    exact: [
      "spend",
      "cost",
      "amount spent",
      "total spent",
      "amount spent usd",
      "spend usd",
      "total cost",
      "cost usd",
      "money spent",
      "budget spent",
    ],
    contains: ["amount spent", "total spent", "spend", "cost"],
    reject: [
      "cost per",
      "cost conv",
      "cost per conversion",
      "cost per result",
      "cost per click",
      "cost per 1,000 impressions",
      "conv value cost",
    ],
  },
  conversions: {
    exact: [
      "conversions",
      "conversion",
      "results",
      "total conversions",
      "purchases",
      "website purchases",
      "conversions total",
      "complete payment",
      "all conversions",
      "key events",
    ],
    contains: ["conversion", "results", "purchases"],
    reject: [
      "conversion value",
      "cost per conversion",
      "conversion rate",
      "conv value",
      "cost conv",
      "value per conversion",
      "conversions rate",
    ],
  },
  revenue: {
    exact: [
      "revenue",
      "conversion value",
      "conv value",
      "total revenue",
      "purchase value",
      "website purchases conversion value",
      "total complete payment value",
      "value",
      "purchase conversion value",
      "total conversion value",
    ],
    contains: ["conversion value", "conv value", "purchase value", "revenue"],
    reject: ["value per", "conv value cost", "cost per"],
  },
  frequency: {
    exact: ["frequency", "avg frequency", "average frequency"],
    contains: ["frequency"],
  },
  videoViews: {
    exact: [
      "video views",
      "video plays",
      "2 second continuous video plays",
      "video views 2s",
      "total video views",
      "views",
    ],
    contains: ["video view", "video play"],
    reject: ["video view rate", "cost per video view"],
  },
};

/**
 * Lower-cases, strips currency/parenthetical qualifiers and punctuation so that
 * "Amount spent (USD)" and "amount_spent_usd" collapse to the same string.
 */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/\(.*?\)/g, " ") // drop "(USD)", "(all)", "(destination)"
    .replace(/[_\-./]+/g, " ")
    .replace(/[^a-z0-9, ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same as normalizeHeader but also keeps parenthetical text, for reject checks. */
function normalizeHeaderFull(header: string): string {
  return header
    .toLowerCase()
    .replace(/[_\-./]+/g, " ")
    .replace(/[^a-z0-9, ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreKey(header: string, key: ColumnKey): number {
  const spec = SYNONYMS[key];
  const norm = normalizeHeader(header);
  const full = normalizeHeaderFull(header);
  if (!norm) return 0;

  // A reject term anywhere in the header disqualifies this key outright.
  for (const bad of spec.reject ?? []) {
    if (full.includes(bad) || norm.includes(bad)) return 0;
  }

  if (spec.exact.includes(norm)) return 1;

  // Exact match once the parentheticals are put back (e.g. "clicks all").
  if (spec.exact.includes(full)) return 0.95;

  // Header starts with a synonym: "impressions total" -> impressions.
  for (const syn of spec.exact) {
    if (norm.startsWith(syn + " ") || norm.endsWith(" " + syn)) return 0.8;
  }

  for (const sub of spec.contains ?? []) {
    if (norm.includes(sub)) {
      // Longer substrings are more specific, so trust them more.
      return Math.min(0.75, 0.45 + sub.length / 40);
    }
  }
  return 0;
}

const ALL_KEYS = Object.keys(SYNONYMS) as ColumnKey[];

/**
 * Maps a set of file headers onto canonical keys.
 *
 * Resolution is global rather than per-column: every (header, key) pair is
 * scored, then assigned best-first so a single key is never claimed by two
 * columns. This matters for exports that contain both "Clicks (all)" and
 * "Link clicks" - the stronger match wins and the other is left unmapped
 * rather than silently overwriting it.
 */
export function mapColumns(
  headers: string[],
  rows: string[][],
  _platform: Platform = "other",
): ColumnMapping[] {
  const scored: { header: number; key: ColumnKey; score: number }[] = [];
  headers.forEach((header, index) => {
    for (const key of ALL_KEYS) {
      const score = scoreKey(header, key);
      if (score > 0) scored.push({ header: index, key, score });
    }
  });

  scored.sort((a, b) => b.score - a.score);

  const assignedKey = new Map<number, { key: ColumnKey; score: number }>();
  const usedKeys = new Set<ColumnKey>();
  for (const entry of scored) {
    if (entry.score < MIN_CONFIDENCE) continue;
    if (assignedKey.has(entry.header)) continue;
    if (usedKeys.has(entry.key)) continue;
    assignedKey.set(entry.header, { key: entry.key, score: entry.score });
    usedKeys.add(entry.key);
  }

  return headers.map((header, index) => {
    const assigned = assignedKey.get(index);
    const alternatives = scored
      .filter((s) => s.header === index && s.key !== assigned?.key)
      .slice(0, 3)
      .map((s) => ({ key: s.key, confidence: round2(s.score) }));

    const samples: string[] = [];
    for (const row of rows) {
      const value = row[index];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        samples.push(String(value));
      }
      if (samples.length >= 3) break;
    }

    return {
      header,
      index,
      key: assigned?.key ?? null,
      confidence: assigned ? round2(assigned.score) : 0,
      alternatives,
      samples,
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Guesses the source platform from the header vocabulary. */
export function detectPlatform(headers: string[]): { platform: Platform; confidence: number } {
  // Check both forms: some platform signals live in the parenthetical that
  // normalizeHeader strips (TikTok's "Clicks (destination)", for example).
  const norm = headers.map(normalizeHeader);
  const full = headers.map(normalizeHeaderFull);
  const has = (needle: string) =>
    norm.some((h) => h.includes(needle)) || full.some((h) => h.includes(needle));

  const scores: Record<Platform, number> = {
    meta: 0,
    tiktok: 0,
    google: 0,
    linkedin: 0,
    other: 0,
  };

  if (has("amount spent")) scores.meta += 2;
  if (has("ad set name")) scores.meta += 2;
  if (has("reporting starts")) scores.meta += 2;
  if (has("purchase roas")) scores.meta += 1;
  if (has("results")) scores.meta += 1;

  if (has("ad group name") && has("cost")) scores.tiktok += 1;
  if (has("complete payment")) scores.tiktok += 3;
  if (has("stat time day")) scores.tiktok += 3;
  if (has("clicks destination") || has("ctr destination")) scores.tiktok += 3;

  if (has("impr")) scores.google += 1;
  if (has("conv value")) scores.google += 2;
  if (has("cost conv")) scores.google += 2;
  if (has("avg cpc")) scores.google += 2;
  if (has("ad group") && has("campaign") && has("conversions")) scores.google += 1;

  if (has("total spent")) scores.linkedin += 3;
  if (has("campaign group name")) scores.linkedin += 2;
  if (has("click through rate")) scores.linkedin += 1;
  if (has("start date in utc")) scores.linkedin += 2;

  let best: Platform = "other";
  let bestScore = 0;
  (Object.keys(scores) as Platform[]).forEach((p) => {
    if (scores[p] > bestScore) {
      bestScore = scores[p];
      best = p;
    }
  });

  if (bestScore < 2) return { platform: "other", confidence: 0 };
  return { platform: best, confidence: Math.min(1, bestScore / 5) };
}
