import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/session";
import { listAllRecommendations, listReports, type RecommendationStatus } from "@/lib/db/queries";
import { PageHeader, EmptyState, LinkButton, Card } from "@/components/ui/primitives";
import { InsightCard } from "@/components/ui/InsightCard";

export const dynamic = "force-dynamic";

const STATUS_TABS: { value: RecommendationStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "in_review", label: "In review" },
  { value: "action_taken", label: "Action taken" },
  { value: "dismissed", label: "Dismissed" },
];

const PRIORITY_TABS = [
  { value: "", label: "Any priority" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

/**
 * The cross-report tracker: which issues were raised, and what the marketer
 * actually did about them. Recommendations are advisory only — AdMate records
 * the decision, it never executes it.
 */
export default async function RecommendationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; priority?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const status = (STATUS_TABS.find((t) => t.value === sp.status)?.value ?? "all") as
    | RecommendationStatus
    | "all";
  const priority = PRIORITY_TABS.find((t) => t.value === sp.priority)?.value ?? "";

  const recommendations = listAllRecommendations(session.user.id, {
    status: status === "all" ? undefined : status,
    priority: priority || undefined,
    workspaceId: session.workspace.id,
  });

  const reports = listReports(session.user.id, session.workspace.id);
  const currencyByReport = new Map(reports.map((r) => [r.id, r.currency]));
  const filenameByReport = new Map(reports.map((r) => [r.id, r.filename]));

  const all = listAllRecommendations(session.user.id, { workspaceId: session.workspace.id });
  const counts = {
    all: all.length,
    new: all.filter((r) => r.status === "new").length,
    in_review: all.filter((r) => r.status === "in_review").length,
    action_taken: all.filter((r) => r.status === "action_taken").length,
    dismissed: all.filter((r) => r.status === "dismissed").length,
  };

  const buildHref = (next: { status?: string; priority?: string }) => {
    const params = new URLSearchParams();
    const s = next.status ?? (status === "all" ? "" : status);
    const p = next.priority ?? priority;
    if (s) params.set("status", s);
    if (p) params.set("priority", p);
    const qs = params.toString();
    return `/recommendations${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recommendations"
        description="Everything AdMate has flagged in this workspace, with the status you set. AdMate never changes campaigns — you act in the ad platform and record the outcome here."
        action={<LinkButton href="/upload">Upload report</LinkButton>}
      />

      <Card className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
        <FilterGroup
          label="Status"
          options={STATUS_TABS.map((t) => ({
            ...t,
            label: `${t.label} (${counts[t.value as keyof typeof counts]})`,
          }))}
          active={status}
          href={(v) => buildHref({ status: v === "all" ? "" : String(v) })}
        />
        <FilterGroup
          label="Priority"
          options={PRIORITY_TABS}
          active={priority}
          href={(v) => buildHref({ priority: String(v) })}
        />
      </Card>

      {recommendations.length === 0 ? (
        <EmptyState
          title="Nothing here"
          description={
            all.length === 0
              ? "Upload a report and AdMate will populate this list with what it finds."
              : "No recommendations match these filters."
          }
          action={
            all.length === 0 ? (
              <LinkButton href="/upload">Upload a report</LinkButton>
            ) : (
              <LinkButton href="/recommendations" variant="secondary">
                Clear filters
              </LinkButton>
            )
          }
        />
      ) : (
        <div className="space-y-3">
          {recommendations.map((rec) => (
            <div key={rec.id}>
              <p className="mb-1 text-xs text-ink-500">
                From{" "}
                <Link href={`/reports/${rec.reportId}`} className="font-medium text-brand-600 hover:underline">
                  {filenameByReport.get(rec.reportId) ?? "a report"}
                </Link>
              </p>
              <InsightCard
                finding={rec.finding}
                insight={rec.insight}
                currency={currencyByReport.get(rec.reportId) ?? "USD"}
                recommendationId={rec.id}
                status={rec.status}
                note={rec.note}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterGroup({
  label,
  options,
  active,
  href,
}: {
  label: string;
  options: { value: string; label: string }[];
  active: string;
  href: (value: string) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</span>
      {options.map((opt) => (
        <Link
          key={opt.value}
          href={href(opt.value)}
          aria-current={active === opt.value ? "true" : undefined}
          className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
            active === opt.value
              ? "bg-brand-600 text-white"
              : "bg-ink-100 text-ink-600 hover:bg-ink-200"
          }`}
        >
          {opt.label}
        </Link>
      ))}
    </div>
  );
}
