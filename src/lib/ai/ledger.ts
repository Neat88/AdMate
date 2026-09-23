/**
 * The number ledger: every figure the model is allowed to cite.
 *
 * Anything AdMate hands the model - evidence values, comparisons, changes,
 * deterministic sentences it already shows the user - is registered here in
 * all the ways it might plausibly be written (22.26, 22.3, 22, 2226 for a
 * percentage stored as 22.26...). Model output is then scanned for numbers,
 * and any figure the ledger cannot account for rejects the text.
 *
 * What is deliberately allowed without being in the ledger:
 *   - small whole numbers (<= 31) written without a % or currency symbol:
 *     "the next 7 days", "the top 3 ads", "step 2" are structure, not claims;
 *   - a handful of guidance percentages (10, 15, 20, 25, 30, 50), because
 *     "raise budget 20-30% at a time" is advice, not a measurement;
 *   - ISO dates, which are stripped before scanning.
 * Everything else - any decimal, any currency amount, any other percentage -
 * must be in the ledger.
 */

const GUIDANCE_PERCENTS = new Set([10, 15, 20, 25, 30, 50]);

export class NumberLedger {
  private values: number[] = [];

  add(n: number | null | undefined): void {
    if (n === null || n === undefined || !Number.isFinite(n)) return;
    const variants = [n, Math.abs(n), n * 100, Math.abs(n * 100), n * 1000];
    for (const v of variants) this.values.push(v);
  }

  addAll(ns: (number | null | undefined)[]): void {
    for (const n of ns) this.add(n);
  }

  /** Registers every number that appears in a deterministic sentence AdMate itself wrote. */
  addText(text: string | null | undefined): void {
    if (!text) return;
    for (const token of scanNumbers(text)) this.values.push(token.value);
  }

  has(value: number): boolean {
    for (const a of this.values) {
      if (a === value) return true;
      if (a === 0) continue;
      if (Math.abs(a - value) / Math.abs(a) < 0.02) return true;
      // Rounded to a whole number ("$10.77" written as "$11").
      if (Number.isInteger(value) && Math.abs(a) >= 1 && Math.round(a) === value) return true;
    }
    return false;
  }

  /** Returns the figures in `text` that the ledger cannot account for. */
  unverified(text: string): string[] {
    const bad: string[] = [];
    for (const token of scanNumbers(text)) {
      if (this.has(token.value)) continue;
      if (!token.currency && !token.percent && Number.isInteger(token.value) && token.value <= 31) continue;
      if (token.percent && GUIDANCE_PERCENTS.has(token.value)) continue;
      bad.push(token.raw);
    }
    return bad;
  }

  get size(): number {
    return this.values.length;
  }
}

interface NumberToken {
  raw: string;
  value: number;
  currency: boolean;
  percent: boolean;
}

export function scanNumbers(text: string): NumberToken[] {
  const cleaned = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    // Ranges like "20-30%": the first number inherits the unit.
    .replace(/(\d+)\s*[-–]\s*(\d+)\s*%/g, "$1% $2%");
  const out: NumberToken[] = [];
  const re = /([$€£¥₹])?(\d[\d,]*(?:\.\d+)?)(\s*%|x\b|\s*(?:times))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const raw = m[0].trim();
    const value = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    out.push({
      raw,
      value,
      currency: Boolean(m[1]),
      percent: Boolean(m[3] && m[3].includes("%")),
    });
  }
  return out;
}
