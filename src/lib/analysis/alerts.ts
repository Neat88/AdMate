import type { EntityPerformance, MetricKey } from "./types";
import { METRIC_META } from "./types";
import { getMetric, type PerformanceModel } from "./metrics";
import { fmtValue } from "./detectors";

/**
 * User-defined monitoring.
 *
 * MVP honesty note: these rules are evaluated when a report is analysed, not
 * continuously. There are no live platform integrations, so AdMate does not
 * claim real-time monitoring anywhere in the UI.
 */

export type AlertComparator =
  | "above"
  | "below"
  | "increases_by"
  | "decreases_by"
  | "spend_without_conversions";

export type AlertScope = "account" | "campaign" | "adset" | "ad";

export interface AlertRule {
  id: string;
  workspaceId: string;
  name: string;
  metric: MetricKey;
  comparator: AlertComparator;
  /** Absolute value for above/below; fraction (0.2 == 20%) for change rules. */
  threshold: number;
  scope: AlertScope;
  /** Optional substring filter on entity name. */
  entityFilter: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface AlertEvent {
  ruleId: string;
  ruleName: string;
  severity: "high" | "medium";
  entityLevel: AlertScope;
  entityName: string;
  metric: MetricKey;
  observed: number;
  comparison: number | null;
  message: string;
}

export const COMPARATOR_LABELS: Record<AlertComparator, string> = {
  above: "rises above",
  below: "falls below",
  increases_by: "increases by more than",
  decreases_by: "decreases by more than",
  spend_without_conversions: "spends more than (with zero conversions)",
};

export function describeRule(rule: AlertRule, currency: string): string {
  const metric = METRIC_META[rule.metric].label;
  const verb = COMPARATOR_LABELS[rule.comparator];
  const scope = rule.scope === "account" ? "the account" : `any ${rule.scope}`;
  const filter = rule.entityFilter ? ` matching "${rule.entityFilter}"` : "";

  if (rule.comparator === "increases_by" || rule.comparator === "decreases_by") {
    return `Alert when ${metric} for ${scope}${filter} ${verb} ${(rule.threshold * 100).toFixed(0)}% versus the prior period.`;
  }
  if (rule.comparator === "spend_without_conversions") {
    return `Alert when ${scope}${filter} spends more than ${fmtValue(rule.threshold, "currency", currency)} with zero recorded conversions.`;
  }
  return `Alert when ${metric} for ${scope}${filter} ${verb} ${fmtValue(
    rule.threshold,
    METRIC_META[rule.metric].format,
    currency,
  )}.`;
}

function entitiesForScope(model: PerformanceModel, scope: AlertScope): EntityPerformance[] {
  switch (scope) {
    case "account":
      return [model.account];
    case "campaign":
      return model.campaigns;
    case "adset":
      return model.adsets;
    case "ad":
      return model.ads;
  }
}

export function evaluateAlerts(
  rules: AlertRule[],
  model: PerformanceModel,
  currency: string,
): AlertEvent[] {
  const events: AlertEvent[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const entities = entitiesForScope(model, rule.scope).filter((e) =>
      rule.entityFilter ? e.name.toLowerCase().includes(rule.entityFilter.toLowerCase()) : true,
    );

    for (const entity of entities) {
      const value = getMetric(entity.metrics, rule.metric);
      const format = METRIC_META[rule.metric].format;
      const name = entity.level === "account" ? "Account" : entity.name;

      if (rule.comparator === "spend_without_conversions") {
        const spend = getMetric(entity.metrics, "spend");
        const conversions = getMetric(entity.metrics, "conversions");
        // Only a *reported* zero triggers this; null means untracked.
        if (spend !== null && conversions === 0 && spend >= rule.threshold) {
          events.push({
            ruleId: rule.id,
            ruleName: rule.name,
            severity: "high",
            entityLevel: rule.scope,
            entityName: name,
            metric: "spend",
            observed: spend,
            comparison: rule.threshold,
            message: `${name} spent ${fmtValue(spend, "currency", currency)} with 0 recorded conversions (threshold ${fmtValue(rule.threshold, "currency", currency)}).`,
          });
        }
        continue;
      }

      if (rule.comparator === "above" || rule.comparator === "below") {
        if (value === null) continue;
        const breached = rule.comparator === "above" ? value > rule.threshold : value < rule.threshold;
        if (!breached) continue;
        events.push({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: "medium",
          entityLevel: rule.scope,
          entityName: name,
          metric: rule.metric,
          observed: value,
          comparison: rule.threshold,
          message: `${name}: ${METRIC_META[rule.metric].label} is ${fmtValue(value, format, currency)}, ${
            rule.comparator === "above" ? "above" : "below"
          } your target of ${fmtValue(rule.threshold, format, currency)}.`,
        });
        continue;
      }

      // Change-based rules need a period comparison, which needs dated data.
      const delta = entity.periodComparison?.deltas[rule.metric];
      if (!delta || delta.changePct === null || delta.current === null || delta.previous === null) continue;
      const change = delta.changePct;
      const breached =
        rule.comparator === "increases_by" ? change >= rule.threshold : change <= -rule.threshold;
      if (!breached) continue;

      events.push({
        ruleId: rule.id,
        ruleName: rule.name,
        severity: Math.abs(change) >= rule.threshold * 2 ? "high" : "medium",
        entityLevel: rule.scope,
        entityName: name,
        metric: rule.metric,
        observed: delta.current,
        comparison: delta.previous,
        message: `${name}: ${METRIC_META[rule.metric].label} moved ${change > 0 ? "up" : "down"} ${Math.abs(
          change * 100,
        ).toFixed(1)}% (${fmtValue(delta.previous, format, currency)} → ${fmtValue(
          delta.current,
          format,
          currency,
        )}), past your ${(rule.threshold * 100).toFixed(0)}% threshold.`,
      });
    }
  }

  // Most severe, largest deviation first.
  events.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
    return 0;
  });
  return events;
}

/** Sensible starting rules offered to every new workspace. */
export function defaultRules(workspaceId: string): Omit<AlertRule, "id" | "createdAt">[] {
  return [
    {
      workspaceId,
      name: "CPA rising sharply",
      metric: "cpa",
      comparator: "increases_by",
      threshold: 0.2,
      scope: "campaign",
      entityFilter: null,
      enabled: true,
    },
    {
      workspaceId,
      name: "Spend with no conversions",
      metric: "spend",
      comparator: "spend_without_conversions",
      threshold: 50,
      scope: "campaign",
      entityFilter: null,
      enabled: true,
    },
    {
      workspaceId,
      name: "CTR falling",
      metric: "ctr",
      comparator: "decreases_by",
      threshold: 0.25,
      scope: "campaign",
      entityFilter: null,
      enabled: true,
    },
  ];
}
