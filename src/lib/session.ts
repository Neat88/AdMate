import { cookies } from "next/headers";
import { getCurrentUser, type User } from "@/lib/db/auth";
import { listWorkspaces, createWorkspace, type Workspace } from "@/lib/db/queries";

const WORKSPACE_COOKIE = "admate_workspace";

export interface SessionContext {
  user: User;
  workspaces: Workspace[];
  workspace: Workspace;
}

/**
 * Resolves the signed-in user and their active workspace.
 *
 * The active workspace comes from a cookie, but is always re-validated against
 * the user's own workspaces - a tampered cookie falls back to the first
 * workspace rather than granting access to someone else's.
 */
export async function getSessionContext(): Promise<SessionContext | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  let workspaces = listWorkspaces(user.id);
  if (workspaces.length === 0) {
    workspaces = [createWorkspace(user.id, "My workspace")];
  }

  const store = await cookies();
  const requested = store.get(WORKSPACE_COOKIE)?.value;
  const workspace = workspaces.find((w) => w.id === requested) ?? workspaces[0];

  return { user, workspaces, workspace };
}

export async function setActiveWorkspace(workspaceId: string): Promise<void> {
  const store = await cookies();
  store.set(WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 365 * 86400,
  });
}
