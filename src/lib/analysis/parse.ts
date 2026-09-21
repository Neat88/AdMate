import Papa from "papaparse";
import * as XLSX from "xlsx";
import { mapColumns, detectPlatform, type ColumnMapping } from "./columns";
import type { BaseMetric, ColumnKey, NormalizedRow, Platform } from "./types";
import { BASE_METRICS } from "./types";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_ROWS = 50_000;
export const ACCEPTED_EXTENSIONS = [".csv", ".tsv", ".xlsx", ".xls"];

export interface RawTable {
  headers: string[];
  rows: string[][];
  /** Rows dropped before parsing because they were completely empty. */
  skippedEmptyRows: number;
  truncated: boolean;
}

export class ParseError extends Error {}

function looksLikeHeaderRow(cells: string[]): boolean {
  const nonEmpty = cells.filter((c) => String(c ?? "").trim() !== "");
  if (nonEmpty.length < 2) return false;
  // A header row is mostly non-numeric text.
  const numeric = nonEmpty.filter((c) => /^-?[\d.,%$€£\s]+$/.test(String(c).trim()));
  return numeric.length / nonEmpty.length < 0.5;
}

/**
 * Platform exports often prefix the real table with title/date-range banner
 * rows (Google Ads and LinkedIn both do this). Find the first row that looks
 * like a header and has the most columns filled.
 */
function findHeaderRow(matrix: string[][]): number {
  const limit = Math.min(matrix.length, 15);
  let best = -1;
  let bestFilled = 0;
  for (let i = 0; i < limit; i++) {
    const row = matrix[i].map((c) => String(c ?? "").trim());
    if (!looksLikeHeaderRow(row)) continue;
    const filled = row.filter((c) => c !== "").length;
    if (filled > bestFilled) {
      bestFilled = filled;
      best = i;
    }
  }
  return best === -1 ? 0 : best;
}

function matrixToTable(matrix: string[][]): RawTable {
  if (matrix.length === 0) throw new ParseError("The file appears to be empty.");

  const headerIndex = findHeaderRow(matrix);
  const rawHeaders = (matrix[headerIndex] ?? []).map((c) => String(c ?? "").trim());

  // Trim trailing all-empty columns, then name any remaining blanks.
  let width = rawHeaders.length;
  while (width > 0 && rawHeaders[width - 1] === "") width--;
  const headers = rawHeaders
    .slice(0, width)
    .map((h, i) => (h === "" ? `Column ${i + 1}` : h));

  if (headers.length === 0) throw new ParseError("No column headers could be found in the file.");

  const body = matrix.slice(headerIndex + 1);
  const rows: string[][] = [];
  let skippedEmptyRows = 0;
  let truncated = false;

  for (const raw of body) {
    const row = headers.map((_, i) => String(raw?.[i] ?? "").trim());
    if (row.every((c) => c === "")) {
      skippedEmptyRows++;
      continue;
    }
    // Platform exports frequently end with a "Total" summary row that would
    // double-count if treated as data.
    const first = row[0].toLowerCase();
    if (first.startsWith("total") || first.startsWith("grand total") || first === "—") {
      skippedEmptyRows++;
      continue;
    }
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
    rows.push(row);
  }

  if (rows.length === 0) throw new ParseError("The file has headers but no data rows.");

  return { headers, rows, skippedEmptyRows, truncated };
}

export function parseCsv(text: string): RawTable {
  const result = Papa.parse<string[]>(text, {
    skipEmptyLines: false,
    header: false,
    dynamicTyping: false,
  });
  const matrix = (result.data as unknown as string[][]).filter(Array.isArray);
  return matrixToTable(matrix);
}

export function parseWorkbook(buffer: ArrayBuffer): RawTable {
  const wb = XLSX.read(buffer, { type: "array", cellDates: true, raw: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new ParseError("The workbook contains no sheets.");
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: true,
  }) as unknown as string[][];
  return matrixToTable(matrix);
}

export function parseFile(filename: string, buffer: ArrayBuffer): RawTable {
  const lower = filename.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    throw new ParseError(
      `Unsupported file type. AdMate accepts ${ACCEPTED_EXTENSIONS.join(", ")} files.`,
    );
  }
  if (buffer.byteLength === 0) throw new ParseError("The uploaded file is empty.");
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new ParseError(
      `File is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`,
    );
  }

  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
    return parseCsv(new TextDecoder("utf-8").decode(buffer));
  }
  return parseWorkbook(buffer);
}

/* -------------------------------------------------------------------------- */
/* Value coercion                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Parses a numeric cell.
 *
 * Returns `null` for anything that is not a real reported number - blank cells,
 * and the placeholder dashes platforms use for "not applicable". A literal "0"
 * returns 0, which is a meaningfully different answer.
 */
export function parseNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  let s = value.trim();
  if (s === "") return null;

  const placeholder = s.toLowerCase();
  if (["-", "--", "—", "–", "n/a", "na", "null", "not available", "(not set)", "—"].includes(placeholder)) {
    return null;
  }

  // Parenthesised negatives: (1,234.56)
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  const isPercent = s.includes("%");
  s = s.replace(/[%\s]/g, "").replace(/[^\d.,\-+eE]/g, ""); // strip currency symbols/codes

  if (s === "" || s === "-" || s === "+") return null;

  // Decide whether "," is a thousands separator or a decimal comma.
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      s = s.replace(/\./g, "").replace(",", "."); // 1.234,56
    } else {
      s = s.replace(/,/g, ""); // 1,234.56
    }
  } else if (lastComma > -1) {
    const after = s.length - lastComma - 1;
    // Exactly 3 digits after a single comma is ambiguous; treat as thousands.
    s = after === 3 ? s.replace(/,/g, "") : s.replace(",", ".");
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const signed = negative ? -n : n;
  return isPercent ? signed / 100 : signed;
}

/** Parses a date cell into ISO `yyyy-mm-dd`, or null if unrecognisable. */
export function parseDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === "") return null;

  // Already ISO, possibly with a time component.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // yyyy/mm/dd
  const slash = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (slash) return `${slash[1]}-${pad(slash[2])}-${pad(slash[3])}`;

  // dd/mm/yyyy vs mm/dd/yyyy - ambiguous. Assume mm/dd/yyyy (the format Meta,
  // Google and TikTok all use in their English exports) unless the first part
  // is clearly a day (>12).
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    const [month, day] = a > 12 ? [b, a] : [a, b];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${dmy[3]}-${pad(month)}-${pad(day)}`;
    }
  }

  // Excel serial dates leak through as plain numbers.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    const ms = Math.round((serial - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime()) && /\d{4}/.test(s)) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function pad(n: string | number): string {
  return String(n).padStart(2, "0");
}

/* -------------------------------------------------------------------------- */
/* Normalization + validation                                                 */
/* -------------------------------------------------------------------------- */

export type IssueSeverity = "error" | "warning" | "info";

export interface DataIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  /** How many rows/columns the issue affects, when countable. */
  count?: number;
}

export interface NormalizeResult {
  rows: NormalizedRow[];
  issues: DataIssue[];
  /** Base metrics that are present in at least one row with a real number. */
  availableMetrics: BaseMetric[];
  /** True when at least one row carries a usable date. */
  hasDates: boolean;
  /** The deepest entity level present in the file. */
  deepestLevel: "account" | "campaign" | "adset" | "ad";
  dateRange: { start: string; end: string } | null;
  droppedRows: number;
}

/**
 * Converts a raw table plus a column mapping into canonical rows, collecting
 * every data-quality problem worth telling the user about.
 */
export function normalizeRows(table: RawTable, mappings: ColumnMapping[]): NormalizeResult {
  const issues: DataIssue[] = [];
  const byKey = new Map<ColumnKey, number>();
  for (const m of mappings) {
    if (m.key && !byKey.has(m.key)) byKey.set(m.key, m.index);
  }

  const rows: NormalizedRow[] = [];
  const unparsableNumbers = new Map<BaseMetric, number>();
  let unparsableDates = 0;
  let droppedRows = 0;

  for (const raw of table.rows) {
    const row: NormalizedRow = { date: null, campaign: null, adset: null, ad: null, metrics: {} };

    const dateIdx = byKey.get("date");
    if (dateIdx !== undefined) {
      const cell = raw[dateIdx];
      row.date = parseDate(cell);
      if (row.date === null && String(cell ?? "").trim() !== "") unparsableDates++;
    }

    for (const dim of ["campaign", "adset", "ad"] as const) {
      const idx = byKey.get(dim);
      if (idx === undefined) continue;
      const v = String(raw[idx] ?? "").trim();
      row[dim] = v === "" ? null : v;
    }

    let hasAnyMetric = false;
    for (const metric of BASE_METRICS) {
      const idx = byKey.get(metric);
      if (idx === undefined) continue;
      const cell = raw[idx];
      const n = parseNumber(cell);
      if (n === null) {
        if (String(cell ?? "").trim() !== "") {
          unparsableNumbers.set(metric, (unparsableNumbers.get(metric) ?? 0) + 1);
        }
        row.metrics[metric] = null;
      } else {
        row.metrics[metric] = n;
        hasAnyMetric = true;
      }
    }

    // A row with no identity and no numbers carries no information.
    if (!hasAnyMetric && !row.campaign && !row.adset && !row.ad) {
      droppedRows++;
      continue;
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    issues.push({
      severity: "error",
      code: "no_usable_rows",
      message:
        "No usable rows were found. Check that the metric columns are mapped correctly and contain numbers.",
    });
  }

  // --- Structural findings -------------------------------------------------
  const hasCampaign = rows.some((r) => r.campaign !== null);
  const hasAdset = rows.some((r) => r.adset !== null);
  const hasAd = rows.some((r) => r.ad !== null);
  const deepestLevel = hasAd ? "ad" : hasAdset ? "adset" : hasCampaign ? "campaign" : "account";

  if (!hasCampaign) {
    issues.push({
      severity: "warning",
      code: "no_campaign_column",
      message:
        "No campaign column was mapped, so AdMate can only analyse account-level totals. Map a campaign column for per-campaign findings.",
    });
  }

  const availableMetrics = BASE_METRICS.filter((m) =>
    rows.some((r) => r.metrics[m] !== undefined && r.metrics[m] !== null),
  );

  if (!availableMetrics.includes("spend")) {
    issues.push({
      severity: "error",
      code: "no_spend",
      message:
        "No spend column was found. Spend is required for cost metrics (CPC, CPM, CPA, ROAS) and for prioritising issues by budget at risk.",
    });
  }
  if (!availableMetrics.includes("impressions") && !availableMetrics.includes("clicks")) {
    issues.push({
      severity: "warning",
      code: "no_delivery_metrics",
      message:
        "Neither impressions nor clicks were found. Delivery and engagement analysis will be skipped.",
    });
  }
  if (!availableMetrics.includes("conversions")) {
    issues.push({
      severity: "info",
      code: "no_conversions",
      message:
        "No conversions column was found. AdMate will analyse traffic and cost efficiency only - it will not report CPA, conversion rate or ROAS.",
    });
  }
  if (!availableMetrics.includes("revenue") && availableMetrics.includes("conversions")) {
    issues.push({
      severity: "info",
      code: "no_revenue",
      message: "No conversion value column was found, so ROAS and AOV cannot be calculated.",
    });
  }

  // --- Data quality findings ----------------------------------------------
  const hasDates = rows.some((r) => r.date !== null);
  if (unparsableDates > 0) {
    issues.push({
      severity: "warning",
      code: "unparsable_dates",
      message: `${unparsableDates} row(s) had a date value AdMate could not read. Those rows are excluded from trend and period-over-period analysis.`,
      count: unparsableDates,
    });
  }
  if (!hasDates) {
    issues.push({
      severity: "info",
      code: "no_dates",
      message:
        "No date column was mapped. AdMate will compare entities against each other instead of over time - trends and period-over-period changes are unavailable.",
    });
  }

  for (const [metric, count] of unparsableNumbers) {
    issues.push({
      severity: "warning",
      code: `unparsable_number_${metric}`,
      message: `${count} value(s) in the "${metric}" column could not be read as numbers and were treated as missing.`,
      count,
    });
  }

  const negatives = BASE_METRICS.filter((m) =>
    rows.some((r) => typeof r.metrics[m] === "number" && (r.metrics[m] as number) < 0),
  );
  if (negatives.length > 0) {
    issues.push({
      severity: "warning",
      code: "negative_values",
      message: `Negative values were found in: ${negatives.join(", ")}. These usually indicate refunds or adjustments and may distort totals.`,
    });
  }

  // Duplicate identity rows (same date + entity path) double-count on aggregate.
  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = [r.date ?? "", r.campaign ?? "", r.adset ?? "", r.ad ?? ""].join("\u0000");
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicateRows = [...seen.values()].filter((c) => c > 1).reduce((a, c) => a + c - 1, 0);
  if (duplicateRows > 0) {
    issues.push({
      severity: "warning",
      code: "duplicate_rows",
      message: `${duplicateRows} row(s) repeat the same date and campaign/ad set/ad combination. They are summed together - if your export includes a per-breakdown split (age, placement, country), totals are still correct but entity counts may look inflated.`,
      count: duplicateRows,
    });
  }

  // Clicks exceeding impressions signals a mis-mapped column.
  const impossible = rows.filter((r) => {
    const c = r.metrics.clicks;
    const i = r.metrics.impressions;
    return typeof c === "number" && typeof i === "number" && i > 0 && c > i;
  }).length;
  if (impossible > 0) {
    issues.push({
      severity: "warning",
      code: "clicks_exceed_impressions",
      message: `${impossible} row(s) report more clicks than impressions. The clicks or impressions column may be mapped to the wrong field.`,
      count: impossible,
    });
  }

  if (table.truncated) {
    issues.push({
      severity: "warning",
      code: "truncated",
      message: `The file exceeded ${MAX_ROWS.toLocaleString()} rows. Only the first ${MAX_ROWS.toLocaleString()} rows were analysed.`,
    });
  }

  const dates = rows.map((r) => r.date).filter((d): d is string => d !== null).sort();
  const dateRange = dates.length > 0 ? { start: dates[0], end: dates[dates.length - 1] } : null;

  return {
    rows,
    issues,
    availableMetrics,
    hasDates,
    deepestLevel,
    dateRange,
    droppedRows,
  };
}

export { mapColumns, detectPlatform };
export type { ColumnMapping, Platform };
