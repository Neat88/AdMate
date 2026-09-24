import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionContext } from "@/lib/session";
import {
  getReport,
  getReportIssues,
  getLatestAnalysis,
  getAnalysisModel,
  getAnalysisFacts,
  listRecommendationsForAnalysis,
  type RecommendationRecord,
  type ReportRecord,
  type AnalysisRecord,
} from "@/lib/db/queries";
import type { DataIssue } from "@/lib/analysis/parse";
import type { PerformanceModel } from "@/lib/analysis/metrics";
import type { ReportFacts } from "@/lib/analysis/facts";
import type { Finding } from "@/lib/analysis/detectors";
import type { Insight } from "@/lib/ai/insights";
import { isAiConfigured } from "@/lib/ai/insights";
import type { Tier } from "@/lib/analysis/diagnoses";
import { objectiveLabel } from "@/lib/analysis/objectives";
import { AssistantProvider } from "@/components/assistant/AssistantProvider";
import { AskButton } from "@/components/assistant/AskButton";
import { TodayBriefing } from "@/components/report/TodayBriefing";
import { ActionQueue, type RecommendationRef } from "@/components/report/ActionQueue";
import { WhatChanged } from "@/components/report/WhatChanged";
import { ReanalyzeButton } from "@/components/report/ReanalyzeButton";
import { healthKey } from "@/components/report/health";
import { TIER_ORDER } from "@/components/report/tiers";
import { loadHistory } from "@/lib/analysis/report-history";
import { VsPreviousUpload } from "@/components/report/VsPreviousUpload";
import { deserializeModel, accountKpis } from "@/lib/analysis/pipeline";
import { PLATFORM_LABELS, BASE_METRICS, DERIVED_METRICS } from "@/lib/analysis/types";
import type { MetricKey } from "@/lib/analysis/types";
import { getMetric } from "@/lib/analysis/metrics";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  Card,
  CardHeader,
  PageHeader,
  Banner,
  LinkButton,
  EmptyState,
} from "@/components/ui/primitives";
import { KpiCard, KpiGrid } from "@/components/ui/KpiCard";
import { InsightCard } from "@/components/ui/InsightCard";
import { AnalysisTabs } from "./AnalysisTabs";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const { id } = await params;
  const report = getReport(session.user.id, id);
  if (!report) notFound();

  const issues = getReportIssues(session.user.id, id);
  const analysis = getLatestAnalysis(session.user.id, id);
  const modelJson = analysis ? getAnalysisModel(session.user.id, analysis.id) : null;
  const model = modelJson ? deserializeModel(modelJson) : null;
  const recommendations = analysis ? listRecommendationsForAnalysis(session.user.id, analysis.id) : [];

  if (!analysis || !model) {
    return (
      <EmptyState
        title="This report has no analysis yet"
        description="Something interrupted the analysis step. Re-upload the file to try again."
        action={<LinkButton href="/upload">Upload again</LinkButton>}
      />
    );
  }

  const facts = getAnalysisFacts(session.user.id, analysis.id);
  if (!facts) {
    return <LegacyReport report={report} analysis={analysis} model={model} issues={issues} recommendations={recommendations} />;
  }

  // Only offer metrics the account roll-up actually produced.
  const availableMetrics = ([...BASE_METRICS, ...DERIVED_METRICS] as MetricKey[]).filter(
    (m) => getMetric(model.account.metrics, m) !== null,
  );
  const kpis = accountKpis(model);
  const blocking = issues.filter((i) => i.severity === "error" || i.severity === "warning");

  const findings: Record<string, Finding> = {};
  const insights: Record<string, Insight> = {};
  const recs: Record<string, RecommendationRef> = {};
  for (const r of recommendations) {
    findings[r.findingId] = r.finding;
    insights[r.findingId] = r.insight;
    recs[r.findingId] = { id: r.id, status: r.status, note: r.note };
  }

  const history = loadHistory(session.user.id, report, model, facts);

  // Worst tier per entity, for the health chips in the breakdown table.
  const health: Record<string, Tier> = {};
  for (const d of facts.diagnoses) {
    const key = healthKey(d.level, d.campaign, d.adset, d.entityName);
    const current = health[key];
    if (!current || TIER_ORDER.indexOf(d.tier) < TIER_ORDER.indexOf(current)) health[key] = d.tier;
  }

  return (
    <AssistantProvider
      reportId={report.id}
      aiEnabled={isAiConfigured()}
      facts={facts}
      model={model}
      currency={report.currency}
    >
      <div className="space-y-6">
        <PageHeader
          title={report.filename}
          description={
            <>
              {PLATFORM_LABELS[report.platform]} · {report.rowCount.toLocaleString()} rows ·{" "}
              {report.periodStart && report.periodEnd
                ? `${formatDate(report.periodStart)} – ${formatDate(report.periodEnd)}`
                : "no reporting period"}{" "}
              · {objectiveLabel(facts.accountObjective)} · Analysed {formatDateTime(analysis.createdAt)}
            </>
          }
          action={
            <div className="flex flex-wrap gap-2">
              <AskButton focus={{ kind: "report" }} label="Ask AdMate" variant="button" />
              <LinkButton href={`/reports/${report.id}/share`} variant="secondary">
                Client report
              </LinkButton>
              <LinkButton href="/upload">Upload new</LinkButton>
            </div>
          }
        />

        {analysis.fallbackReason ? (
          <Banner tone="warning" title="Part of this analysis used the built-in analyst">
            {analysis.fallbackReason}
          </Banner>
        ) : null}

        {blocking.length > 0 ? (
          <Banner
            tone={blocking.some((i) => i.severity === "error") ? "error" : "warning"}
            title={`${blocking.length} data quality issue${blocking.length === 1 ? "" : "s"} in this file`}
          >
            <ul className="list-disc space-y-1 pl-4">
              {blocking.map((issue, i) => (
                <li key={i}>{issue.message}</li>
              ))}
            </ul>
          </Banner>
        ) : null}

        <TodayBriefing briefing={facts.briefing} comparisonLabel={facts.comparisonLabel} issues={issues} />

        <ActionQueue
          diagnoses={facts.diagnoses}
          findings={findings}
          insights={insights}
          recommendations={recs}
          currency={report.currency}
        />

        <WhatChanged
          analyses={facts.whatChanged}
          objective={facts.accountObjective}
          currency={report.currency}
          comparisonLabel={facts.comparisonLabel}
        />

        {history ? <VsPreviousUpload history={history} objective={facts.accountObjective} currency={report.currency} /> : null}

        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink-900">
            Account performance
            <span className="ml-2 font-normal text-ink-500">
              — {kpis.length} metric{kpis.length === 1 ? "" : "s"} available in this file
            </span>
          </h2>
          <KpiGrid>
            {kpis.map(({ metric, value }) => (
              <KpiCard
                key={metric}
                metric={metric}
                value={value}
                currency={report.currency}
                comparison={model.account.periodComparison}
                objective={facts.accountObjective}
                askable
              />
            ))}
          </KpiGrid>
        </section>

        <AnalysisTabs
          model={model}
          currency={report.currency}
          availableMetrics={availableMetrics}
          accountTrend={model.account.trend ?? []}
          objectives={facts.objectives}
          accountObjective={facts.accountObjective}
          health={health}
          reportId={report.id}
        />

        <Card>
          <CardHeader
            title="Analyst notes"
            description={
              analysis.engine === "claude"
                ? "Written by Claude from the metrics AdMate calculated, and checked against them."
                : "Written by AdMate's built-in analyst."
            }
          />
          <p className="px-5 py-4 text-sm leading-relaxed text-ink-700">{analysis.summary}</p>
        </Card>

        <p className="text-xs text-ink-500">
          <Link href="/recommendations" className="font-medium text-brand-600 hover:underline">
            Track recommendations across all reports →
          </Link>
        </p>
      </div>
    </AssistantProvider>
  );
}

/**
 * Analyses stored before the facts layer existed render as they always did,
 * with an offer to re-run the current engine on the stored rows.
 */
function LegacyReport({
  report,
  analysis,
  model,
  issues,
  recommendations,
}: {
  report: ReportRecord;
  analysis: AnalysisRecord;
  model: PerformanceModel;
  issues: DataIssue[];
  recommendations: RecommendationRecord[];
}) {
  // Only offer metrics the account roll-up actually produced.
  const availableMetrics = ([...BASE_METRICS, ...DERIVED_METRICS] as MetricKey[]).filter(
    (m) => getMetric(model.account.metrics, m) !== null,
  );
  const kpis = accountKpis(model);

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const notes = issues.filter((i) => i.severity === "info");

  const byPriority = {
    high: recommendations.filter((r) => r.finding.priority === "high"),
    medium: recommendations.filter((r) => r.finding.priority === "medium"),
    low: recommendations.filter((r) => r.finding.priority === "low"),
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={report.filename}
        description={
          <>
            {PLATFORM_LABELS[report.platform]} · {report.rowCount.toLocaleString()} rows ·{" "}
            {report.periodStart && report.periodEnd
              ? `${formatDate(report.periodStart)} – ${formatDate(report.periodEnd)}`
              : "no reporting period"}
            {report.objective ? ` · Objective: ${report.objective}` : ""} · Analysed{" "}
            {formatDateTime(analysis.createdAt)}
          </>
        }
        action={
          <div className="flex gap-2">
            <LinkButton href={`/reports/${report.id}/share`} variant="secondary">
              Client report
            </LinkButton>
            <LinkButton href="/upload">Upload new</LinkButton>
          </div>
        }
      />

      <Banner tone="info" title="This report was analysed with an earlier version of AdMate">
        <p>
          Re-analyse it to get today&apos;s briefing, objective-aware recommendations, the &ldquo;what changed&rdquo;
          breakdown and the AdMate assistant. Your file does not need to be uploaded again.
        </p>
        <div className="mt-2">
          <ReanalyzeButton reportId={report.id} />
        </div>
      </Banner>

      {analysis.fallbackReason ? (
        <Banner tone="warning" title="Part of this analysis used the built-in analyst">
          {analysis.fallbackReason}
        </Banner>
      ) : null}

      {errors.length + warnings.length > 0 ? (
        <Banner
          tone={errors.length > 0 ? "error" : "warning"}
          title={`${errors.length + warnings.length} data quality issue${errors.length + warnings.length === 1 ? "" : "s"} in this file`}
        >
          <ul className="list-disc space-y-1 pl-4">
            {[...errors, ...warnings].map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </Banner>
      ) : null}

      {notes.length > 0 ? (
        <Banner tone="info" title="What this report does and does not contain">
          <ul className="list-disc space-y-1 pl-4">
            {notes.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <Card>
        <CardHeader
          title="Summary"
          description={
            analysis.engine === "claude"
              ? "Written by Claude from the metrics AdMate calculated."
              : "Written by AdMate's built-in analyst."
          }
        />
        <p className="px-5 py-4 text-sm leading-relaxed text-ink-700">{analysis.summary}</p>
      </Card>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink-900">
          Account performance
          <span className="ml-2 font-normal text-ink-500">
            — {kpis.length} metric{kpis.length === 1 ? "" : "s"} available in this file
          </span>
        </h2>
        <KpiGrid>
          {kpis.map(({ metric, value }) => (
            <KpiCard
              key={metric}
              metric={metric}
              value={value}
              currency={report.currency}
              comparison={model.account.periodComparison}
            />
          ))}
        </KpiGrid>
      </section>

      <AnalysisTabs
        model={model}
        currency={report.currency}
        availableMetrics={availableMetrics}
        accountTrend={model.account.trend ?? []}
      />

      <section id="recommendations">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-900">
            Recommendations
            <span className="ml-2 font-normal text-ink-500">
              — {recommendations.length} found, ordered by money at stake
            </span>
          </h2>
          <Link href="/recommendations" className="text-sm font-medium text-brand-600 hover:underline">
            Track across all reports →
          </Link>
        </div>

        {recommendations.length === 0 ? (
          <EmptyState
            title="No issues crossed AdMate's thresholds"
            description="Nothing in this report stood out against the account's own averages. That is not a judgement on whether the results meet your business targets — set your own thresholds in Alerts for that."
            action={<LinkButton href="/alerts" variant="secondary">Set up alerts</LinkButton>}
          />
        ) : (
          <div className="space-y-6">
            {(["high", "medium", "low"] as const).map((priority) =>
              byPriority[priority].length === 0 ? null : (
                <div key={priority}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-600">
                    {priority === "high"
                      ? "High priority — investigate now"
                      : priority === "medium"
                        ? "Medium priority — worth reviewing"
                        : "Low priority — consider later"}{" "}
                    ({byPriority[priority].length})
                  </h3>
                  <div className="space-y-3">
                    {byPriority[priority].map((rec) => (
                      <InsightCard
                        key={rec.id}
                        finding={rec.finding}
                        insight={rec.insight}
                        currency={report.currency}
                        recommendationId={rec.id}
                        status={rec.status}
                        note={rec.note}
                        defaultOpen={priority === "high"}
                      />
                    ))}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </section>
    </div>
  );
}
