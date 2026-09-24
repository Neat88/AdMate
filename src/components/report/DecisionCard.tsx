"use client";

import { useState, useTransition } from "react";
import type { Diagnosis } from "@/lib/analysis/diagnoses";
import type { Finding } from "@/lib/analysis/detectors";
import type { Insight } from "@/lib/ai/insights";
import type { RecommendationStatus } from "@/lib/db/queries";
import { formatByType, changeIsGood } from "@/lib/format";
import { Button, ConfidenceBadge, DeltaChip, StatusBadge } from "@/components/ui/primitives";
import { AskButton } from "@/components/assistant/AskButton";
import { WhyTrace } from "./WhyTrace";
import { TIER_STYLE } from "./tiers";

/**
 * One decision: what the problem is, the evidence, the one action AdMate
 * suggests, what else you could do, and when to look again. The full
 * five-part analysis of each underlying signal sits behind "Full analysis".
 */
export function DecisionCard({
  diagnosis,
  findings,
  insights,
  currency,
  recommendationId,
  status,
  note,
  defaultOpen = false,
}: {
  diagnosis: Diagnosis;
  findings: Finding[];
  insights: Map<string, Insight>;
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
  const tier = TIER_STYLE[diagnosis.tier];
  const primaryInsight = insights.get(diagnosis.primaryFindingId);

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
    diagnosis.level === "account"
      ? "Account-wide"
      : `${diagnosis.level === "adset" ? "Ad set" : diagnosis.level === "ad" ? "Ad" : "Campaign"}: ${diagnosis.entityName}`;

  return (
    <article
      id={diagnosis.id}
      className={`relative overflow-hidden rounded-xl border border-ink-200 bg-white print-break scroll-mt-20 ${
        currentStatus === "dismissed" ? "opacity-60" : ""
      }`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${tier.rail}`} aria-hidden="true" />
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tier.chip}`}>
            <span aria-hidden="true">{tier.glyph}</span>
            {tier.label}
          </span>
          <span className="rounded-md bg-ink-900 px-2 py-0.5 text-xs font-semibold text-white">{diagnosis.actionLabel}</span>
          {recommendationId ? <StatusBadge status={currentStatus} /> : null}
          <span className="ml-auto">
            <AskButton focus={{ kind: "diagnosis", diagnosisId: diagnosis.id }} label="Ask about this" />
          </span>
        </div>

        <h3 className="mt-2.5 text-base font-semibold text-ink-900">{diagnosis.title}</h3>
        <p className="text-sm text-ink-500">{entityLabel}</p>

        <p className="mt-2.5 text-sm leading-relaxed text-ink-700">{diagnosis.summary}</p>

        {diagnosis.keyEvidence.length > 0 ? (
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {diagnosis.keyEvidence.map((e, i) => (
              <div key={i} className="min-w-0 rounded-lg border border-ink-200 px-2.5 py-2">
                <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-ink-500" title={e.label}>
                  {e.label}
                </dt>
                <dd className="mt-0.5 text-sm font-semibold text-ink-900 tnum">{formatByType(e.value, e.format, currency)}</dd>
                {e.comparison != null ? (
                  <dd className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-500 tnum">
                    {e.changePct != null ? (
                      <DeltaChip change={e.changePct} isGood={e.metric ? changeIsGood(e.metric, e.changePct) : null} />
                    ) : null}
                    <span className="truncate" title={e.comparisonLabel}>
                      vs {formatByType(e.comparison, e.format, currency)}
                      {e.comparisonLabel?.toLowerCase().includes("average") ? " avg" : e.comparisonLabel?.toLowerCase().startsWith("prior") ? " before" : ""}
                    </span>
                  </dd>
                ) : null}
              </div>
            ))}
          </dl>
        ) : null}

        <div className="mt-3 rounded-lg border border-brand-100 bg-brand-50/60 px-3 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">Recommended next step</p>
          <p className="mt-0.5 text-sm leading-relaxed text-ink-800">{diagnosis.recommendation}</p>
          <p className="mt-1 text-xs text-ink-500">{diagnosis.recheck}</p>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <ConfidenceBadge level={diagnosis.confidence} reason={findings[0]?.confidenceReason} />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            {open ? "Hide details" : "Evidence, options & full analysis"}
            <span aria-hidden="true" className="ml-1">
              {open ? "▴" : "▾"}
            </span>
          </button>
        </div>

        <WhyTrace findings={findings} />
      </div>

      {open ? (
        <div className="space-y-4 border-t border-ink-100 bg-ink-50/50 px-5 py-4">
          {diagnosis.signals.length > 1 ? (
            <Section title="Signals combined into this diagnosis">
              <ul className="list-disc space-y-1 pl-5">
                {diagnosis.signals.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title="If you'd rather not do that">
            <ul className="list-disc space-y-1 pl-5">
              {diagnosis.alternatives.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </Section>

          {primaryInsight ? (
            <>
              <Section
                title="Why this might be happening"
                caveat="Possible explanations consistent with the data - not confirmed causes."
              >
                <ul className="list-disc space-y-1 pl-5">
                  {primaryInsight.possibleCauses.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </Section>
              <Section title="Diagnostic steps">
                <ol className="list-decimal space-y-1 pl-5">
                  {primaryInsight.recommendedActions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ol>
              </Section>
              <Section title="What to monitor afterwards">
                <ul className="list-disc space-y-1 pl-5">
                  {primaryInsight.monitor.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </Section>
              {primaryInsight.dataGaps.length > 0 ? (
                <div className="rounded-lg border border-med-200 bg-med-50 px-3 py-2.5">
                  <p className="text-xs font-semibold text-med-700">What this report can&apos;t tell us</p>
                  <ul className="mt-1 space-y-0.5">
                    {primaryInsight.dataGaps.map((g, i) => (
                      <li key={i} className="text-xs leading-relaxed text-med-700">
                        {g}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}

          <p className="text-xs leading-relaxed text-ink-500">
            <span className="font-medium">Confidence — {diagnosis.confidence}.</span> {findings[0]?.confidenceReason}
          </p>
          {note ? (
            <p className="rounded border border-ink-200 bg-white px-2.5 py-1.5 text-xs text-ink-600">
              <span className="font-medium">Your note:</span> {note}
            </p>
          ) : null}
        </div>
      ) : null}

      {recommendationId ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 px-5 py-3 no-print">
          <span className="mr-auto text-xs text-ink-500">AdMate never changes your campaigns — you decide and act.</span>
          <Button size="sm" variant={currentStatus === "in_review" ? "primary" : "secondary"} disabled={pending} onClick={() => updateStatus("in_review")}>
            In review
          </Button>
          <Button size="sm" variant={currentStatus === "action_taken" ? "primary" : "secondary"} disabled={pending} onClick={() => updateStatus("action_taken")}>
            Action taken
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => updateStatus(currentStatus === "dismissed" ? "new" : "dismissed")}>
            {currentStatus === "dismissed" ? "Restore" : "Dismiss"}
          </Button>
          {error ? <span className="w-full text-xs text-high-700">{error}</span> : null}
        </div>
      ) : null}
    </article>
  );
}

function Section({ title, caveat, children }: { title: string; caveat?: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-700">{title}</h4>
      {caveat ? <p className="mt-0.5 text-xs italic text-ink-500">{caveat}</p> : null}
      <div className="mt-1.5 text-sm leading-relaxed text-ink-700">{children}</div>
    </div>
  );
}
