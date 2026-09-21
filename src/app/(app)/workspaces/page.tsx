import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/session";
import { listReports } from "@/lib/db/queries";
import { formatDateTime } from "@/lib/format";
import { Card, CardHeader, PageHeader, Banner } from "@/components/ui/primitives";
import { WorkspaceCreator } from "./WorkspaceCreator";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const reportsByWorkspace = new Map<string, number>();
  for (const report of listReports(session.user.id)) {
    reportsByWorkspace.set(report.workspaceId, (reportsByWorkspace.get(report.workspaceId) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspaces"
        description="Keep each client or brand in its own workspace. Reports, recommendations and alert rules never cross between them."
      />

      <Banner tone="info" title="Why workspaces are separated">
        One client&apos;s advertising data is never used as context when analysing another&apos;s.
        Benchmarks are calculated within a single uploaded report, so a campaign is only ever
        compared against its own account.
      </Banner>

      <Card>
        <CardHeader title="Your workspaces" />
        <ul className="divide-y divide-ink-100">
          {session.workspaces.map((workspace) => (
            <li key={workspace.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink-900">
                  {workspace.name}
                  {workspace.id === session.workspace.id ? (
                    <span className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                      Active
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-ink-500">
                  {workspace.currency} · {reportsByWorkspace.get(workspace.id) ?? 0} report(s) ·
                  created {formatDateTime(workspace.createdAt)}
                </p>
              </div>
              <form action="/api/workspace/switch" method="post">
                <input type="hidden" name="workspaceId" value={workspace.id} />
                <button
                  type="submit"
                  disabled={workspace.id === session.workspace.id}
                  className="rounded-lg border border-ink-300 px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-40"
                >
                  {workspace.id === session.workspace.id ? "Current" : "Switch to"}
                </button>
              </form>
            </li>
          ))}
        </ul>
      </Card>

      <WorkspaceCreator />
    </div>
  );
}
