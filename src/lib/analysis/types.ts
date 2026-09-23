/**
 * Canonical data model for AdMate.
 *
 * Design rule that the whole codebase depends on:
 *   `null` means "this platform did not report the field".
 *   `0`    means "the platform reported a real zero".
 * These are never collapsed into each other, because "0 conversions" and
 * "conversions not tracked" lead to opposite recommendations.
 */

export type Platform = "meta" | "tiktok" | "google" | "linkedin" | "other";

export const PLATFORM_LABELS: Record<Platform, string> = {
  meta: "Meta Ads",
  tiktok: "TikTok Ads",
  google: "Google Ads",
  linkedin: "LinkedIn Ads",
  other: "Other / generic export",
};

/** Metrics we accept straight from a report file (never computed). */
export type BaseMetric =
  | "impressions"
  | "reach"
  | "clicks"
  | "spend"
  | "conversions"
  | "revenue"
  | "frequency"
  | "videoViews"
  | "leads"
  | "landingPageViews"
  | "engagements"
  | "thruplays";

/** Metrics AdMate computes itself, and only when every input exists. */
export type DerivedMetric =
  | "ctr"
  | "cpc"
  | "cpm"
  | "cpa"
  | "roas"
  | "cvr"
  | "aov"
  | "cpl"
  | "leadRate"
  | "costPerLpv"
  | "cpe"
  | "engagementRate"
  | "costPerThruplay";

export type MetricKey = BaseMetric | DerivedMetric;

/** Dimension columns that describe *which* thing a row is about. */
export type DimensionKey = "date" | "campaign" | "adset" | "ad" | "resultType";

export type ColumnKey = DimensionKey | BaseMetric;

export const BASE_METRICS: BaseMetric[] = [
  "impressions",
  "reach",
  "clicks",
  "spend",
  "conversions",
  "revenue",
  "frequency",
  "videoViews",
  "leads",
  "landingPageViews",
  "engagements",
  "thruplays",
];

export const DERIVED_METRICS: DerivedMetric[] = [
  "ctr",
  "cpc",
  "cpm",
  "cpa",
  "roas",
  "cvr",
  "aov",
  "cpl",
  "leadRate",
  "costPerLpv",
  "cpe",
  "engagementRate",
  "costPerThruplay",
];

export interface MetricMeta {
  key: MetricKey;
  label: string;
  /** "currency" renders with the report currency, "percent" as %, "ratio" as x. */
  format: "integer" | "currency" | "percent" | "ratio" | "decimal";
  /** Is a higher value better? `null` when it depends on context (e.g. spend). */
  higherIsBetter: boolean | null;
  description: string;
}

export const METRIC_META: Record<MetricKey, MetricMeta> = {
  impressions: {
    key: "impressions",
    label: "Impressions",
    format: "integer",
    higherIsBetter: null,
    description: "Times the ad was displayed.",
  },
  reach: {
    key: "reach",
    label: "Reach",
    format: "integer",
    higherIsBetter: null,
    description: "Unique people who saw the ad.",
  },
  clicks: {
    key: "clicks",
    label: "Clicks",
    format: "integer",
    higherIsBetter: true,
    description: "Clicks recorded by the platform.",
  },
  spend: {
    key: "spend",
    label: "Spend",
    format: "currency",
    higherIsBetter: null,
    description: "Amount spent.",
  },
  conversions: {
    key: "conversions",
    label: "Conversions",
    format: "decimal",
    higherIsBetter: true,
    description: "Conversions / results attributed by the platform.",
  },
  revenue: {
    key: "revenue",
    label: "Revenue",
    format: "currency",
    higherIsBetter: true,
    description: "Conversion value attributed by the platform.",
  },
  frequency: {
    key: "frequency",
    label: "Frequency",
    format: "decimal",
    higherIsBetter: false,
    description: "Average impressions per person reached.",
  },
  videoViews: {
    key: "videoViews",
    label: "Video views",
    format: "integer",
    higherIsBetter: true,
    description: "Video views recorded by the platform.",
  },
  leads: {
    key: "leads",
    label: "Leads",
    format: "decimal",
    higherIsBetter: true,
    description: "Leads (form submissions or lead events) recorded by the platform.",
  },
  landingPageViews: {
    key: "landingPageViews",
    label: "Landing page views",
    format: "integer",
    higherIsBetter: true,
    description: "Clicks that went on to load the landing page.",
  },
  engagements: {
    key: "engagements",
    label: "Engagements",
    format: "integer",
    higherIsBetter: true,
    description: "Post engagements (reactions, comments, shares, saves, clicks).",
  },
  thruplays: {
    key: "thruplays",
    label: "ThruPlays",
    format: "integer",
    higherIsBetter: true,
    description: "Video plays watched to completion or for at least 15 seconds.",
  },
  ctr: {
    key: "ctr",
    label: "CTR",
    format: "percent",
    higherIsBetter: true,
    description: "Clicks / impressions.",
  },
  cpc: {
    key: "cpc",
    label: "CPC",
    format: "currency",
    higherIsBetter: false,
    description: "Spend / clicks.",
  },
  cpm: {
    key: "cpm",
    label: "CPM",
    format: "currency",
    higherIsBetter: false,
    description: "Spend per 1,000 impressions.",
  },
  cpa: {
    key: "cpa",
    label: "CPA",
    format: "currency",
    higherIsBetter: false,
    description: "Spend / conversions.",
  },
  roas: {
    key: "roas",
    label: "ROAS",
    format: "ratio",
    higherIsBetter: true,
    description: "Revenue / spend.",
  },
  cvr: {
    key: "cvr",
    label: "Conversion rate",
    format: "percent",
    higherIsBetter: true,
    description: "Conversions / clicks.",
  },
  aov: {
    key: "aov",
    label: "Average order value",
    format: "currency",
    higherIsBetter: true,
    description: "Revenue / conversions.",
  },
  cpl: {
    key: "cpl",
    label: "CPL",
    format: "currency",
    higherIsBetter: false,
    description: "Spend / leads.",
  },
  leadRate: {
    key: "leadRate",
    label: "Lead rate",
    format: "percent",
    higherIsBetter: true,
    description: "Leads / clicks.",
  },
  costPerLpv: {
    key: "costPerLpv",
    label: "Cost per landing page view",
    format: "currency",
    higherIsBetter: false,
    description: "Spend / landing page views.",
  },
  cpe: {
    key: "cpe",
    label: "Cost per engagement",
    format: "currency",
    higherIsBetter: false,
    description: "Spend / engagements.",
  },
  engagementRate: {
    key: "engagementRate",
    label: "Engagement rate",
    format: "percent",
    higherIsBetter: true,
    description: "Engagements / impressions.",
  },
  costPerThruplay: {
    key: "costPerThruplay",
    label: "Cost per ThruPlay",
    format: "currency",
    higherIsBetter: false,
    description: "Spend / ThruPlays.",
  },
};

/** One normalized row of an uploaded report. */
export interface NormalizedRow {
  date: string | null; // ISO yyyy-mm-dd
  campaign: string | null;
  adset: string | null;
  ad: string | null;
  /**
   * Platform "result type" / objective label for the row, when the export has
   * one (Meta's "Result indicator", an "Objective" column). Optional so rows
   * stored before this field existed still deserialize.
   */
  resultType?: string | null;
  metrics: Partial<Record<BaseMetric, number | null>>;
}

export type EntityLevel = "account" | "campaign" | "adset" | "ad";

/** Aggregated metrics for one entity (or the whole account). */
export interface MetricSet {
  base: Partial<Record<BaseMetric, number | null>>;
  derived: Partial<Record<DerivedMetric, number | null>>;
}

export interface EntityPerformance {
  id: string;
  level: EntityLevel;
  name: string;
  /** Parent chain, e.g. an ad knows its campaign and ad set. */
  campaign: string | null;
  adset: string | null;
  rowCount: number;
  metrics: MetricSet;
  /** Present only when the report has usable date-level data. */
  trend?: TrendPoint[];
  /** Present only when the period can be split into two comparable halves. */
  periodComparison?: PeriodComparison;
}

export interface TrendPoint {
  date: string;
  metrics: MetricSet;
}

export interface PeriodDelta {
  metric: MetricKey;
  current: number | null;
  previous: number | null;
  /** Fractional change, e.g. 0.6 == +60%. Null when it cannot be computed. */
  changePct: number | null;
  absoluteChange: number | null;
}

export interface PeriodComparison {
  currentLabel: string;
  previousLabel: string;
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
  currentDays: number;
  previousDays: number;
  /** Middle day left out of an odd-length window so both halves are equal. */
  excludedDay?: string | null;
  deltas: Partial<Record<MetricKey, PeriodDelta>>;
}
