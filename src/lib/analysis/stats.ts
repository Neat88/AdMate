/**
 * Small-sample statistics for the detectors.
 *
 * The question every detector has to answer before it raises its voice is
 * "could this have happened by chance?". A CPA that moves from 3 conversions
 * to 1 is a 200% increase and means almost nothing; the same move from 300 to
 * 100 means a great deal. These helpers turn counts into that judgement using
 * textbook tests (Poisson and binomial), with no external dependencies.
 *
 * All p-values here are one-sided: detectors already know which direction
 * they are testing.
 */

/** How strongly the data supports a detected change. */
export type EvidenceStrength = "strong" | "moderate" | "weak";

export interface SignificanceResult {
  /** One-sided p-value; null when the test could not be run. */
  pValue: number | null;
  strength: EvidenceStrength;
  /** Plain-language description of the test, for the "why am I seeing this" trace. */
  description: string;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7). */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function logFactorial(n: number): number {
  // Exact sum for small n, Stirling for large - both well inside the precision we need.
  if (n < 100) {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  }
  return n * Math.log(n) - n + 0.5 * Math.log(2 * Math.PI * n) + 1 / (12 * n);
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomialCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  if (n > 2000) {
    // Normal approximation with continuity correction.
    const mean = n * p;
    const sd = Math.sqrt(n * p * (1 - p));
    return normalCdf((k + 0.5 - mean) / sd);
  }
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  const lfn = logFactorial(n);
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += Math.exp(lfn - logFactorial(i) - logFactorial(n - i) + i * logP + (n - i) * logQ);
  }
  return Math.min(1, sum);
}

/** Probability of observing zero events when `expected` are expected (Poisson). */
export function poissonZeroProbability(expected: number): number {
  if (!Number.isFinite(expected) || expected <= 0) return 1;
  return Math.exp(-expected);
}

export function strengthFor(pValue: number | null): EvidenceStrength {
  if (pValue === null) return "weak";
  if (pValue < 0.05) return "strong";
  if (pValue < 0.2) return "moderate";
  return "weak";
}

/**
 * Tests whether an event rate *fell* between two periods, where the rate is
 * events per unit of exposure (conversions per dollar, clicks per impression,
 * conversions per click...).
 *
 * Conditional on the total number of events, the count in the current period
 * is Binomial(total, share of exposure in the current period) under the null
 * hypothesis of an unchanged rate. That is the exact conditional test for two
 * Poisson rates and it behaves sensibly at tiny counts, which a z-test does not.
 */
export function rateDecreaseTest(
  previousEvents: number,
  previousExposure: number,
  currentEvents: number,
  currentExposure: number,
  eventLabel: string,
): SignificanceResult {
  const total = previousEvents + currentEvents;
  const exposure = previousExposure + currentExposure;
  if (!(exposure > 0) || previousExposure <= 0 || currentExposure <= 0 || total <= 0) {
    return { pValue: null, strength: "weak", description: `Not enough ${eventLabel} to test the change.` };
  }
  const share = currentExposure / exposure;
  const p = binomialCdf(Math.round(currentEvents), Math.round(total), share);
  return {
    pValue: p,
    strength: strengthFor(p),
    description: `Chance of a drop this large in ${eventLabel} if nothing had really changed: ${formatP(p)} (based on ${fmtCount(total)} ${eventLabel} across both periods).`,
  };
}

/** Mirror image of rateDecreaseTest, for improvements. */
export function rateIncreaseTest(
  previousEvents: number,
  previousExposure: number,
  currentEvents: number,
  currentExposure: number,
  eventLabel: string,
): SignificanceResult {
  const total = previousEvents + currentEvents;
  const exposure = previousExposure + currentExposure;
  if (!(exposure > 0) || previousExposure <= 0 || currentExposure <= 0 || total <= 0) {
    return { pValue: null, strength: "weak", description: `Not enough ${eventLabel} to test the change.` };
  }
  const share = currentExposure / exposure;
  const p = 1 - binomialCdf(Math.round(currentEvents) - 1, Math.round(total), share);
  return {
    pValue: p,
    strength: strengthFor(p),
    description: `Chance of a rise this large in ${eventLabel} if nothing had really changed: ${formatP(p)} (based on ${fmtCount(total)} ${eventLabel} across both periods).`,
  };
}

/**
 * Is zero conversions surprising? Uses the account's own conversion rate to
 * work out how many conversions this much traffic would normally produce.
 * Returns how much more traffic would be needed before zero *would* be
 * conclusive, which is what turns "wait for data" into a concrete instruction.
 */
export function zeroEventsTest(
  exposure: number,
  baselineRate: number,
  exposureLabel: string,
  eventLabel: string,
): SignificanceResult & { expected: number; exposureNeeded: number | null } {
  if (!(baselineRate > 0) || !(exposure >= 0)) {
    return {
      pValue: null,
      strength: "weak",
      description: `No baseline ${eventLabel} rate is available to judge whether zero ${eventLabel} is unusual.`,
      expected: 0,
      exposureNeeded: null,
    };
  }
  const expected = exposure * baselineRate;
  const p = poissonZeroProbability(expected);
  // Exposure at which zero events would have < 5% probability: -ln(0.05) = 3.0.
  const needed = Math.max(0, Math.ceil(3 / baselineRate - exposure));
  return {
    pValue: p,
    strength: strengthFor(p),
    description: `At the account's usual rate, ${fmtCount(exposure)} ${exposureLabel} would be expected to produce about ${expected.toFixed(1)} ${eventLabel}. The chance of seeing none by luck alone is ${formatP(p)}.`,
    expected,
    exposureNeeded: needed > 0 ? needed : null,
  };
}

export function formatP(p: number): string {
  if (p < 0.001) return "under 0.1%";
  if (p < 0.01) return `${(p * 100).toFixed(1)}%`;
  return `${Math.round(p * 100)}%`;
}

function fmtCount(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

/** P(X <= k) for X ~ Poisson(lambda). */
export function poissonCdf(k: number, lambda: number): number {
  if (k < 0) return 0;
  if (!(lambda > 0)) return 1;
  if (lambda > 500) {
    return normalCdf((k + 0.5 - lambda) / Math.sqrt(lambda));
  }
  let term = Math.exp(-lambda);
  let sum = term;
  for (let i = 1; i <= Math.floor(k); i++) {
    term *= lambda / i;
    sum += term;
  }
  return Math.min(1, sum);
}

/**
 * Is an entity's observed event count significantly *below* what the
 * benchmark rate predicts for its exposure? (e.g. conversions below what its
 * spend would buy at the account's CPA.)
 */
export function belowBenchmarkTest(observed: number, expected: number, eventLabel: string): SignificanceResult {
  if (!(expected > 0)) {
    return { pValue: null, strength: "weak", description: `No benchmark ${eventLabel} rate to compare against.` };
  }
  const p = poissonCdf(Math.round(observed), expected);
  return {
    pValue: p,
    strength: strengthFor(p),
    description: `At the benchmark rate this entity would be expected to record about ${expected.toFixed(1)} ${eventLabel}; it recorded ${Math.round(observed)}. Chance of a shortfall this large by luck alone: ${formatP(p)}.`,
  };
}

/** Mirror of belowBenchmarkTest, for entities doing better than the benchmark. */
export function aboveBenchmarkTest(observed: number, expected: number, eventLabel: string): SignificanceResult {
  if (!(expected > 0)) {
    return { pValue: null, strength: "weak", description: `No benchmark ${eventLabel} rate to compare against.` };
  }
  const p = 1 - poissonCdf(Math.round(observed) - 1, expected);
  return {
    pValue: p,
    strength: strengthFor(p),
    description: `At the benchmark rate this entity would be expected to record about ${expected.toFixed(1)} ${eventLabel}; it recorded ${Math.round(observed)}. Chance of doing this well by luck alone: ${formatP(p)}.`,
  };
}
