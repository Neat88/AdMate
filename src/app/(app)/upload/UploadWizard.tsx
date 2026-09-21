"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { ColumnMapping } from "@/lib/analysis/columns";
import type { DataIssue } from "@/lib/analysis/parse";
import type { ColumnKey, Platform, BaseMetric } from "@/lib/analysis/types";
import { PLATFORM_LABELS, METRIC_META } from "@/lib/analysis/types";
import { Card, CardHeader, Button, Banner } from "@/components/ui/primitives";
import { formatDate } from "@/lib/format";

/**
 * The upload journey:
 *   1. Choose platform + file
 *   2. Review the proposed column mapping and correct it
 *   3. Confirm report context (currency, period, objective)
 *   4. Analyse
 *
 * The mapping step is not optional. An automatic mapping that silently puts
 * "Cost per conversion" into the spend column would produce confident,
 * completely wrong advice, so the user always sees and approves it.
 */

interface PreviewResponse {
  filename: string;
  platform: Platform;
  platformConfidence: number;
  headers: string[];
  mappings: ColumnMapping[];
  previewRows: string[][];
  totalRows: number;
  issues: DataIssue[];
  availableMetrics: BaseMetric[];
  hasDates: boolean;
  deepestLevel: string;
  dateRange: { start: string; end: string } | null;
}

const DIMENSION_OPTIONS: { value: ColumnKey | ""; label: string }[] = [
  { value: "", label: "— Ignore this column —" },
  { value: "date", label: "Date" },
  { value: "campaign", label: "Campaign name" },
  { value: "adset", label: "Ad set / ad group name" },
  { value: "ad", label: "Ad / creative name" },
];

const METRIC_OPTIONS: { value: ColumnKey; label: string }[] = (
  ["impressions", "reach", "clicks", "spend", "conversions", "revenue", "frequency", "videoViews"] as BaseMetric[]
).map((m) => ({ value: m, label: METRIC_META[m].label }));

const CURRENCIES = ["USD", "EUR", "GBP", "AUD", "CAD", "SGD", "JPY", "INR", "KHR", "THB", "VND", "PHP"];

const OBJECTIVES = [
  "Conversions / Sales",
  "Leads",
  "Traffic",
  "App installs",
  "Awareness / Reach",
  "Video views",
  "Engagement",
];

export function UploadWizard({
  workspaceId,
  workspaceCurrency,
  samples,
}: {
  workspaceId: string;
  workspaceCurrency: string;
  samples: { name: string; description: string }[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<1 | 2>(1);
  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState<Platform>("other");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [currency, setCurrency] = useState(workspaceCurrency);
  const [objective, setObjective] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const runPreview = useCallback(
    async (selected: File) => {
      setError(null);
      setBusy(true);
      try {
        const body = new FormData();
        body.append("file", selected);
        const res = await fetch("/api/upload/preview", { method: "POST", body });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "That file could not be read.");

        const result = data as PreviewResponse;
        setPreview(result);
        setMappings(result.mappings);
        setFile(selected);
        if (result.platform !== "other") setPlatform(result.platform);
        if (result.dateRange) {
          setPeriodStart(result.dateRange.start);
          setPeriodEnd(result.dateRange.end);
        }
        setStep(2);
      } catch (e) {
        setError(e instanceof Error ? e.message : "That file could not be read.");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  async function loadSample(name: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/samples/${name}`);
      if (!res.ok) throw new Error("Sample file could not be loaded.");
      const blob = await res.blob();
      await runPreview(new File([blob], name, { type: "text/csv" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sample file could not be loaded.");
      setBusy(false);
    }
  }

  async function confirm() {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("mappings", JSON.stringify(mappings));
      body.append(
        "context",
        JSON.stringify({
          workspaceId,
          platform,
          currency,
          objective: objective || null,
          periodStart: periodStart || null,
          periodEnd: periodEnd || null,
        }),
      );

      const res = await fetch("/api/upload/confirm", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "The analysis could not be completed.");

      router.push(`/reports/${data.reportId}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The analysis could not be completed.");
      setBusy(false);
    }
  }

  function setMapping(index: number, key: ColumnKey | "") {
    setMappings((current) =>
      current.map((m, i) => {
        // A canonical key can only be used once; clear it from any other column.
        if (key !== "" && m.key === key && i !== index) return { ...m, key: null, confidence: 0 };
        if (i !== index) return m;
        return { ...m, key: key === "" ? null : key, confidence: key === "" ? 0 : 1 };
      }),
    );
  }

  /* ----------------------------- Step 1: choose ---------------------------- */

  if (step === 1) {
    return (
      <div className="space-y-6">
        {error ? <Banner tone="error" title={error} /> : null}

        <Card>
          <CardHeader
            title="Upload an advertising report"
            description="CSV, TSV or Excel exports from Meta, TikTok, Google or LinkedIn Ads. Up to 10 MB."
          />
          <div className="p-5">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const dropped = e.dataTransfer.files?.[0];
                if (dropped) void runPreview(dropped);
              }}
              className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
                dragging ? "border-brand-400 bg-brand-50" : "border-ink-300 bg-ink-50/50"
              }`}
            >
              <span aria-hidden="true" className="text-3xl text-ink-400">
                ↑
              </span>
              <p className="mt-2 text-sm font-medium text-ink-900">
                Drag a report here, or choose a file
              </p>
              <p className="mt-1 text-sm text-ink-500">
                AdMate will detect the platform and map the columns for you.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.xlsx,.xls"
                className="sr-only"
                onChange={(e) => {
                  const selected = e.target.files?.[0];
                  if (selected) void runPreview(selected);
                }}
              />
              <Button
                type="button"
                className="mt-4"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                {busy ? "Reading file…" : "Choose file"}
              </Button>
              <p className="mt-3 text-xs text-ink-500">
                PDF reports are not supported yet — export as CSV or Excel instead.
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Or explore with sample data"
            description="Realistic reports with known problems planted in them, so you can see how AdMate responds before uploading your own."
          />
          <ul className="divide-y divide-ink-100">
            {samples.map((sample) => (
              <li key={sample.name} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-900">{sample.name}</p>
                  <p className="mt-0.5 text-sm text-ink-500">{sample.description}</p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void loadSample(sample.name)}
                >
                  Use this
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    );
  }

  /* -------------------------- Step 2: review & map ------------------------- */

  if (!preview) return null;

  const errors = preview.issues.filter((i) => i.severity === "error");
  const warnings = preview.issues.filter((i) => i.severity === "warning");
  const notes = preview.issues.filter((i) => i.severity === "info");
  const mappedKeys = new Set(mappings.map((m) => m.key).filter(Boolean));
  const hasSpend = mappedKeys.has("spend");

  return (
    <div className="space-y-6">
      {error ? <Banner tone="error" title={error} /> : null}

      <Card>
        <CardHeader
          title="Review the extracted data"
          description={`${preview.filename} — ${preview.totalRows.toLocaleString()} data rows, ${preview.headers.length} columns.`}
          action={
            <Button variant="ghost" size="sm" onClick={() => { setStep(1); setPreview(null); setFile(null); }}>
              Choose a different file
            </Button>
          }
        />

        <div className="space-y-3 p-5">
          {errors.length > 0 ? (
            <Banner tone="error" title="This report cannot be analysed as mapped">
              <ul className="list-disc space-y-1 pl-4">
                {errors.map((issue, i) => (
                  <li key={i}>{issue.message}</li>
                ))}
              </ul>
            </Banner>
          ) : null}

          {warnings.length > 0 ? (
            <Banner tone="warning" title={`${warnings.length} data quality warning${warnings.length === 1 ? "" : "s"}`}>
              <ul className="list-disc space-y-1 pl-4">
                {warnings.map((issue, i) => (
                  <li key={i}>{issue.message}</li>
                ))}
              </ul>
            </Banner>
          ) : null}

          {notes.length > 0 ? (
            <Banner tone="info" title="What AdMate can and cannot analyse in this file">
              <ul className="list-disc space-y-1 pl-4">
                {notes.map((issue, i) => (
                  <li key={i}>{issue.message}</li>
                ))}
              </ul>
            </Banner>
          ) : null}

          {errors.length === 0 && warnings.length === 0 && notes.length === 0 ? (
            <Banner tone="success" title="No data quality problems found." />
          ) : null}
        </div>
      </Card>

      {/* Column mapping */}
      <Card>
        <CardHeader
          title="Confirm the column mapping"
          description="AdMate matched your column names to the metrics it understands. Correct anything that looks wrong — every number in your analysis depends on this."
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-y border-ink-200 bg-ink-50 text-left">
                <th scope="col" className="px-5 py-2 text-xs font-semibold uppercase tracking-wide text-ink-600">
                  Column in your file
                </th>
                <th scope="col" className="px-5 py-2 text-xs font-semibold uppercase tracking-wide text-ink-600">
                  Sample values
                </th>
                <th scope="col" className="px-5 py-2 text-xs font-semibold uppercase tracking-wide text-ink-600">
                  Maps to
                </th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((mapping, index) => (
                <tr key={mapping.index} className="border-b border-ink-100 last:border-0">
                  <td className="px-5 py-2.5">
                    <p className="font-medium text-ink-900">{mapping.header}</p>
                    {mapping.key && mapping.confidence < 0.9 ? (
                      <p className="mt-0.5 text-xs text-med-700">
                        ◆ Lower-confidence match — please check
                      </p>
                    ) : null}
                  </td>
                  <td className="max-w-[240px] px-5 py-2.5 text-ink-500">
                    <span className="block truncate tnum" title={mapping.samples.join(", ")}>
                      {mapping.samples.join(", ") || "—"}
                    </span>
                  </td>
                  <td className="px-5 py-2.5">
                    <label className="sr-only" htmlFor={`map-${index}`}>
                      Map {mapping.header} to
                    </label>
                    <select
                      id={`map-${index}`}
                      value={mapping.key ?? ""}
                      onChange={(e) => setMapping(index, e.target.value as ColumnKey | "")}
                      className={`w-full max-w-[260px] rounded-lg border px-2.5 py-1.5 text-sm ${
                        mapping.key ? "border-ink-300 text-ink-900" : "border-ink-200 text-ink-500"
                      }`}
                    >
                      {DIMENSION_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                      <optgroup label="Metrics">
                        {METRIC_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!hasSpend ? (
          <div className="border-t border-ink-200 p-5">
            <Banner tone="warning" title="No spend column is mapped">
              Without spend, AdMate cannot calculate CPC, CPM, CPA or ROAS, and cannot rank issues by
              budget at risk.
            </Banner>
          </div>
        ) : null}
      </Card>

      {/* Data preview */}
      <Card>
        <CardHeader
          title="Data preview"
          description={`First ${Math.min(preview.previewRows.length, 20)} rows, exactly as AdMate read them.`}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-y border-ink-200 bg-ink-50">
                {preview.headers.map((header, i) => {
                  const mapped = mappings[i]?.key;
                  return (
                    <th
                      key={i}
                      scope="col"
                      className="whitespace-nowrap px-3 py-2 text-left font-semibold text-ink-700"
                    >
                      {header}
                      <span className={`mt-0.5 block font-normal ${mapped ? "text-brand-600" : "text-ink-400"}`}>
                        {mapped ? `→ ${labelFor(mapped)}` : "ignored"}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {preview.previewRows.map((row, i) => (
                <tr key={i} className="border-b border-ink-100 last:border-0">
                  {preview.headers.map((_, j) => (
                    <td key={j} className="whitespace-nowrap px-3 py-1.5 text-ink-600 tnum">
                      {row[j] === "" ? <span className="text-ink-300">empty</span> : row[j]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Report context */}
      <Card>
        <CardHeader
          title="Report details"
          description="AdMate filled in what it could read from the file. Correct anything it got wrong — currency and objective change how results are interpreted."
        />
        <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Platform" hint={preview.platformConfidence > 0 ? "Detected from the column names." : "Could not be detected."}>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as Platform)}
              className="w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm"
            >
              {(Object.keys(PLATFORM_LABELS) as Platform[]).map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Currency" hint="Used for every money figure shown.">
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm"
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Reporting period"
            hint={
              preview.dateRange
                ? `Read from the file: ${formatDate(preview.dateRange.start)} – ${formatDate(preview.dateRange.end)}`
                : "No dates in this file — enter the period if you know it."
            }
          >
            <div className="flex gap-1.5">
              <input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                aria-label="Period start"
                className="w-full rounded-lg border border-ink-300 px-2 py-1.5 text-sm"
              />
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                aria-label="Period end"
                className="w-full rounded-lg border border-ink-300 px-2 py-1.5 text-sm"
              />
            </div>
          </Field>

          <Field label="Campaign objective" hint="Optional. Helps the analysis judge the right metrics.">
            <select
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              className="w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm"
            >
              <option value="">Not specified</option>
              {OBJECTIVES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-200 px-5 py-4">
          <p className="text-sm text-ink-500">
            {errors.length > 0
              ? "Fix the mapping above before analysing."
              : "AdMate will calculate your metrics, then explain what it finds."}
          </p>
          <Button onClick={() => void confirm()} disabled={busy || errors.length > 0}>
            {busy ? "Analysing…" : "Confirm and analyse"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function labelFor(key: ColumnKey): string {
  const dimension = DIMENSION_OPTIONS.find((o) => o.value === key);
  if (dimension) return dimension.label;
  return METRIC_META[key as BaseMetric]?.label ?? key;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1 text-sm font-medium text-ink-700">{label}</p>
      {children}
      {hint ? <p className="mt-1 text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}
