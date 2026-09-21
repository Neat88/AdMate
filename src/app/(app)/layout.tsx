import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/session";
import { dashboardCounts } from "@/lib/db/queries";
import { isAiConfigured } from "@/lib/ai/insights";
import { AppShell } from "@/components/ui/AppShell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const counts = dashboardCounts(session.user.id, session.workspace.id);

  return (
    <AppShell
      user={{ name: session.user.name, email: session.user.email }}
      workspaces={session.workspaces}
      activeWorkspaceId={session.workspace.id}
      highPriorityCount={counts.highPriority}
      alertCount={counts.unacknowledgedAlerts}
      aiConfigured={isAiConfigured()}
    >
      {children}
    </AppShell>
  );
}
