import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, UnauthorizedError } from "@/lib/db/auth";
import { createAlertRule, deleteAlertRule, setAlertRuleEnabled, getWorkspace } from "@/lib/db/queries";

const createSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  metric: z.enum([
    "impressions", "reach", "clicks", "spend", "conversions", "revenue", "frequency",
    "videoViews", "ctr", "cpc", "cpm", "cpa", "roas", "cvr", "aov",
  ]),
  comparator: z.enum(["above", "below", "increases_by", "decreases_by", "spend_without_conversions"]),
  threshold: z.number().finite().nonnegative(),
  scope: z.enum(["account", "campaign", "adset", "ad"]),
  entityFilter: z.string().trim().max(120).nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }
    if (!getWorkspace(user.id, parsed.data.workspaceId)) {
      return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
    }

    const rule = createAlertRule(user.id, {
      workspaceId: parsed.data.workspaceId,
      name: parsed.data.name,
      metric: parsed.data.metric,
      comparator: parsed.data.comparator,
      threshold: parsed.data.threshold,
      scope: parsed.data.scope,
      entityFilter: parsed.data.entityFilter ?? null,
      enabled: true,
    });
    return NextResponse.json({ ok: true, rule });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Could not create that rule." }, { status: 500 });
  }
}

const patchSchema = z.object({ id: z.string().min(1), enabled: z.boolean() });

export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

    const ok = setAlertRuleEnabled(user.id, parsed.data.id, parsed.data.enabled);
    if (!ok) return NextResponse.json({ error: "Rule not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Could not update that rule." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing rule id." }, { status: 400 });

    const ok = deleteAlertRule(user.id, id);
    if (!ok) return NextResponse.json({ error: "Rule not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Could not delete that rule." }, { status: 500 });
  }
}
