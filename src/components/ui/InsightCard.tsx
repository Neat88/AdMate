"use client";

import { useState, useTransition } from "react";
import type { Finding } from "@/lib/analysis/detectors";
import type { Insight } from "@/lib/ai/insights";
import type { RecommendationStatus } from "@/lib/db/queries";
import { formatByType, formatChange, changeIsGood } from "@/lib/format";
import {
  PriorityBadge,
  KindBadge,
  ConfidenceBadge,
  StatusBadge,
  Button,
  DeltaChip,
} from "./primitives";

/**
 * A recommendation, rendered as the five-part framework:
 *   1. What happened  2. Supporting data  3. Why it might be happening
 *   4. What to do next  5. What to monitor afterwards
 *
 * Section 2 is always the deterministic evidence. Sections 3-5 are the
 * analysis, and section 3 is explicitly framed as hypotheses rather than
 * conclusions — that framing is load-bearing, not decorative.
 */
export function InsightCard({
  finding,
  insight,
  currency,
  recommendationId,
  status,
  note,
  defaultOpen = false,
}: {
  finding: Finding;
  insight: Insight;
  currency: string;
  recommendationId?: string;
  status?: RecommendationStatus;
  note?: string | null;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [currentStatus, setCurrentStatus] = useState<RecommendationStatus>(status ?? "new");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const updateStatus = (next: RecommendationStatus) => {
    if (!recommendationId) return;
    setError(null);
    startTransition(async () => {
      const previous = currentStatus;
      setCurrentStatus(next);
      try {
        const res = await fetch(`/api/recommendations/${recommendationId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: next }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Update failed");
      } catch (e) {
        setCurrentStatus(previous);
        setError(e instanceof Error ? e.message : "Could not save that change.");
      }
    });
  };

  const entityLabel =
    finding.level === "account"
      ? "Account-wide"
      : `${finding.level === "adset" ? "Ad set" : finding.level === "ad" ? "Ad" : "Campaign"}: ${finding.entityName}`;

  return (
    <article
      className={`overflow-hidden rounded-xl border bg-white print-break ${
        currentStatus === "dismissed" ? "border-ink-200 opacity-60" : "border-ink-200"
      }`}
    >
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <PriorityBadge priority={finding.priority} />
          <KindBadge kind={finding.kind} />
          {status !== undefined ? <StatusBadge status={currentStatus} /> : null}
          {insight.engine === "local" ? (
            <span
              className="rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 text-[11px] font-medium text-ink-500"
              title="Written by AdMate's built-in analyst because no LLM key is configured, or because the model's wording failed evidence validation. The metrics are identical either way."
            >
              Local analyst
            </span>
          ) : null}
        </div>

        <h3 className="mt-2.5 text-base font-semibold text-ink-900">{finding.title}</h3>
        <p className="mt-0.5 text-sm text-ink-500">{entityLabel}</p>

        {/* 1. What happened */}
        <p className="mt-3 text-sm leading-relaxed text-ink-700">{insight.whatHappened}</p>

        {/* 2. Supporting data — always the computed figures */}
        <EvidenceStrip finding={finding} currency={currency} />

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <ConfidenceBadge level={finding.confidence} reason={finding.confidenceReason} />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            {open ? "Hide analysis" : "Why this happened & what to do"}
            <span aria-hidden="true" className="ml-1">
              {open ? "▴" : "▾"}
            </span>
          </button>
        </div>
      </div>

      {open ? (
        <div className="border-t border-ink-100 bg-ink-50/50 px-5 py-4">
          <Section
            title="Why this might be happening"
            caveat="These are possible explanations consistent with the data — not confirmed causes."
            items={insight.possibleCauses}
            ordered={false}
          />
          <Section title="What to do next" items={insight.recommendedActions} ordered />
          <Section title="What to monitor afterwards" items={insight.monitor} ordered={false} />

          {insight.dataGaps.length > 0 ? (
            <div className="mt-4 rounded-lg border border-med-200 bg-med-50 px-3 py-2.5">
              <p className="text-xs font-semibold text-med-700">
                What this report can&apos;t tell us
              </p>
              <ul className="mt-1 space-y-0.5">
                {insight.dataGaps.map((gap, i) => (
                  <li key={i} className="text-xs leading-relaxed text-med-700">
                    {gap}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="mt-4 text-xs leading-relaxed text-ink-500">
            <span className="font-medium">Confidence — {finding.confidence}.</span>{" "}
            {finding.confidenceReason}
          </p>

          {note ? (
            <p className="mt-2 rounded border border-ink-200 bg-white px-2.5 py-1.5 text-xs text-ink-600">
              <span className="font-medium">Your note:</span> {note}
            </p>
          ) : null}
        </div>
      ) : null}

      {recommendationId ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 px-5 py-3 no-print">
          <span className="mr-auto text-xs text-ink-500">
            AdMate never changes your campaigns — you decide and act in the ad platform.
          </span>
          <Button
            size="sm"
            variant={currentStatus === "in_review" ? "primary" : "secondary"}
            disabled={pending}
            onClick={() => updateStatus("in_review")}
          >
            In review
          </Button>
          <Button
            size="sm"
            variant={currentStatus === "action_taken" ? "primary" : "secondary"}
            disabled={pending}
            onClick={() => updateStatus("action_taken")}
          >
            Action taken
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => updateStatus(currentStatus === "dismissed" ? "new" : "dismissed")}
          >
            {currentStatus === "dismissed" ? "Restore" : "Dismiss"}
          </Button>
          {error ? <span className="w-full text-xs text-high-700">{error}</span> : null}
        </div>
      ) : null}
    </article>
  );
}

/** Section 2 of the framework: the metrics, straight from the engine. */
function EvidenceStrip({ finding, currency }: { finding: Finding; currency: string }) {
  const items = finding.evidence.filter((e) => e.value !== null);
  if (items.length === 0) return null;

  return (
    // Wraps rather than scrolling sideways: a hidden horizontal scroller is
    // poor discoverability on a phone, and a wrapping grid cannot push the
    // page wider than its container.
    <div className="mt-3">
      <dl className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {items.map((e, i) => (
          <div
            key={i}
            className="min-w-0 rounded-lg border border-ink-200 bg-white px-2.5 py-2 sm:min-w-[128px] sm:flex-1"
          >
            <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-ink-500" title={e.label}>
              {e.label}
            </dt>
            <dd className="mt-0.5 text-sm font-semibold text-ink-900 tnum">
              {formatByType(e.value, e.format, currency)}
            </dd>
            {e.comparison !== null && e.comparison !== undefined ? (
              <dd className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-500 tnum">
                {e.changePct != null ? (
                  <DeltaChip
                    change={e.changePct}
                    isGood={e.metric ? changeIsGood(e.metric, e.changePct) : null}
                  />
                ) : null}
                <span className="truncate" title={`${e.comparisonLabel}: ${formatByType(e.comparison, e.format, currency)}`}>
                  from {formatByType(e.comparison, e.format, currency)}
                </span>
              </dd>
            ) : null}
          </div>
        ))}
      </dl>
    </div>
  );
}

function Section({
  title,
  items,
  ordered,
  caveat,
}: {
  title: string;
  items: string[];
  ordered: boolean;
  caveat?: string;
}) {
  if (!items || items.length === 0) return null;
  const List = ordered ? "ol" : "ul";
  return (
    <div className="mb-4 last:mb-0">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-700">{title}</h4>
      {caveat ? <p className="mt-0.5 text-xs italic text-ink-500">{caveat}</p> : null}
      <List className={`mt-1.5 space-y-1.5 ${ordered ? "list-decimal" : "list-disc"} pl-5`}>
        {items.map((item, i) => (
          <li key={i} className="text-sm leading-relaxed text-ink-700 marker:text-ink-400">
            {item}
          </li>
        ))}
      </List>
    </div>
  );
}

export { formatChange };
