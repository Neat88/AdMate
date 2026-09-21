import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/db/auth";
import { getWorkspace } from "@/lib/db/queries";
import { setActiveWorkspace } from "@/lib/session";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url), 303);

  const form = await request.formData();
  const workspaceId = String(form.get("workspaceId") ?? "");

  // Only switch to a workspace this user actually owns.
  if (workspaceId && getWorkspace(user.id, workspaceId)) {
    await setActiveWorkspace(workspaceId);
  }

  const referer = request.headers.get("referer");
  return NextResponse.redirect(referer ?? new URL("/dashboard", request.url), 303);
}
