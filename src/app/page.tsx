import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/db/auth";
import { LinkButton } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

const PILLARS = [
  {
    title: "See what actually happened",
    body: "Upload a CSV or Excel export from Meta, TikTok, Google or LinkedIn. AdMate maps the columns, computes the metrics, and shows performance from account level down to individual ads.",
    detail: "Derived metrics appear only when the inputs exist. A missing value is never rendered as a zero.",
  },
  {
    title: "Understand why",
    body: "Every issue is explained in the same five parts: what happened, the data behind it, why it might be happening, what to do next, and what to watch afterwards.",
    detail: "Possible causes are labelled as hypotheses. AdMate does not state a cause the data cannot support.",
  },
  {
    title: "Decide what to do",
    body: "Issues are ranked by money at stake, not by percentage drama. Mark each one in review, actioned or dismissed, and carry that history across reports.",
    detail: "Recommendations are advisory. AdMate never connects to or modifies a live ad account.",
  },
];

export default async function LandingPage() {
  if (await getCurrentUser()) redirect("/dashboard");

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-ink-200">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:px-6">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white"
          >
            A
          </span>
          <span className="text-lg font-semibold tracking-tight text-ink-900">AdMate</span>
          <nav className="ml-auto flex items-center gap-2">
            <Link href="/login" className="px-3 py-2 text-sm font-medium text-ink-600 hover:text-ink-900">
              Sign in
            </Link>
            <LinkButton href="/signup" size="sm">
              Get started
            </LinkButton>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">
              AI marketing analyst
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink-900 sm:text-5xl">
              Upload your ad report. Understand what&apos;s working, what&apos;s not, and what to do
              next.
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-ink-600">
              AdMate reads the report you already export, finds the campaigns that need attention,
              explains what the numbers suggest, and tells you what to check first — so you spend
              your time deciding rather than reconciling spreadsheets.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton href="/signup">Create a free account</LinkButton>
              <LinkButton href="/login" variant="secondary">
                Sign in
              </LinkButton>
            </div>
            <p className="mt-4 text-sm text-ink-500">
              Includes sample reports, so you can explore the dashboard before uploading anything of
              your own.
            </p>
          </div>
        </section>

        <section className="border-y border-ink-200 bg-ink-50">
          <div className="mx-auto grid max-w-6xl gap-6 px-4 py-14 sm:px-6 md:grid-cols-3">
            {PILLARS.map((pillar) => (
              <div key={pillar.title} className="rounded-xl border border-ink-200 bg-white p-5">
                <h2 className="text-base font-semibold text-ink-900">{pillar.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{pillar.body}</p>
                <p className="mt-3 border-t border-ink-100 pt-3 text-xs leading-relaxed text-ink-500">
                  {pillar.detail}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight text-ink-900">
            Built to be trusted with budget decisions
          </h2>
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            {[
              {
                title: "The maths is not the model's job",
                body: "Every metric, comparison and threshold is computed deterministically from your file. The language model writes the explanation around those numbers, and its output is rejected if it cites a figure the data does not contain.",
              },
              {
                title: "Missing data is said out loud",
                body: "If your export has no conversion column, AdMate says so instead of reporting zero conversions. If a file has no dates, it compares campaigns against each other rather than inventing a trend.",
              },
              {
                title: "Ranked by money, not by drama",
                body: "A 300% CPA rise on a small test budget ranks below a 30% rise on the campaign carrying half your spend. The list is ordered by what is actually at stake.",
              },
              {
                title: "Nothing is changed on your behalf",
                body: "AdMate is advisory. It has no write access to any ad platform, and it never will without an explicit approval step you control.",
              },
            ].map((item) => (
              <div key={item.title} className="rounded-xl border border-ink-200 p-5">
                <h3 className="text-sm font-semibold text-ink-900">{item.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-600">{item.body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-ink-200">
        <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-ink-500 sm:px-6">
          AdMate — an AI marketing analyst for digital marketers, freelancers and agencies.
        </div>
      </footer>
    </div>
  );
}
