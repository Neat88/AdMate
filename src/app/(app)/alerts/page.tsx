import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/session";
import { listAlertRules, listAlertEvents } from "@/lib/db/queries";
import { formatDateTime } from "@/lib/format";
import { Card, CardHeader, PageHeader, Banner, EmptyState, LinkButton } from "@/components/ui/primitives";
import { AlertRuleManager } from "./AlertRuleManager";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const rules = listAlertRules(session.user.id, session.workspace.id);
  const events = listAlertEvents(session.user.id, 50);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alerts"
        description="Tell AdMate what matters to you, and it will check those thresholds every time you analyse a report."
        action={<LinkButton href="/upload">Upload report</LinkButton>}
      />

      <Banner tone="info" title="How monitoring works in this version">
        AdMate does not connect to your ad accounts, so it cannot watch them continuously. Rules are
        evaluated at the moment you upload and analyse a report. Continuous monitoring needs live
        platform integrations, which are not part of this MVP.
      </Banner>

      <AlertRuleManager
        rules={rules}
        workspaceId={session.workspace.id}
        currency={session.workspace.currency}
      />

      <Card>
        <CardHeader
          title="Triggered alerts"
          description="Thresholds crossed in the reports you have analysed, most recent first."
        />
        {events.length === 0 ? (
          <EmptyState
            title="No alerts triggered yet"
            description="Once you analyse a report, any rule whose threshold is crossed will appear here."
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {events.map((event) => (
              <li key={event.id} className={`px-5 py-3 ${event.acknowledged ? "opacity-60" : ""}`}>
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 ${event.severity === "high" ? "text-high-500" : "text-med-500"}`}
                  >
                    {event.severity === "high" ? "▲" : "◆"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-relaxed text-ink-800">{event.message}</p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {event.severity === "high" ? "High" : "Medium"} severity ·{" "}
                      <Link href={`/reports/${event.reportId}`} className="text-brand-600 hover:underline">
                        {event.reportFilename}
                      </Link>{" "}
                      · {formatDateTime(event.createdAt)}
                      {event.acknowledged ? " · acknowledged" : ""}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-ink-900">Planned for later versions</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-600">
          <li>Direct Meta, TikTok, Google and LinkedIn API connections for continuous monitoring.</li>
          <li>Delivery to Slack, email and Telegram rather than only in-app.</li>
          <li>Scheduled client report delivery.</li>
        </ul>
        <p className="mt-2 text-xs text-ink-500">
          These are not built. They are listed so the current scope is unambiguous.
        </p>
      </Card>
    </div>
  );
}
