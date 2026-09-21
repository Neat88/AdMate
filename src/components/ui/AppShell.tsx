"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { Workspace } from "@/lib/db/queries";

interface NavItem {
  href: string;
  label: string;
  glyph: string;
  badge?: number;
}

export function AppShell({
  children,
  user,
  workspaces,
  activeWorkspaceId,
  highPriorityCount,
  alertCount,
  aiConfigured,
}: {
  children: React.ReactNode;
  user: { name: string; email: string };
  workspaces: Workspace[];
  activeWorkspaceId: string;
  highPriorityCount: number;
  alertCount: number;
  aiConfigured: boolean;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const nav: NavItem[] = [
    { href: "/dashboard", label: "Dashboard", glyph: "▤" },
    { href: "/reports", label: "Reports", glyph: "▦" },
    { href: "/recommendations", label: "Recommendations", glyph: "◈", badge: highPriorityCount },
    { href: "/alerts", label: "Alerts", glyph: "◉", badge: alertCount },
    { href: "/upload", label: "Upload report", glyph: "↑" },
  ];

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const navList = (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {nav.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          onClick={() => setMobileOpen(false)}
          aria-current={isActive(item.href) ? "page" : undefined}
          className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
            isActive(item.href)
              ? "bg-brand-50 font-semibold text-brand-700"
              : "text-ink-600 hover:bg-ink-100 hover:text-ink-900"
          }`}
        >
          <span aria-hidden="true" className="w-4 text-center text-ink-400">
            {item.glyph}
          </span>
          <span className="flex-1">{item.label}</span>
          {item.badge && item.badge > 0 ? (
            <span className="rounded-full bg-high-500 px-1.5 py-0.5 text-[10px] font-bold text-white tnum">
              {item.badge > 99 ? "99+" : item.badge}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-ink-200 bg-white/90 backdrop-blur no-print">
        <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
          <button
            type="button"
            className="-ml-1 rounded-lg p-2 text-ink-600 hover:bg-ink-100 lg:hidden"
            onClick={() => setMobileOpen((v) => !v)}
            aria-expanded={mobileOpen}
            aria-label="Toggle navigation"
          >
            <span aria-hidden="true">☰</span>
          </button>

          <Link href="/dashboard" className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white"
            >
              A
            </span>
            <span className="text-base font-semibold tracking-tight text-ink-900">AdMate</span>
          </Link>

          <WorkspaceSelector workspaces={workspaces} activeId={activeWorkspaceId} />

          <div className="ml-auto flex items-center gap-3">
            <EngineIndicator aiConfigured={aiConfigured} />
            <UserMenu user={user} />
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        {/* Desktop sidebar */}
        <aside className="hidden w-60 shrink-0 border-r border-ink-200 bg-white p-3 lg:block no-print">
          <div className="sticky top-[4.5rem]">
            {navList}
            <div className="mt-6 rounded-lg border border-ink-200 bg-ink-50 p-3">
              <p className="text-xs font-semibold text-ink-700">How AdMate works</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                Every figure you see is calculated from your uploaded file. The AI explains those
                figures — it never produces them.
              </p>
            </div>
          </div>
        </aside>

        {/* Mobile drawer */}
        {mobileOpen ? (
          <div className="fixed inset-0 z-20 lg:hidden no-print">
            <button
              type="button"
              aria-label="Close navigation"
              className="absolute inset-0 bg-ink-900/30"
              onClick={() => setMobileOpen(false)}
            />
            <div className="absolute left-0 top-14 bottom-0 w-64 border-r border-ink-200 bg-white p-3">
              {navList}
            </div>
          </div>
        ) : null}

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[1400px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

function WorkspaceSelector({ workspaces, activeId }: { workspaces: Workspace[]; activeId: string }) {
  if (workspaces.length === 0) return null;
  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];

  return (
    <div className="hidden items-center gap-2 sm:flex">
      <span aria-hidden="true" className="text-ink-300">
        /
      </span>
      <form action="/api/workspace/switch" method="post">
        <label className="sr-only" htmlFor="workspace-select">
          Workspace
        </label>
        <select
          id="workspace-select"
          name="workspaceId"
          defaultValue={active.id}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className="rounded-lg border border-ink-200 bg-white px-2 py-1 text-sm font-medium text-ink-700 hover:bg-ink-50"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.currency})
            </option>
          ))}
        </select>
      </form>
    </div>
  );
}

/**
 * States plainly which analysis engine is active. Users should never have to
 * guess whether they are seeing LLM-written narrative or the built-in
 * deterministic wording.
 */
function EngineIndicator({ aiConfigured }: { aiConfigured: boolean }) {
  return (
    <span
      title={
        aiConfigured
          ? "ANTHROPIC_API_KEY is set. Insight narratives are written by Claude from the metrics AdMate calculated."
          : "No ANTHROPIC_API_KEY is set. AdMate is running its built-in deterministic analyst — the same findings and the same numbers, with template-written explanations."
      }
      className="hidden items-center gap-1.5 rounded-full border border-ink-200 bg-white px-2.5 py-1 text-xs font-medium text-ink-600 md:inline-flex"
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${aiConfigured ? "bg-good-500" : "bg-med-500"}`}
      />
      {aiConfigured ? "Claude analyst" : "Local analyst"}
    </span>
  );
}

function UserMenu({ user }: { user: { name: string; email: string } }) {
  const [open, setOpen] = useState(false);
  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-lg p-1 hover:bg-ink-100"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink-800 text-xs font-semibold text-white">
          {initials || "?"}
        </span>
        <span className="hidden text-sm font-medium text-ink-700 sm:inline">{user.name}</span>
        <span aria-hidden="true" className="text-xs text-ink-400">
          ▾
        </span>
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-ink-200 bg-white py-1 shadow-lg"
          >
            <div className="border-b border-ink-100 px-3 py-2">
              <p className="truncate text-sm font-medium text-ink-900">{user.name}</p>
              <p className="truncate text-xs text-ink-500">{user.email}</p>
            </div>
            <Link
              href="/workspaces"
              role="menuitem"
              className="block px-3 py-2 text-sm text-ink-700 hover:bg-ink-50"
              onClick={() => setOpen(false)}
            >
              Manage workspaces
            </Link>
            <form action="/api/auth/logout" method="post">
              <button
                type="submit"
                role="menuitem"
                className="w-full px-3 py-2 text-left text-sm text-ink-700 hover:bg-ink-50"
              >
                Sign out
              </button>
            </form>
          </div>
        </>
      ) : null}
    </div>
  );
}
