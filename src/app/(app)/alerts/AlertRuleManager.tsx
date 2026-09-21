"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AlertRule, AlertComparator, AlertScope } from "@/lib/analysis/alerts";
import { describeRule } from "@/lib/analysis/alerts";
import type { MetricKey } from "@/lib/analysis/types";
import { METRIC_META } from "@/lib/analysis/types";
import { Card, CardHeader, Button, Banner } from "@/components/ui/primitives";

const MONITORABLE: MetricKey[] = ["cpa", "roas", "ctr", "cpc", "cpm", "cvr", "spend", "frequency", "conversions"];

const COMPARATORS: { value: AlertComparator; label: string; needsDates: boolean }[] = [
  { value: "increases_by", label: "increases by more than", needsDates: true },
  { value: "decreases_by", label: "decreases by more than", needsDates: true },
  { value: "above", label: "rises above", needsDates: false },
  { value: "below", label: "falls below", needsDates: false },
  { value: "spend_without_conversions", label: "spends with zero conversions above", needsDates: false },
];

const SCOPES: { value: AlertScope; label: string }[] = [
  { value: "account", label: "the whole account" },
  { value: "campaign", label: "any campaign" },
  { value: "adset", label: "any ad set / ad group" },
  { value: "ad", label: "any ad" },
];

/**
 * Alert rule builder.
 *
 * Kept to one sentence — metric, comparator, threshold, scope — rather than a
 * general rule engine. Competitors that expose AND/OR condition trees are more
 * powerful; this is deliberately the version a marketer can set up in ten
 * seconds without reading documentation.
 */
export function AlertRuleManager({
  rules,
  workspaceId,
  currency,
}: {
  rules: AlertRule[];
  workspaceId: string;
  currency: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [metric, setMetric] = useState<MetricKey>("cpa");
  const [comparator, setComparator] = useState<AlertComparator>("increases_by");
  const [threshold, setThreshold] = useState("20");
  const [scope, setScope] = useState<AlertScope>("campaign");
  const [entityFilter, setEntityFilter] = useState("");
  const [name, setName] = useState("");

  const isPercentThreshold = comparator === "increases_by" || comparator === "decreases_by";

  async function call(input: RequestInit & { url: string }) {
    setError(null);
    setBusy(true);
    try {
      const { url, ...init } = input;
      const res = await fetch(url, init);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "That did not work.");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const numeric = Number(threshold);
    if (!Number.isFinite(numeric) || numeric < 0) {
      setError("Enter a threshold of zero or more.");
      return;
    }

    await call({
      url: "/api/alerts/rules",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId,
        name: name.trim() || defaultName(metric, comparator, numeric),
        metric: comparator === "spend_without_conversions" ? "spend" : metric,
        comparator,
        // Percentage thresholds are stored as fractions.
        threshold: isPercentThreshold ? numeric / 100 : numeric,
        scope,
        entityFilter: entityFilter.trim() || null,
      }),
    });
    setShowForm(false);
    setName("");
    setEntityFilter("");
  }

  return (
    <Card>
      <CardHeader
        title="What AdMate watches for you"
        description="Rules are evaluated each time you upload and analyse a report. AdMate has no live platform connection, so this is not real-time monitoring."
        action={
          <Button size="sm" variant={showForm ? "ghost" : "secondary"} onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Cancel" : "New rule"}
          </Button>
        }
      />

      {error ? (
        <div className="px-5 pt-4">
          <Banner tone="error" title={error} />
        </div>
      ) : null}

      {showForm ? (
        <form onSubmit={create} className="space-y-4 border-b border-ink-200 bg-ink-50/50 p-5">
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <span className="pb-2 text-ink-600">Alert me when</span>

            <Labelled label="Scope">
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as AlertScope)}
                className="rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm"
              >
                {SCOPES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Labelled>

            {comparator !== "spend_without_conversions" ? (
              <Labelled label="Metric">
                <select
                  value={metric}
                  onChange={(e) => setMetric(e.target.value as MetricKey)}
                  className="rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm"
                >
                  {MONITORABLE.map((m) => (
                    <option key={m} value={m}>
                      {METRIC_META[m].label}
                    </option>
                  ))}
                </select>
              </Labelled>
            ) : null}

            <Labelled label="Condition">
              <select
                value={comparator}
                onChange={(e) => setComparator(e.target.value as AlertComparator)}
                className="rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm"
              >
                {COMPARATORS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Labelled>

            <Labelled label={isPercentThreshold ? "Percent" : `Value (${currency})`}>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  className="w-24 rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm tnum"
                />
                {isPercentThreshold ? <span className="text-ink-500">%</span> : null}
              </div>
            </Labelled>
          </div>

          <div className="flex flex-wrap gap-3">
            <Labelled label="Only names containing (optional)">
              <input
                type="text"
                value={entityFilter}
                onChange={(e) => setEntityFilter(e.target.value)}
                placeholder="e.g. Retargeting"
                className="w-56 rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm"
              />
            </Labelled>
            <Labelled label="Rule name (optional)">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={defaultName(metric, comparator, Number(threshold) || 0)}
                className="w-64 rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm"
              />
            </Labelled>
          </div>

          {COMPARATORS.find((c) => c.value === comparator)?.needsDates ? (
            <p className="text-xs text-ink-500">
              This rule compares two periods, so it only fires on reports that include a date column.
            </p>
          ) : null}

          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Saving…" : "Create rule"}
          </Button>
        </form>
      ) : null}

      {rules.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink-500">
          No rules yet. Add one to have AdMate check it on every report you upload.
        </p>
      ) : (
        <ul className="divide-y divide-ink-100">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink-900">{rule.name}</p>
                <p className="mt-0.5 text-sm text-ink-500">{describeRule(rule, currency)}</p>
              </div>
              <label className="flex items-center gap-2 text-xs text-ink-600">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  disabled={busy}
                  onChange={(e) =>
                    void call({
                      url: "/api/alerts/rules",
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: rule.id, enabled: e.target.checked }),
                    })
                  }
                  className="h-4 w-4 rounded border-ink-300"
                />
                {rule.enabled ? "Active" : "Paused"}
              </label>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void call({ url: `/api/alerts/rules?id=${encodeURIComponent(rule.id)}`, method: "DELETE" })
                }
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function defaultName(metric: MetricKey, comparator: AlertComparator, threshold: number): string {
  if (comparator === "spend_without_conversions") return `Spend above ${threshold} with no conversions`;
  const label = METRIC_META[metric].label;
  const verb = COMPARATORS.find((c) => c.value === comparator)?.label ?? "changes";
  return `${label} ${verb} ${threshold}`;
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-500">{label}</span>
      {children}
    </label>
  );
}
