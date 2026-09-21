import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionContext } from "@/lib/session";
import {
  getReport,
  getReportIssues,
  getLatestAnalysis,
  getAnalysisModel,
  listRecommendationsForAnalysis,
} from "@/lib/db/queries";
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
