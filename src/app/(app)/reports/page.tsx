import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/session";
import { listReports, getLatestAnalysis, listRecommendationsForAnalysis } from "@/lib/db/queries";
import { PLATFORM_LABELS } from "@/lib/analysis/types";
import { formatDate, formatDateTime } from "@/lib/format";
import { Card, PageHeader, EmptyState, LinkButton, PriorityBadge } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const reports = listReports(session.user.id, session.workspace.id);

  const rows = reports.map((report) => {
    const analysis = getLatestAnalysis(session.user.id, report.id);
    const recs = analysis ? listRecommendationsForAnalysis(session.user.id, analysis.id) : [];
    return {
      report,
      analysis,
      total: recs.length,
      high: recs.filter((r) => r.finding.priority === "high").length,
      open: recs.filter((r) => r.status === "new" || r.status === "in_review").length,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description={`Every report analysed in “${session.workspace.name}”. Open one to revisit its metrics and recommendations.`}
        action={<LinkButton href="/upload">Upload report</LinkButton>}
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No reports yet"
          description="Upload a CSV or Excel export to get your first analysis."
          action={<LinkButton href="/upload">Upload a report</LinkButton>}
        />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50 text-left">
                  {["Report", "Platform", "Period", "Rows", "Findings", "Open", "Analysed"].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="whitespace-nowrap px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-600"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ report, total, high, open }) => (
                  <tr key={report.id} className="border-b border-ink-100 last:border-0 hover:bg-ink-50/60">
                    <th scope="row" className="max-w-[260px] px-4 py-3 text-left font-medium">
                      <Link
                        href={`/reports/${report.id}`}
                        className="block truncate text-brand-600 hover:underline"
                        title={report.filename}
                      >
                        {report.filename}
                      </Link>
                    </th>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-600">
                      {PLATFORM_LABELS[report.platform]}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-600">
                      {report.periodStart && report.periodEnd
                        ? `${formatDate(report.periodStart)} – ${formatDate(report.periodEnd)}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-ink-600 tnum">{report.rowCount.toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <span className="text-ink-700 tnum">{total}</span>
                      {high > 0 ? (
                        <span className="ml-2 inline-block align-middle">
                          <PriorityBadge priority="high" />
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-ink-600 tnum">{open}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-500">
                      {formatDateTime(report.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
