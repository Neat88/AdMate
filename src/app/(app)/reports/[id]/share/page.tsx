import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionContext } from "@/lib/session";
import {
  getReport,
  getLatestAnalysis,
  getAnalysisModel,
  listRecommendationsForAnalysis,
} from "@/lib/db/queries";
import { deserializeModel, accountKpis } from "@/lib/analysis/pipeline";
import { getMetric } from "@/lib/analysis/metrics";
import { PLATFORM_LABELS, METRIC_META } from "@/lib/analysis/types";
import type { MetricKey } from "@/lib/analysis/types";
import { formatMetric, formatDate, formatDateTime, changeIsGood } from "@/lib/format";
import { DeltaChip, PriorityBadge } from "@/components/ui/primitives";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";

/**
 * Client-facing report.
 *
 * Designed to be printed or saved as PDF via the browser. It is a *summary*,
 * not the working view: no status controls, no filters, and the recommendation
 * list is trimmed to what a client or manager needs to see.
 *
 * The header block is the natural seam for agency white-labelling later — a
 * stored logo and colour per workspace would slot in here without touching the
 * analysis code.
 */
export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const { id } = await params;
  const report = getReport(session.user.id, id);
  if (!report) notFound();

  const analysis = getLatestAnalysis(session.user.id, id);
  const modelJson = analysis ? getAnalysisModel(session.user.id, analysis.id) : null;
  if (!analysis || !modelJson) notFound();

  const model = deserializeModel(modelJson);
  const recommendations = listRecommendationsForAnalysis(session.user.id, analysis.id).filter(
    (r) => r.status !== "dismissed",
  );
  const kpis = accountKpis(model);
  const topCampaigns = model.campaigns.slice(0, 8);

  const columns = (["spend", "impressions", "clicks", "ctr", "conversions", "cpa", "roas"] as MetricKey[]).filter(
    (m) => model.campaigns.some((c) => getMetric(c.metrics, m) !== null),
  );

  const high = recommendations.filter((r) => r.finding.priority === "high");
  const rest = recommendations.filter((r) => r.finding.priority !== "high").slice(0, 5);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <Link href={`/reports/${report.id}`} className="text-sm font-medium text-brand-600 hover:underline">
          ← Back to full analysis
        </Link>
        <PrintButton />
      </div>

      <header className="border-b border-ink-200 pb-5">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white"
          >
            A
          </span>
          <span className="text-sm font-semibold text-ink-700">{session.workspace.name}</span>
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink-900">
          Advertising performance report
        </h1>
        <p className="mt-1 text-sm text-ink-600">
          {PLATFORM_LABELS[report.platform]}
          {report.periodStart && report.periodEnd
            ? ` · ${formatDate(report.periodStart)} – ${formatDate(report.periodEnd)}`
            : ""}
          {report.objective ? ` · ${report.objective}` : ""}
        </p>
        <p className="mt-0.5 text-xs text-ink-500">
          Prepared {formatDateTime(analysis.createdAt)} from {report.filename}. All figures are
          calculated directly from that file.
        </p>
      </header>

      <section className="print-break">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">Summary</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-700">{analysis.summary}</p>
      </section>

      <section className="print-break">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
          Performance overview
        </h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {kpis.map(({ metric, value }) => {
            const delta = model.account.periodComparison?.deltas[metric];
            return (
              <div key={metric} className="rounded-lg border border-ink-200 px-3 py-2">
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
                  {METRIC_META[metric].label}
                </dt>
                <dd className="mt-0.5 text-lg font-semibold text-ink-900 tnum">
                  {formatMetric(value, metric, report.currency)}
                </dd>
                {delta?.changePct != null ? (
                  <dd className="mt-0.5">
                    <DeltaChip change={delta.changePct} isGood={changeIsGood(metric, delta.changePct)} />
                  </dd>
                ) : null}
              </div>
            );
          })}
        </dl>
      </section>

      {topCampaigns.length > 0 ? (
        <section className="print-break">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
            Campaign results
          </h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-ink-200 bg-ink-50 text-left">
                  <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase text-ink-600">
                    Campaign
                  </th>
                  {columns.map((m) => (
                    <th
                      key={m}
                      scope="col"
                      className="px-3 py-2 text-right text-xs font-semibold uppercase text-ink-600"
                    >
                      {METRIC_META[m].label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topCampaigns.map((campaign) => (
                  <tr key={campaign.id} className="border-b border-ink-100 last:border-0">
                    <th scope="row" className="max-w-[220px] px-3 py-2 text-left font-medium text-ink-900">
                      <span className="block truncate">{campaign.name}</span>
                    </th>
                    {columns.map((m) => (
                      <td key={m} className="px-3 py-2 text-right text-ink-700 tnum">
                        {formatMetric(getMetric(campaign.metrics, m), m, report.currency)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {model.campaigns.length > topCampaigns.length ? (
            <p className="mt-2 text-xs text-ink-500">
              Showing the {topCampaigns.length} highest-spending of {model.campaigns.length} campaigns.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="print-break">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
          Main issues and next actions
        </h2>
        {recommendations.length === 0 ? (
          <p className="mt-2 text-sm text-ink-600">
            No issues crossed AdMate&apos;s detection thresholds for this period.
          </p>
        ) : (
          <ol className="mt-3 space-y-4">
            {[...high, ...rest].map((rec) => (
              <li key={rec.id} className="rounded-lg border border-ink-200 p-4 print-break">
                <div className="flex flex-wrap items-center gap-2">
                  <PriorityBadge priority={rec.finding.priority} />
                  <span className="text-xs text-ink-500">
                    {rec.finding.level === "account" ? "Account-wide" : rec.finding.entityName}
                  </span>
                </div>
                <h3 className="mt-2 text-sm font-semibold text-ink-900">{rec.finding.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-700">{rec.insight.whatHappened}</p>

                <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-ink-600">
                  Recommended next steps
                </p>
                <ol className="mt-1 list-decimal space-y-1 pl-5">
                  {rec.insight.recommendedActions.slice(0, 3).map((action, i) => (
                    <li key={i} className="text-sm leading-relaxed text-ink-700">
                      {action}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="border-t border-ink-200 pt-4 text-xs leading-relaxed text-ink-500">
        <p>
          Prepared with AdMate. Every figure in this report is calculated from the uploaded export;
          possible causes are stated as hypotheses consistent with that data, not as confirmed
          diagnoses. Recommendations are advisory — no advertising campaign was changed in producing
          this report.
        </p>
      </footer>
    </div>
  );
}
