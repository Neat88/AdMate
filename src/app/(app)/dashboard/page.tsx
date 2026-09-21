import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/session";
import {
  listReports,
  dashboardCounts,
  getLatestAnalysis,
  listRecommendationsForAnalysis,
  listAlertEvents,
} from "@/lib/db/queries";
import { deserializeModel, accountKpis } from "@/lib/analysis/pipeline";
import { getAnalysisModel } from "@/lib/db/queries";
import { isAiConfigured } from "@/lib/ai/insights";
import { PLATFORM_LABELS } from "@/lib/analysis/types";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  Card,
  CardHeader,
  PageHeader,
  EmptyState,
  LinkButton,
  Banner,
  PriorityBadge,
} from "@/components/ui/primitives";
import { KpiCard, KpiGrid } from "@/components/ui/KpiCard";
import { InsightCard } from "@/components/ui/InsightCard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const { user, workspace } = session;
  const reports = listReports(user.id, workspace.id);
  const counts = dashboardCounts(user.id, workspace.id);
  const alerts = listAlertEvents(user.id, 5).filter((a) => !a.acknowledged);

  if (reports.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={`Welcome, ${user.name.split(" ")[0]}`}
          description="Upload your ad report. Understand what's working, what's not, and what to do next."
        />
        <EmptyState
          icon={<span className="text-3xl">▦</span>}
          title="No reports in this workspace yet"
          description="Upload a CSV or Excel export from Meta, TikTok, Google or LinkedIn Ads. AdMate will map the columns, calculate the metrics, and tell you what needs attention."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <LinkButton href="/upload">Upload a report</LinkButton>
              <LinkButton href="/upload?sample=1" variant="secondary">
                Try it with sample data
              </LinkButton>
            </div>
          }
        />
        <HowItWorks />
      </div>
    );
  }

  const latest = reports[0];
  const analysis = getLatestAnalysis(user.id, latest.id);
  const modelJson = analysis ? getAnalysisModel(user.id, analysis.id) : null;
  const model = modelJson ? deserializeModel(modelJson) : null;
  const recommendations = analysis ? listRecommendationsForAnalysis(user.id, analysis.id) : [];
  const openRecs = recommendations.filter((r) => r.status === "new" || r.status === "in_review");
  const kpis = model ? accountKpis(model) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description={
          <>
            Latest report:{" "}
            <Link href={`/reports/${latest.id}`} className="font-medium text-brand-600 hover:underline">
              {latest.filename}
            </Link>{" "}
            · {PLATFORM_LABELS[latest.platform]} ·{" "}
            {latest.periodStart && latest.periodEnd
              ? `${formatDate(latest.periodStart)} – ${formatDate(latest.periodEnd)}`
              : "period not specified"}
          </>
        }
        action={<LinkButton href="/upload">Upload new report</LinkButton>}
      />

      {!isAiConfigured() ? (
        <Banner tone="info" title="Running the built-in analyst">
          No <code className="rounded bg-white/60 px-1">ANTHROPIC_API_KEY</code> is set, so insight
          narratives come from AdMate&apos;s deterministic templates. Every metric, finding and
          priority on this page is calculated the same way either — setting a key changes only how
          the explanations are written.
        </Banner>
      ) : null}

      {analysis?.fallbackReason ? (
        <Banner tone="warning" title="Some insights fell back to the built-in analyst">
          {analysis.fallbackReason}
        </Banner>
      ) : null}

      <SummaryRow counts={counts} reportCount={reports.length} />

      {analysis ? (
        <Card>
          <CardHeader
            title="What this report says"
            description={`Analysed ${formatDateTime(analysis.createdAt)} · ${
              analysis.engine === "claude" ? "Narrated by Claude" : "Built-in analyst"
            }`}
          />
          <p className="px-5 py-4 text-sm leading-relaxed text-ink-700">{analysis.summary}</p>
        </Card>
      ) : null}

      {kpis.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink-900">
            Account performance
            <span className="ml-2 font-normal text-ink-500">
              — only metrics present in the uploaded file are shown
            </span>
          </h2>
          <KpiGrid>
            {kpis.map(({ metric, value }) => (
              <KpiCard
                key={metric}
                metric={metric}
                value={value}
                currency={latest.currency}
                comparison={model?.account.periodComparison}
              />
            ))}
          </KpiGrid>
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="min-w-0 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-900">Needs your attention</h2>
            <Link href="/recommendations" className="text-sm font-medium text-brand-600 hover:underline">
              View all {recommendations.length} →
            </Link>
          </div>
          {openRecs.length === 0 ? (
            <EmptyState
              title="Nothing open right now"
              description="Every recommendation from this report has been reviewed, actioned or dismissed."
            />
          ) : (
            <div className="space-y-3">
              {openRecs.slice(0, 4).map((rec) => (
                <InsightCard
                  key={rec.id}
                  finding={rec.finding}
                  insight={rec.insight}
                  currency={latest.currency}
                  recommendationId={rec.id}
                  status={rec.status}
                  note={rec.note}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="min-w-0 space-y-6">
          <Card>
            <CardHeader
              title="Alerts triggered"
              description="Evaluated when this report was analysed."
              action={
                <Link href="/alerts" className="text-xs font-medium text-brand-600 hover:underline">
                  Manage
                </Link>
              }
            />
            {alerts.length === 0 ? (
              <p className="px-5 py-6 text-sm text-ink-500">
                No alert thresholds were crossed in your latest report.
              </p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {alerts.map((alert) => (
                  <li key={alert.id} className="px-5 py-3">
                    <div className="flex items-start gap-2">
                      <span
                        aria-hidden="true"
                        className={alert.severity === "high" ? "text-high-500" : "text-med-500"}
                      >
                        {alert.severity === "high" ? "▲" : "◆"}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm leading-relaxed text-ink-700">{alert.message}</p>
                        <p className="mt-0.5 text-xs text-ink-400">
                          {alert.severity === "high" ? "High" : "Medium"} ·{" "}
                          {formatDateTime(alert.createdAt)}
                        </p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Recent reports" action={
              <Link href="/reports" className="text-xs font-medium text-brand-600 hover:underline">
                All reports
              </Link>
            } />
            <ul className="divide-y divide-ink-100">
              {reports.slice(0, 5).map((report) => (
                <li key={report.id}>
                  <Link
                    href={`/reports/${report.id}`}
                    className="block px-5 py-3 hover:bg-ink-50"
                  >
                    <p className="truncate text-sm font-medium text-ink-900">{report.filename}</p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {PLATFORM_LABELS[report.platform]} · {report.rowCount.toLocaleString()} rows ·{" "}
                      {formatDateTime(report.createdAt)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function SummaryRow({
  counts,
  reportCount,
}: {
  counts: { openRecommendations: number; highPriority: number; unacknowledgedAlerts: number };
  reportCount: number;
}) {
  const tiles = [
    { label: "Reports analysed", value: reportCount, href: "/reports" },
    { label: "Open recommendations", value: counts.openRecommendations, href: "/recommendations" },
    {
      label: "High priority",
      value: counts.highPriority,
      href: "/recommendations?priority=high",
      badge: counts.highPriority > 0,
    },
    { label: "Unread alerts", value: counts.unacknowledgedAlerts, href: "/alerts" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <Link
          key={tile.label}
          href={tile.href}
          className="rounded-xl border border-ink-200 bg-white px-4 py-3 transition-colors hover:border-brand-300 hover:bg-brand-50/40"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{tile.label}</p>
          <p className="mt-1 flex items-center gap-2 text-2xl font-semibold text-ink-900 tnum">
            {tile.value}
            {tile.badge ? <PriorityBadge priority="high" /> : null}
          </p>
        </Link>
      ))}
    </div>
  );
}

function HowItWorks() {
  const steps = [
    {
      title: "1. Upload",
      body: "Export a CSV or Excel report from your ad platform. AdMate identifies the platform and maps the columns for you — you confirm before anything is analysed.",
    },
    {
      title: "2. Analyse",
      body: "Metrics are calculated deterministically from your file. Derived metrics like CPA and ROAS appear only when the inputs they need are actually present.",
    },
    {
      title: "3. Decide",
      body: "Issues are ranked by money at stake. Each one explains what happened, what the evidence is, why it might be happening, what to do, and what to watch next.",
    },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {steps.map((step) => (
        <Card key={step.title} className="p-5">
          <h3 className="text-sm font-semibold text-ink-900">{step.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-600">{step.body}</p>
        </Card>
      ))}
    </div>
  );
}
