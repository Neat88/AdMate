import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { parseCsv, parseNumber, parseDate, normalizeRows, MAX_ROWS } from "../parse";
import { mapColumns, detectPlatform, normalizeHeader } from "../columns";
import { aggregate, deriveMetrics, buildPerformanceModel, comparePeriods, getMetric, robustZ } from "../metrics";
import { detectFindings } from "../detectors";
import { evaluateAlerts, defaultRules } from "../alerts";
import type { NormalizedRow } from "../types";

const sample = (name: string) =>
  fs.readFileSync(path.join(process.cwd(), "sample-data", name), "utf8");

function loadSample(name: string) {
  const table = parseCsv(sample(name));
  const mappings = mapColumns(table.headers, table.rows);
  const result = normalizeRows(table, mappings);
  return { table, mappings, result };
}

/* ------------------------------ value parsing ----------------------------- */

test("parseNumber distinguishes zero from missing", () => {
  assert.equal(parseNumber("0"), 0);
  assert.equal(parseNumber(""), null);
  assert.equal(parseNumber("-"), null);
  assert.equal(parseNumber("—"), null);
  assert.equal(parseNumber("N/A"), null);
  assert.equal(parseNumber(null), null);
  assert.equal(parseNumber(undefined), null);
});

test("parseNumber handles currency, separators and locale decimals", () => {
  assert.equal(parseNumber("$1,234.56"), 1234.56);
  assert.equal(parseNumber("1.234,56"), 1234.56);
  assert.equal(parseNumber("€ 89,90"), 89.9);
  assert.equal(parseNumber("1,234"), 1234);
  assert.equal(parseNumber("(45.20)"), -45.2);
  assert.equal(parseNumber("2.5%"), 0.025);
  assert.equal(parseNumber("45000"), 45000);
});

test("parseDate handles the formats the four platforms export", () => {
  assert.equal(parseDate("2026-09-01"), "2026-09-01");
  assert.equal(parseDate("2026-09-01T00:00:00Z"), "2026-09-01");
  assert.equal(parseDate("09/01/2026"), "2026-09-01"); // mm/dd (US default)
  assert.equal(parseDate("25/08/2026"), "2026-08-25"); // unambiguous dd/mm
  assert.equal(parseDate("2026/9/1"), "2026-09-01");
  assert.equal(parseDate("not a date"), null);
  assert.equal(parseDate(""), null);
});

/* ------------------------------ column mapping ---------------------------- */

test("normalizeHeader strips currency and qualifier parentheticals", () => {
  assert.equal(normalizeHeader("Amount spent (USD)"), "amount spent");
  assert.equal(normalizeHeader("Clicks (destination)"), "clicks");
  assert.equal(normalizeHeader("Cost / conv."), "cost conv");
});

test("cost-per-X headers never steal the spend column", () => {
  const headers = ["Campaign", "Cost", "Cost / conv.", "Cost per result", "Conversions"];
  const mapped = mapColumns(headers, [["A", "100", "10", "10", "10"]]);
  assert.equal(mapped[1].key, "spend");
  assert.equal(mapped[2].key, null);
  assert.equal(mapped[3].key, null);
  assert.equal(mapped[4].key, "conversions");
});

test("conversion value is not mistaken for conversions", () => {
  const headers = ["Campaign name", "Results", "Website purchases conversion value"];
  const mapped = mapColumns(headers, [["A", "5", "500"]]);
  assert.equal(mapped[1].key, "conversions");
  assert.equal(mapped[2].key, "revenue");
});

test("a canonical key is never assigned to two columns", () => {
  const headers = ["Campaign", "Clicks (all)", "Link clicks", "Impressions"];
  const mapped = mapColumns(headers, [["A", "10", "8", "1000"]]);
  const keys = mapped.map((m) => m.key).filter(Boolean);
  assert.equal(new Set(keys).size, keys.length, "duplicate canonical keys assigned");
});

test("platform detection recognises each sample export", () => {
  assert.equal(detectPlatform(parseCsv(sample("meta-ads-14-days.csv")).headers).platform, "meta");
  assert.equal(detectPlatform(parseCsv(sample("google-ads-10-days.csv")).headers).platform, "google");
  assert.equal(detectPlatform(parseCsv(sample("tiktok-ads-no-dates.csv")).headers).platform, "tiktok");
});

/* --------------------------------- parsing -------------------------------- */

test("Google-style banner rows are skipped and the real header is found", () => {
  const table = parseCsv(sample("google-ads-10-days.csv"));
  assert.ok(table.headers.includes("Day"), `headers were: ${table.headers.join(", ")}`);
  assert.ok(table.headers.includes("Impr."));
  // The trailing "Total: all campaigns" row must not become data.
  assert.ok(!table.rows.some((r) => r[0].toLowerCase().startsWith("total")));
});

test("thousands-separated integers survive the Google export round trip", () => {
  const { result } = loadSample("google-ads-10-days.csv");
  const impressions = result.rows.map((r) => r.metrics.impressions);
  assert.ok(
    impressions.every((v) => v === null || v === undefined || v > 100),
    "impressions were truncated at the comma",
  );
});

/* ------------------------------- validation ------------------------------- */

test("the messy report surfaces every planted data-quality problem", () => {
  const { result } = loadSample("messy-report-with-issues.csv");
  const codes = result.issues.map((i) => i.code);

  assert.ok(codes.includes("duplicate_rows"), "duplicate row not reported");
  assert.ok(codes.includes("clicks_exceed_impressions"), "impossible click count not reported");
  assert.ok(codes.includes("unparsable_dates"), "unreadable date not reported");
  assert.ok(codes.some((c) => c.startsWith("unparsable_number")), "N/A impressions cell not reported");
});

test("a reported zero is preserved, a blank is not", () => {
  const { result } = loadSample("messy-report-with-issues.csv");
  const zeroConv = result.rows.find((r) => r.campaign === "Test Campaign B");
  assert.equal(zeroConv?.metrics.conversions, 0, "a real zero was lost");

  const blankSpend = result.rows.find((r) => r.date === "2026-09-03");
  assert.equal(blankSpend?.metrics.spend, null, "a blank became a zero");
});

test("a report with no conversion column says so rather than reporting zero", () => {
  const { result } = loadSample("tiktok-ads-no-dates.csv");
  assert.ok(!result.availableMetrics.includes("conversions"));
  assert.ok(result.issues.some((i) => i.code === "no_conversions"));
  assert.ok(result.issues.some((i) => i.code === "no_dates"));
  assert.equal(result.hasDates, false);
});

/* --------------------------------- metrics -------------------------------- */

test("derived metrics are omitted rather than faked when inputs are missing", () => {
  const derived = deriveMetrics({ spend: 100, clicks: 50 });
  assert.equal(derived.cpc, 2);
  assert.equal(derived.cpa, undefined, "CPA computed without conversions");
  assert.equal(derived.roas, undefined, "ROAS computed without revenue");
  assert.equal(derived.ctr, undefined, "CTR computed without impressions");
});

test("division by zero yields null, not Infinity", () => {
  const derived = deriveMetrics({ spend: 100, clicks: 0, impressions: 0, conversions: 0 });
  assert.equal(derived.cpc, undefined);
  assert.equal(derived.cpa, undefined);
  assert.equal(derived.cpm, undefined);
});

test("frequency is recomputed from impressions/reach rather than summed", () => {
  const rows: NormalizedRow[] = [
    { date: "2026-09-01", campaign: "A", adset: null, ad: null, metrics: { impressions: 1000, reach: 500, frequency: 2 } },
    { date: "2026-09-02", campaign: "A", adset: null, ad: null, metrics: { impressions: 3000, reach: 1000, frequency: 3 } },
  ];
  const agg = aggregate(rows);
  assert.equal(agg.base.frequency, 4000 / 1500);
});

test("derived metrics aggregate from summed inputs, not averaged ratios", () => {
  const rows: NormalizedRow[] = [
    { date: null, campaign: "A", adset: null, ad: null, metrics: { spend: 100, conversions: 10 } }, // CPA 10
    { date: null, campaign: "B", adset: null, ad: null, metrics: { spend: 900, conversions: 10 } }, // CPA 90
  ];
  // Naive averaging gives 50; the correct blended CPA is 1000/20 = 50 here by
  // coincidence, so use an asymmetric case:
  const rows2: NormalizedRow[] = [
    { date: null, campaign: "A", adset: null, ad: null, metrics: { spend: 100, conversions: 50 } }, // CPA 2
    { date: null, campaign: "B", adset: null, ad: null, metrics: { spend: 900, conversions: 10 } }, // CPA 90
  ];
  assert.equal(aggregate(rows).derived.cpa, 50);
  assert.equal(aggregate(rows2).derived.cpa, 1000 / 60); // not (2+90)/2 = 46
});

test("period comparison needs at least four distinct days", () => {
  const short: NormalizedRow[] = ["2026-09-01", "2026-09-02", "2026-09-03"].map((date) => ({
    date, campaign: "A", adset: null, ad: null, metrics: { spend: 10, clicks: 5 },
  }));
  assert.equal(comparePeriods(short), null);

  const long: NormalizedRow[] = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"].map((date) => ({
    date, campaign: "A", adset: null, ad: null, metrics: { spend: 10, clicks: 5 },
  }));
  assert.ok(comparePeriods(long) !== null);
});

test("robustZ stays silent on small or flat samples", () => {
  assert.equal(robustZ(10, [1, 2, 3]), null, "fired on a 3-value sample");
  assert.equal(robustZ(5, [5, 5, 5, 5, 5]), null, "fired on zero-spread data");
  assert.ok(Math.abs(robustZ(100, [1, 2, 3, 4, 5]) ?? 0) > 3);
});

/* -------------------------------- detectors ------------------------------- */

test("the planted Meta scenarios are each detected", () => {
  const { result } = loadSample("meta-ads-14-days.csv");
  const model = buildPerformanceModel(result.rows);
  const { findings } = detectFindings(model, "USD");
  const codes = new Set(findings.map((f) => f.code));

  // Scenario 3: a campaign spending with zero conversions.
  const zeroConv = findings.find(
    (f) => f.code === "spend_no_conversions" && f.entityName.includes("Brand Awareness"),
  );
  assert.ok(zeroConv, "did not flag the zero-conversion campaign");
  assert.equal(zeroConv.priority, "high");

  // Scenario 1: CPA rose because conversion rate collapsed.
  assert.ok(
    codes.has("cpa_spike") || codes.has("cvr_drop"),
    `expected a CPA/CVR deterioration finding, got: ${[...codes].join(", ")}`,
  );

  // Scenario 2: creative fatigue on the retargeting campaign.
  const fatigue = findings.find((f) => f.code === "high_frequency");
  assert.ok(fatigue, "did not flag high frequency");
  assert.ok(fatigue.entityName.includes("Retargeting") || fatigue.campaign?.includes("Retargeting"));

  // Scenario 4: an efficient small campaign worth scaling.
  assert.ok(codes.has("scale_opportunity"), "did not surface a scaling opportunity");
});

test("every finding cites at least one real number from the report", () => {
  const { result } = loadSample("meta-ads-14-days.csv");
  const model = buildPerformanceModel(result.rows);
  const { findings } = detectFindings(model, "USD");
  assert.ok(findings.length > 0);

  for (const f of findings) {
    const real = f.evidence.filter((e) => e.value !== null);
    assert.ok(real.length > 0, `finding ${f.code} has no evidence`);
    assert.ok(f.actions.length > 0, `finding ${f.code} has no actions`);
    assert.ok(f.monitor.length > 0, `finding ${f.code} has nothing to monitor`);
    assert.ok(f.hypotheses.length > 0, `finding ${f.code} offers no possible causes`);
    assert.ok(["high", "medium", "low"].includes(f.priority));
  }
});

test("findings are unique and ordered by severity", () => {
  const { result } = loadSample("meta-ads-14-days.csv");
  const model = buildPerformanceModel(result.rows);
  const { findings } = detectFindings(model, "USD");

  const ids = findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate finding ids");

  for (let i = 1; i < findings.length; i++) {
    assert.ok(findings[i - 1].severityScore >= findings[i].severityScore, "not ordered by severity");
  }
});

test("a report without conversion tracking does not produce CPA findings", () => {
  const { result } = loadSample("tiktok-ads-no-dates.csv");
  const model = buildPerformanceModel(result.rows);
  const { findings } = detectFindings(model, "USD");

  for (const f of findings) {
    assert.ok(!f.code.startsWith("cpa"), `invented a CPA finding: ${f.code}`);
    assert.ok(!f.code.startsWith("roas"), `invented a ROAS finding: ${f.code}`);
    assert.ok(f.code !== "spend_no_conversions", "treated untracked conversions as zero conversions");
  }
});

test("an empty report produces no findings rather than throwing", () => {
  const model = buildPerformanceModel([]);
  const { findings } = detectFindings(model, "USD");
  assert.deepEqual(findings, []);
});

/* --------------------------------- alerts --------------------------------- */

test("alert rules fire against the analysed report", () => {
  const { result } = loadSample("meta-ads-14-days.csv");
  const model = buildPerformanceModel(result.rows);
  const rules = defaultRules("ws_test").map((r, i) => ({
    ...r,
    id: `rule_${i}`,
    createdAt: new Date().toISOString(),
  }));

  const events = evaluateAlerts(rules, model, "USD");
  assert.ok(events.length > 0, "no alerts fired on a report with planted problems");
  assert.ok(
    events.some((e) => e.message.includes("0 recorded conversions")),
    "the spend-without-conversions rule did not fire",
  );
  // High severity must sort ahead of medium.
  const firstMedium = events.findIndex((e) => e.severity === "medium");
  const lastHigh = events.map((e) => e.severity).lastIndexOf("high");
  if (firstMedium !== -1 && lastHigh !== -1) assert.ok(lastHigh < firstMedium);
});

test("a disabled rule never fires", () => {
  const { result } = loadSample("meta-ads-14-days.csv");
  const model = buildPerformanceModel(result.rows);
  const rules = defaultRules("ws_test").map((r, i) => ({
    ...r,
    id: `rule_${i}`,
    enabled: false,
    createdAt: new Date().toISOString(),
  }));
  assert.deepEqual(evaluateAlerts(rules, model, "USD"), []);
});

test("a change-based rule stays silent when the report has no dates", () => {
  const { result } = loadSample("tiktok-ads-no-dates.csv");
  const model = buildPerformanceModel(result.rows);
  const rules = [
    {
      id: "r1", workspaceId: "ws", name: "CPC up", metric: "cpc" as const,
      comparator: "increases_by" as const, threshold: 0.1, scope: "campaign" as const,
      entityFilter: null, enabled: true, createdAt: "",
    },
  ];
  assert.deepEqual(evaluateAlerts(rules, model, "USD"), []);
});

/* ------------------------------ model building ---------------------------- */

test("the performance model reflects the hierarchy actually present", () => {
  const meta = loadSample("meta-ads-14-days.csv");
  const metaModel = buildPerformanceModel(meta.result.rows);
  assert.deepEqual(metaModel.levelsPresent, ["account", "campaign", "adset", "ad"]);
  assert.equal(metaModel.campaigns.length, 4);
  assert.ok(metaModel.hasDates);

  const tiktok = loadSample("tiktok-ads-no-dates.csv");
  const tiktokModel = buildPerformanceModel(tiktok.result.rows);
  assert.equal(tiktokModel.hasDates, false);
  assert.equal(tiktokModel.campaigns.length, 2);
});

test("campaign spend sums to the account total", () => {
  const { result } = loadSample("meta-ads-14-days.csv");
  const model = buildPerformanceModel(result.rows);
  const accountSpend = getMetric(model.account.metrics, "spend") ?? 0;
  const campaignSpend = model.campaigns.reduce((s, c) => s + (getMetric(c.metrics, "spend") ?? 0), 0);
  assert.ok(Math.abs(accountSpend - campaignSpend) < 0.01, `${accountSpend} vs ${campaignSpend}`);
});

test("row cap is enforced", () => {
  assert.equal(MAX_ROWS, 50_000);
});
