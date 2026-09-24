import Link from "next/link";
import type { HistoryComparison, MetricChange } from "@/lib/analysis/history";
import type { Objective } from "@/lib/analysis/objectives";
import { metricLabel } from "@/lib/analysis/objectives";
import { formatDate, formatMetric } from "@/lib/format";
import { DeltaChip } from "@/components/ui/primitives";
import { AskButton } from "@/components/assistant/AskButton";

/**
 * "Compared with your previous upload" - the real previous period, once the
 * user uploads regularly. Totals are per day when the two files cover
 * different lengths of time; each change says whether it is likely real.
 */
export function VsPreviousUpload({
  history,
  objective,
  currency,
}: {
  history: HistoryComparison;
  objective: Objective | "mixed";
  currency: string;
}) {
  const p = history.previous;
  const period = p.periodStart && p.periodEnd ? `${formatDate(p.periodStart)} – ${formatDate(p.periodEnd)}` : `uploaded ${formatDate(p.createdAt)}`;
  const moved = history.campaigns
    .filter((c) => c.cost?.changePct != null && Math.abs(c.cost.changePct) >= 0.01)
    .sort((a, b) => Math.abs(b.cost!.changePct!) - Math.abs(a.cost!.changePct!))
    .slice(0, 6);

  return (
    <section aria-labelledby="history-heading" className="rounded-xl border border-ink-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-ink-100 px-5 py-4">
        <div className="min-w-0">
          <h2 id="history-heading" className="text-sm font-semibold text-ink-900">
            Compared with your previous upload
          </h2>
          <p className="mt-0.5 text-xs text-ink-500">
            <Link href={`/reports/${p.id}`} className="font-medium text-brand-600 hover:underline">
              {p.filename}
            </Link>{" "}
            · {period}
            {history.previousDays && history.currentDays && history.previousDays !== history.currentDays
              ? ` · ${history.previousDays} vs ${history.currentDays} days, so totals are shown per day`
              : ""}
          </p>
        </div>
        <AskButton focus={{ kind: "report" }} question="How does this compare with my previous upload?" label="Ask" />
      </div>

      <dl className="flex flex-wrap gap-px bg-ink-100">
        {history.account.map((m) => (
          <div key={`${m.metric}-${m.scope ?? ""}`} className="min-w-[150px] flex-1 basis-[150px] bg-white px-4 py-3">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-500">
              {metricLabel(m.metric, objective)}
              {m.perDay ? " / day" : ""}
              {m.scope ? <span className="block normal-case tracking-normal text-ink-400">{m.scope}</span> : null}
            </dt>
            <dd className="mt-1 text-base font-semibold text-ink-900 tnum">{formatMetric(m.current, m.metric, currency)}</dd>
            <dd className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-ink-500 tnum">
              <DeltaChip change={m.changePct} isGood={m.worsened === null ? null : !m.worsened} />
              <span>from {formatMetric(m.previous, m.metric, currency)}</span>
            </dd>
            <Strength change={m} />
          </div>
        ))}
      </dl>

      {moved.length > 0 ? (
        <div className="relative overflow-x-auto border-t border-ink-100">
          <table className="w-full min-w-[520px] text-sm">
            <caption className="sr-only">Campaign changes since the previous upload</caption>
            <thead>
              <tr className="bg-ink-50 text-left text-xs font-semibold uppercase tracking-wide text-ink-600">
                <th scope="col" className="px-4 py-2">Campaign</th>
                <th scope="col" className="px-4 py-2 text-right">Main KPI</th>
                <th scope="col" className="px-4 py-2 text-right">Change</th>
                <th scope="col" className="px-4 py-2 text-right">Spend{history.account[0]?.perDay ? " / day" : ""}</th>
              </tr>
            </thead>
            <tbody>
              {moved.map((c) => (
                <tr key={c.name} className="border-t border-ink-100">
                  <th scope="row" className="max-w-[220px] truncate px-4 py-2 text-left font-medium text-ink-900" title={c.name}>
                    {c.name}
                  </th>
                  <td className="px-4 py-2 text-right tnum">
                    <span className="block text-[10px] uppercase tracking-wide text-ink-500">{metricLabel(c.cost!.metric, c.objective)}</span>
                    {formatMetric(c.cost!.previous, c.cost!.metric, currency)} → {formatMetric(c.cost!.current, c.cost!.metric, currency)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <DeltaChip change={c.cost!.changePct} isGood={c.cost!.worsened === null ? null : !c.cost!.worsened} />
                    <Strength change={c.cost!} inline />
                  </td>
                  <td className="px-4 py-2 text-right tnum text-ink-700">
                    {formatMetric(c.spend.current, "spend", currency)}
                    <DeltaChip change={c.spend.changePct} isGood={null} className="ml-1" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {moved.length === 0 ? (
        <p className="border-t border-ink-100 px-5 py-3 text-xs text-ink-600">
          No campaign&apos;s main KPI moved by more than 1% since the previous upload.
        </p>
      ) : null}

      {history.newCampaigns.length > 0 || history.stoppedCampaigns.length > 0 ? (
        <div className="space-y-1 border-t border-ink-100 px-5 py-3 text-xs text-ink-600">
          {history.newCampaigns.length > 0 ? (
            <p>
              <span className="font-medium text-ink-800">New since last upload:</span> {history.newCampaigns.join(", ")}
            </p>
          ) : null}
          {history.stoppedCampaigns.length > 0 ? (
            <p>
              <span className="font-medium text-ink-800">Not in this upload:</span> {history.stoppedCampaigns.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const STRENGTH_TEXT = { strong: "likely real", moderate: "probably real", weak: "could be noise" } as const;

function Strength({ change, inline = false }: { change: MetricChange; inline?: boolean }) {
  if (!change.strength || change.changePct === null) return null;
  return (
    <span className={`${inline ? "ml-1 inline" : "mt-0.5 block"} text-[10px] text-ink-500`}>{STRENGTH_TEXT[change.strength]}</span>
  );
}
