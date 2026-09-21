import type { MetricKey } from "@/lib/analysis/types";
import { METRIC_META } from "@/lib/analysis/types";

/** Client-safe formatting. Mirrors the server helpers in detectors.ts. */

export function formatMetric(
  value: number | null | undefined,
  metric: MetricKey,
  currency = "USD",
): string {
  if (value === null || value === undefined) return "—";
  return formatByType(value, METRIC_META[metric].format, currency);
}

export function formatByType(
  value: number | null | undefined,
  format: "integer" | "currency" | "percent" | "ratio" | "decimal",
  currency = "USD",
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  switch (format) {
    case "currency":
      return formatCurrency(value, currency);
    case "percent":
      return `${(value * 100).toFixed(2)}%`;
    case "ratio":
      return `${value.toFixed(2)}x`;
    case "integer":
      return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
    default:
      return new Intl.NumberFormat("en-US", {
        maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
      }).format(value);
  }
}

export function formatCurrency(value: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** Compact form for KPI tiles: 1.2K, 843.8K, 2.1M. */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** Signed percentage, for changes. */
export function formatChange(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

/** Unsigned percentage, for shares. */
export function formatShare(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Whether a change is good news, given which direction the metric should move.
 * Returns null when the metric has no inherent direction (spend, impressions).
 */
export function changeIsGood(metric: MetricKey, change: number): boolean | null {
  const dir = METRIC_META[metric].higherIsBetter;
  if (dir === null) return null;
  if (change === 0) return null;
  return dir ? change > 0 : change < 0;
}
