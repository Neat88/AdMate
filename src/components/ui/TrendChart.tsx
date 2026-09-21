"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { useState } from "react";
import type { MetricKey, TrendPoint } from "@/lib/analysis/types";
import { METRIC_META } from "@/lib/analysis/types";
import { formatMetric, formatCompact, formatDate } from "@/lib/format";
import { getMetric } from "@/lib/analysis/metrics";

/**
 * Metric trend over time.
 *
 * Two series maximum, on independent axes, because a chart comparing spend
 * against CTR on a shared axis tells the reader nothing. Series colours are
 * paired with distinct dash patterns so the lines stay distinguishable without
 * relying on colour.
 */
export function TrendChart({
  trend,
  currency,
  availableMetrics,
  defaultPrimary = "spend",
  defaultSecondary = "conversions",
}: {
  trend: TrendPoint[];
  currency: string;
  availableMetrics: MetricKey[];
  defaultPrimary?: MetricKey;
  defaultSecondary?: MetricKey | "none";
}) {
  const options = availableMetrics.filter((m) => METRIC_META[m]);
  const [primary, setPrimary] = useState<MetricKey>(
    options.includes(defaultPrimary) ? defaultPrimary : options[0],
  );
  const [secondary, setSecondary] = useState<MetricKey | "none">(
    defaultSecondary !== "none" && options.includes(defaultSecondary as MetricKey)
      ? defaultSecondary
      : "none",
  );

  const data = trend.map((point) => ({
    date: point.date,
    primary: getMetric(point.metrics, primary),
    secondary: secondary === "none" ? null : getMetric(point.metrics, secondary),
  }));

  if (trend.length < 2) {
    return (
      <p className="px-5 py-8 text-center text-sm text-ink-500">
        This report does not contain enough dated rows to draw a trend.
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 px-5 pb-3 pt-4">
        <MetricPicker label="Primary" value={primary} options={options} onChange={(v) => setPrimary(v as MetricKey)} />
        <MetricPicker
          label="Compare"
          value={secondary}
          options={options}
          allowNone
          onChange={(v) => setSecondary(v as MetricKey | "none")}
        />
      </div>

      <div className="h-64 w-full px-2 pb-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eceef2" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(v: string) => formatDate(v).replace(/, \d{4}$/, "")}
              tick={{ fontSize: 11, fill: "#667085" }}
              axisLine={{ stroke: "#d9dde5" }}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11, fill: "#667085" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => axisTick(v, primary)}
              width={56}
            />
            {secondary !== "none" ? (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11, fill: "#667085" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => axisTick(v, secondary)}
                width={56}
              />
            ) : null}
            <Tooltip
              contentStyle={{
                borderRadius: 8,
                border: "1px solid #d9dde5",
                fontSize: 12,
                boxShadow: "0 4px 12px rgba(18,25,38,0.08)",
              }}
              labelFormatter={(v) => formatDate(String(v))}
              formatter={(value, name) => {
                const metric = name === "primary" ? primary : (secondary as MetricKey);
                const numeric = typeof value === "number" ? value : null;
                return [formatMetric(numeric, metric, currency), METRIC_META[metric].label];
              }}
            />
            <Legend
              verticalAlign="top"
              height={28}
              iconType="plainline"
              formatter={(name: string) =>
                METRIC_META[name === "primary" ? primary : (secondary as MetricKey)].label
              }
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="primary"
              stroke="#2442eb"
              strokeWidth={2}
              dot={false}
              connectNulls
              activeDot={{ r: 4 }}
            />
            {secondary !== "none" ? (
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="secondary"
                stroke="#0369a1"
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={false}
                connectNulls
                activeDot={{ r: 4 }}
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function axisTick(value: number, metric: MetricKey): string {
  const format = METRIC_META[metric].format;
  if (format === "percent") return `${(value * 100).toFixed(1)}%`;
  if (format === "ratio") return `${value.toFixed(1)}x`;
  return formatCompact(value);
}

function MetricPicker({
  label,
  value,
  options,
  onChange,
  allowNone = false,
}: {
  label: string;
  value: string;
  options: MetricKey[];
  onChange: (value: string) => void;
  allowNone?: boolean;
}) {
  const id = `picker-${label.toLowerCase()}`;
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-ink-500">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-ink-200 bg-white px-2 py-1 text-xs font-medium text-ink-700"
      >
        {allowNone ? <option value="none">None</option> : null}
        {options.map((m) => (
          <option key={m} value={m}>
            {METRIC_META[m].label}
          </option>
        ))}
      </select>
    </div>
  );
}
