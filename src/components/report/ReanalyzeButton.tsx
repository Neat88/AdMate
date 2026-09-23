"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/primitives";

/** Re-runs the current analysis engine on the report's stored rows. */
export function ReanalyzeButton({ reportId, label = "Re-analyse with the latest engine" }: { reportId: string; label?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/${reportId}/reanalyze`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Re-analysis failed.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Re-analysis failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <span className="inline-flex flex-col gap-1">
      <Button size="sm" onClick={run} disabled={pending}>
        {pending ? "Analysing…" : label}
      </Button>
      {error ? <span className="text-xs text-high-700">{error}</span> : null}
    </span>
  );
}
