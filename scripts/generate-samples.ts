/**
 * Generates the sample reports shipped in sample-data/.
 *
 * Each file is deterministic (seeded PRNG) and contains a *planted* scenario,
 * so the detectors can be verified against a known expected outcome rather
 * than against whatever a random generator happened to produce.
 */
import fs from "node:fs";
import path from "node:path";

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260921);
const jitter = (base: number, spread = 0.15) => base * (1 + (rand() - 0.5) * 2 * spread);

function dateRange(start: string, days: number): string[] {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  for (let i = 0; i < days; i++) {
    out.push(new Date(d.getTime() + i * 86400_000).toISOString().slice(0, 10));
  }
  return out;
}

interface AdSpec {
  campaign: string;
  adset: string;
  ad: string;
  dailySpend: number;
  ctr: number;
  cpm: number;
  cvr: number;
  aov: number;
  /** Multiplier applied to CVR in the second half of the window. */
  lateCvrFactor?: number;
  lateCtrFactor?: number;
  lateCpmFactor?: number;
  /** Force zero conversions regardless of CVR. */
  neverConverts?: boolean;
  frequencyBase?: number;
}

const META_SPECS: AdSpec[] = [
  // Planted scenario 1: CPA spike driven by a conversion-rate collapse.
  { campaign: "Summer Skincare Promotion", adset: "Broad 25-44", ad: "Hero Video A", dailySpend: 120, ctr: 0.018, cpm: 9.5, cvr: 0.045, aov: 62, lateCvrFactor: 0.45, frequencyBase: 1.9 },
  { campaign: "Summer Skincare Promotion", adset: "Broad 25-44", ad: "Carousel Ingredients", dailySpend: 85, ctr: 0.014, cpm: 10.2, cvr: 0.038, aov: 58, lateCvrFactor: 0.5, frequencyBase: 2.1 },
  { campaign: "Summer Skincare Promotion", adset: "Lookalike 2%", ad: "UGC Testimonial", dailySpend: 70, ctr: 0.021, cpm: 8.8, cvr: 0.052, aov: 64, lateCvrFactor: 0.6, frequencyBase: 1.7 },

  // Planted scenario 2: creative fatigue - high frequency, CTR falling.
  { campaign: "Retargeting - Cart Abandoners", adset: "ATC 7 day", ad: "Reminder Static", dailySpend: 55, ctr: 0.031, cpm: 14.0, cvr: 0.09, aov: 71, lateCtrFactor: 0.62, frequencyBase: 4.6 },
  { campaign: "Retargeting - Cart Abandoners", adset: "ATC 7 day", ad: "Discount Code 10", dailySpend: 40, ctr: 0.028, cpm: 13.2, cvr: 0.085, aov: 68, lateCtrFactor: 0.7, frequencyBase: 4.2 },

  // Planted scenario 3: spend with zero conversions.
  { campaign: "Brand Awareness - Video Views", adset: "Interest: Wellness", ad: "Brand Film 30s", dailySpend: 65, ctr: 0.009, cpm: 6.1, cvr: 0, aov: 0, neverConverts: true, frequencyBase: 1.4 },
  { campaign: "Brand Awareness - Video Views", adset: "Interest: Wellness", ad: "Brand Film 15s", dailySpend: 45, ctr: 0.011, cpm: 5.8, cvr: 0, aov: 0, neverConverts: true, frequencyBase: 1.3 },

  // Planted scenario 4: small, efficient, room to scale.
  { campaign: "Best Sellers - Prospecting", adset: "Lookalike 1% Purchasers", ad: "Bundle Offer", dailySpend: 38, ctr: 0.026, cpm: 8.2, cvr: 0.078, aov: 88, frequencyBase: 1.5 },
];

function buildMetaCsv(): string {
  const dates = dateRange("2026-08-25", 14);
  const half = dates.length / 2;
  const header = [
    "Reporting starts",
    "Campaign name",
    "Ad set name",
    "Ad name",
    "Amount spent (USD)",
    "Impressions",
    "Reach",
    "Frequency",
    "Link clicks",
    "Results",
    "Website purchases conversion value",
  ];
  const lines = [header.join(",")];

  dates.forEach((date, dayIndex) => {
    const late = dayIndex >= half;
    for (const spec of META_SPECS) {
      const spend = jitter(spec.dailySpend, 0.18);
      const cpm = jitter(spec.cpm, 0.12) * (late && spec.lateCpmFactor ? spec.lateCpmFactor : 1);
      const impressions = Math.round((spend / cpm) * 1000);
      const ctr = jitter(spec.ctr, 0.15) * (late && spec.lateCtrFactor ? spec.lateCtrFactor : 1);
      const clicks = Math.round(impressions * ctr);
      const cvr = spec.neverConverts
        ? 0
        : jitter(spec.cvr, 0.25) * (late && spec.lateCvrFactor ? spec.lateCvrFactor : 1);
      const conversions = spec.neverConverts ? 0 : Math.round(clicks * cvr);
      const revenue = conversions * jitter(spec.aov, 0.1);
      const frequency = jitter(spec.frequencyBase ?? 1.8, 0.1) * (late ? 1.12 : 1);
      const reach = Math.max(1, Math.round(impressions / frequency));

      lines.push(
        [
          date,
          quote(spec.campaign),
          quote(spec.adset),
          quote(spec.ad),
          spend.toFixed(2),
          impressions,
          reach,
          frequency.toFixed(2),
          clicks,
          conversions,
          revenue.toFixed(2),
        ].join(","),
      );
    }
  });

  return lines.join("\n") + "\n";
}

/** Google Ads style: banner rows, "Impr.", "Cost", thousands separators. */
function buildGoogleCsv(): string {
  const dates = dateRange("2026-09-01", 10);
  const campaigns = [
    { name: "Search - Brand", adGroup: "Exact Brand", spend: 60, ctr: 0.14, cpc: 0.45, cvr: 0.21, aov: 95 },
    { name: "Search - Generic Skincare", adGroup: "Moisturiser", spend: 180, ctr: 0.048, cpc: 1.85, cvr: 0.031, aov: 72, lateCpcFactor: 1.4 },
    { name: "Performance Max - All Products", adGroup: "Asset Group 1", spend: 240, ctr: 0.021, cpc: 0.92, cvr: 0.045, aov: 84 },
    { name: "Display - Remarketing", adGroup: "Site Visitors 30d", spend: 45, ctr: 0.004, cpc: 0.38, cvr: 0.008, aov: 66 },
  ];

  const lines: string[] = [
    "Campaign performance report",
    '"Sep 1, 2026 - Sep 10, 2026"',
    "",
    ["Day", "Campaign", "Ad group", "Cost", "Impr.", "Clicks", "Conversions", "Conv. value"].join(","),
  ];

  for (const date of dates) {
    const dayIndex = dates.indexOf(date);
    const late = dayIndex >= dates.length / 2;
    for (const c of campaigns) {
      const cpc = jitter(c.cpc, 0.12) * (late && "lateCpcFactor" in c ? (c as { lateCpcFactor: number }).lateCpcFactor : 1);
      const spend = jitter(c.spend, 0.15);
      const clicks = Math.round(spend / cpc);
      const impressions = Math.round(clicks / jitter(c.ctr, 0.1));
      const conversions = Math.round(clicks * jitter(c.cvr, 0.2));
      const value = conversions * jitter(c.aov, 0.08);
      lines.push(
        [
          date,
          quote(c.name),
          quote(c.adGroup),
          `"${spend.toFixed(2)}"`,
          `"${impressions.toLocaleString("en-US")}"`,
          clicks,
          conversions,
          `"${value.toFixed(2)}"`,
        ].join(","),
      );
    }
  }
  lines.push(['"Total: all campaigns"', "", "", "", "", "", "", ""].join(","));
  return lines.join("\n") + "\n";
}

/** TikTok style: no date column, no conversion tracking - tests the honest-gaps path. */
function buildTikTokCsv(): string {
  const rows = [
    { c: "TikTok - Spark Ads Q3", g: "Broad 18-34", a: "Creator Duet A", spend: 420.5, impr: 310_000, clicks: 4200 },
    { c: "TikTok - Spark Ads Q3", g: "Broad 18-34", a: "Creator Duet B", spend: 388.2, impr: 295_400, clicks: 3110 },
    { c: "TikTok - Spark Ads Q3", g: "Interest: Beauty", a: "Tutorial 21s", spend: 512.75, impr: 402_800, clicks: 6840 },
    { c: "TikTok - Traffic Push", g: "Broad 25-44", a: "Offer Hook", spend: 264.0, impr: 188_200, clicks: 1290 },
    { c: "TikTok - Traffic Push", g: "Broad 25-44", a: "Before After", spend: 197.35, impr: 161_900, clicks: 980 },
  ];
  const lines = [
    ["Campaign name", "Ad group name", "Ad name", "Cost", "Impressions", "Clicks (destination)"].join(","),
  ];
  for (const r of rows) {
    lines.push([quote(r.c), quote(r.g), quote(r.a), r.spend.toFixed(2), r.impr, r.clicks].join(","));
  }
  return lines.join("\n") + "\n";
}

/** Deliberately messy: blanks, dashes, a duplicate row, clicks > impressions. */
function buildMessyCsv(): string {
  return [
    "Date,Campaign name,Ad set name,Amount spent,Impressions,Link clicks,Results,Conversion value",
    "2026-09-01,Test Campaign A,Set 1,120.00,45000,900,12,780.00",
    "2026-09-02,Test Campaign A,Set 1,118.50,44200,875,-,760.00",
    "2026-09-03,Test Campaign A,Set 1,,43100,860,11,701.00",
    "2026-09-04,Test Campaign A,Set 1,122.75,41900,42000,9,640.00",
    "2026-09-05,Test Campaign A,Set 1,119.20,42800,880,10,712.00",
    "2026-09-05,Test Campaign A,Set 1,119.20,42800,880,10,712.00",
    "2026-09-06,Test Campaign B,Set 2,88.00,N/A,410,0,0",
    "2026-09-07,Test Campaign B,Set 2,91.30,29500,398,0,0",
    "2026-09-08,Test Campaign B,Set 2,\"1.234,56\",30100,415,2,144.00",
    "not a date,Test Campaign B,Set 2,85.00,28900,390,1,72.00",
    "",
    "Total,,,,,,,",
    "",
  ].join("\n");
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

const outDir = path.join(process.cwd(), "sample-data");
fs.mkdirSync(outDir, { recursive: true });

const files: [string, string][] = [
  ["meta-ads-14-days.csv", buildMetaCsv()],
  ["google-ads-10-days.csv", buildGoogleCsv()],
  ["tiktok-ads-no-dates.csv", buildTikTokCsv()],
  ["messy-report-with-issues.csv", buildMessyCsv()],
];

for (const [name, content] of files) {
  fs.writeFileSync(path.join(outDir, name), content, "utf8");
  console.log(`wrote sample-data/${name} (${content.split("\n").length - 1} lines)`);
}
