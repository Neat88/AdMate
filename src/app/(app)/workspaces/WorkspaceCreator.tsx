"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, Button, Banner } from "@/components/ui/primitives";

const CURRENCIES = ["USD", "EUR", "GBP", "AUD", "CAD", "SGD", "JPY", "INR", "KHR", "THB", "VND", "PHP"];

export function WorkspaceCreator() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Give the workspace a name.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), currency }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not create that workspace.");
      }
      setName("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create that workspace.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Add a workspace" description="One per client or brand." />
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3 p-5">
        {error ? (
          <div className="w-full">
            <Banner tone="error" title={error} />
          </div>
        ) : null}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-500">Workspace name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Skincare"
            className="w-64 rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-500">Default currency</span>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Creating…" : "Create workspace"}
        </Button>
      </form>
    </Card>
  );
}
