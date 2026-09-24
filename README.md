# AdMate

**Upload your ad report. Understand what's working, what's not, and what to do next.**

AdMate is an AI marketing analyst for digital marketers, freelancers and agencies. You upload the
advertising report you already export from Meta, TikTok, Google or LinkedIn Ads; AdMate parses it,
calculates the metrics, finds what needs attention, explains what the data suggests, and tells you
what to check first.

It is deliberately **advisory only**. AdMate has no write access to any ad platform and never
changes a live campaign.

---

## Quick start

```bash
npm install
npm run seed        # creates data/admate.db and a demo account with sample analyses
npm run dev         # http://localhost:3000
```

Sign in with the seeded demo account:

```
email:    demo@admate.app
password: admate-demo-2026
```

Or create your own account at `/signup` and upload one of the files in `sample-data/`.

### Deploying it somewhere public

See **[DEPLOY.md](DEPLOY.md)**. Short version: AdMate stores data in SQLite, so it
needs a host with a **persistent volume** — Railway, Render, Fly.io or any Docker
host. It will **not** run on Vercel or other serverless platforms without moving
the database layer to Postgres first, because their filesystems are read-only.

A `Dockerfile` plus `railway.json`, `render.yaml` and `fly.toml` are included.

### Running in production mode

```bash
cp .env.example .env.local
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('hex'))" >> .env.local
npm run build && npm start
```

`SESSION_SECRET` is **required** in production — AdMate refuses to sign session cookies with a
built-in default and will return a clear 503 from the auth routes rather than start insecurely.

### Other commands

| Command | What it does |
| --- | --- |
| `npm test` | Runs the analysis-engine, assistant, feature and AI-validation test suites (64 tests) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run build` | Production build |
| `npm run db:reset` | Deletes the database and re-seeds |
| `npx tsx scripts/generate-samples.ts` | Regenerates the sample reports |

---

## What is functional, what is simulated, what needs credentials

This section is deliberately precise. Nothing below is overstated.

### Fully functional, no external services required

- **Account signup / sign-in / sessions** — scrypt password hashing, HMAC-signed HttpOnly session
  cookies, server-side session records.
- **Workspaces** — one per client or brand, with per-workspace currency. All data is scoped by
  workspace and by user.
- **File upload and parsing** — CSV, TSV, XLSX and XLS. Handles the banner rows, totals rows,
  thousands separators, European decimal commas, currency symbols, parenthesised negatives,
  percentage cells and Excel serial dates that real platform exports contain.
- **Automatic column mapping** — a scoring matcher across ~90 header synonyms, resolved globally so
  one canonical metric is never claimed by two columns. You review and correct it before anything
  is analysed.
- **Platform detection** — infers Meta / TikTok / Google / LinkedIn from the header vocabulary.
- **Data validation** — duplicate rows, unreadable numbers and dates, negative values, clicks
  exceeding impressions, missing spend, absent conversion tracking, row-cap truncation.
- **Metric calculation** — deterministic, in `src/lib/analysis/metrics.ts`.
- **Issue detection** — 14 detectors producing evidence-backed findings, ranked by money at stake.
- **Insight generation** — the five-part framework, rendered by the built-in analyst with no API key.
- **Recommendation tracking** — New / In review / Action taken / Dismissed, persisted and filterable
  across reports.
- **Custom alert rules** — metric, condition, threshold, scope, name filter; evaluated on analysis.
- **Client report** — a print/PDF-ready summary at `/reports/[id]/share`.
- **Sample data** — four reports with known planted problems, loadable from the upload page.

### The report: what, why, now what

Each report opens on a **briefing** - one sentence on what happened, the biggest problem,
biggest improvement, best opportunity and how far to trust the data - followed by:

- **What to do** - one card per problem, grouped into *Critical*, *Needs attention*,
  *Monitor* and *Performing well*. Each card names one action from a fixed vocabulary
  (check tracking, reduce or pause, refresh creative, adjust audience, check the landing
  page, rebalance budget, investigate, scale gradually, wait for data, keep running),
  the alternatives if that action isn't an option, and when to look again.
- **Why am I seeing this?** - every gate the finding passed (objective, size of change,
  spend at stake, statistical test), with the observed value and the rule.
- **What changed** - each headline metric's change split *exactly* into the campaigns,
  ad sets or ads that caused it, and whether each one got worse itself or took more budget.
- **Ask AdMate** - an assistant attached to the report. "Ask" buttons on every KPI, card,
  table row and driver open it with that context already selected, so "should I pause
  it?" needs no explanation of what "it" is.

### How the engine decides (v2)

- **Objectives per campaign.** Resolved from a result-type column, then the campaign name
  ("LEADS", "Traffic", "Brand Awareness"...), then the objective chosen at upload, then the
  data. The source is always shown. Campaigns are judged only on their objective's metrics
  and compared only with campaigns sharing that objective - an awareness campaign with
  zero conversions is not "wasting budget".
- **Statistical checks.** Period changes use an exact conditional binomial test on the
  underlying counts; zero-conversion calls use the account's own conversion rate to ask
  whether zero is surprising. Signals that clear the percentage threshold but not the
  test become **Monitor** items that say how much more data would settle them.
- **Diagnoses, not signal lists.** Several signals on one entity (CPA up, CTR down,
  frequency 4.6) become one card ("Creative fatigue likely") with one action. "Pause"
  requires strong evidence; a possible tracking fault always comes first.

### The assistant

- The model never sees the whole report. For each question AdMate resolves which
  entities and metrics are in play (the clicked element, names and metric words in the
  question, the conversation's last focus) and sends a compact context pack, plus
  read-only tools to look up an entity, break a change down, read a daily trend or
  compare entities - all scoped server-side to the one report the user owns.
- Answers come back as *what happened / the numbers / what it likely means / what to
  consider / confidence & limits*, and are validated before display: every figure must
  be in the data provided, every quoted name must exist in the report, and promised
  outcomes are rejected. A failing answer gets one corrective retry, then the built-in
  analyst answers instead. Answers are sent whole (not streamed token by token) so an
  unvalidated number is never on screen; progress is streamed instead.
- Without an API key, suggested questions are answered by the built-in analyst and
  free-text input is disabled. With a key, there is a per-user daily limit
  (`ADMATE_AI_DAILY_LIMIT`) and a per-minute rate limit.
- Conversations are stored per report and deleted with it.

Reports analysed before v2 show an "analysed with an earlier version" banner with a
**Re-analyse** button that re-runs the engine on the stored rows (no re-upload needed).
Recommendation statuses and notes carry over to the new analysis.

### Working across uploads

- **Correct an objective.** Each campaign row in the breakdown table has an objective
  selector. Choosing one re-analyses the report with it ("your correction" wins over any
  detection); "auto" returns to AdMate's own detection.
- **Compared with your previous upload.** When the same workspace has an earlier upload
  for the same platform and currency, the report compares against it: account KPIs,
  each campaign's main KPI (with the same statistical test the detectors use), and
  campaigns that are new or gone. Totals are compared per day when the two files cover
  different numbers of days; mixed-objective accounts are compared per objective. The
  assistant can answer "how does this compare with my last upload?".
- **Side by side.** Tick 2-4 rows in the breakdown table to compare them; the best value
  per metric is marked, and mixing objectives is flagged as not like-for-like.
- **Pin to client report.** Any assistant answer can be pinned to the printable client
  report. Pins are created from the stored, validated answer - never from text sent by
  the browser - and can be removed from the client report page.

### Functional, but improved by an API key

- **AI-written insight narratives.** With `ANTHROPIC_API_KEY` set, Claude writes the observation,
  possible causes, recommended actions and monitoring list from the evidence AdMate computed. The UI
  shows "Claude analyst". Without a key it shows "Local analyst" and uses built-in templates.

  **The numbers are identical either way.** The model never computes anything — see
  [Why you can trust the numbers](#why-you-can-trust-the-numbers).

### Deliberately not built in this MVP

These are **not implemented**, and the UI says so where a user might otherwise assume otherwise:

- Direct Meta / TikTok / Google / LinkedIn API integrations.
- Continuous or real-time monitoring. Alert rules are evaluated **when you upload and analyse a
  report**, not on a schedule. The Alerts page states this explicitly.
- Slack, email or Telegram alert delivery.
- Scheduled client report delivery.
- Agency white-label branding. The client report header is structured as the seam for it, but no
  logo/colour storage exists.
- Approve-and-execute campaign actions. Out of scope on purpose — see below.
- Team collaboration, roles and permissions.
- PDF report *ingestion*. PDF upload is rejected with a message telling you to export CSV instead.

---

## Why you can trust the numbers

This is the design decision the whole product rests on.

**Every figure shown to a user is computed by deterministic TypeScript, never by a language model.**
The pipeline is:

```
parse & validate  →  normalize & compute  →  detect issues  →  narrate  →  validate output
   (parse.ts)        (metrics.ts)          (detectors.ts)    (ai/)       (ai/)
   ←────────────── arithmetic, always runs ──────────────→   ← LLM →     ← gate →
```

The model receives pre-computed, pre-formatted evidence and writes the explanation around it. Its
response is then **rejected** if it:

- cites a number that is not in the evidence (beyond a 2% rounding tolerance),
- promises a guaranteed outcome ("this will improve your CPA").

A rejected insight falls back to the deterministic rendering for that finding — the user still sees
the issue, just in the built-in wording, and the report says so. `src/lib/analysis/__tests__/ai-validation.test.ts`
pins this behaviour.

Three further rules run throughout:

1. **Missing is not zero.** `null` means "the platform did not report this"; `0` means "the platform
   reported zero". They lead to opposite advice, so they are never collapsed. A report with no
   conversion column produces *no* CPA findings rather than "CPA: infinite".
2. **Derived metrics require their inputs.** CPA appears only when both spend and conversions exist.
   Division by zero yields `null`, not `Infinity`.
3. **Causes are hypotheses.** The data shows magnitude and correlation; it rarely shows cause. The UI
   labels that section "Why this might be happening — these are possible explanations consistent with
   the data, not confirmed causes."

---

## Architecture

```
src/
  app/
    (auth)/              sign in, sign up
    (app)/               authenticated shell
      dashboard/         KPIs, top issues, alerts, recent reports
      upload/            the two-step upload wizard
      reports/           list, per-report analysis, client report
      recommendations/   cross-report tracker with status filters
      alerts/            rule builder + triggered alerts
      workspaces/        per-client separation
    api/                 auth, upload, recommendations, alerts, workspace, health
  components/ui/         shell, KPI cards, charts, tables, insight card, primitives
  lib/
    analysis/
      types.ts           canonical metric model
      columns.ts         cross-platform header matching
      parse.ts           file parsing, coercion, validation
      metrics.ts         aggregation, derived metrics, period comparison, statistics
      detectors.ts       issue detection → evidence-backed findings
      alerts.ts          user-defined rule evaluation
      summary.ts         deterministic account narrative
      pipeline.ts        orchestration
    ai/insights.ts       Claude narration + output validation + local fallback
    db/                  SQLite schema, auth, user-scoped queries
scripts/                 sample generation, seeding
sample-data/             four sample reports
```

### Data model

`users → workspaces → reports → report_rows` and `reports → analyses → recommendations`, plus
`alert_rules` and `alert_events`. SQLite via `better-sqlite3`: no external service to stand up, one
file to back up, and the same SQL moves to Postgres when it needs to.

The normalized rows are stored so an analysis can be re-run without asking the user to re-upload.
The original file is **not** retained after parsing.

### Security and privacy

- Every query in `src/lib/db/queries.ts` takes a `userId` and filters on it. There is no
  "fetch by id" helper that skips the ownership check.
- The active workspace is read from a cookie but always re-validated against the user's own
  workspaces, so a tampered cookie cannot reach another tenant's data.
- Session cookies are HttpOnly, SameSite=Lax, Secure in production, and HMAC-signed — a forged
  cookie is rejected before it reaches the database.
- Upload type and size are validated (10 MB, 50,000 rows).
- `ANTHROPIC_API_KEY` is read server-side only and never reaches the browser.
- **One client's data is never used as context for another's.** Benchmarks are computed *within a
  single uploaded report*, so a campaign is only ever compared against its own account.
- Login failures return one message for both unknown email and wrong password, so the endpoint
  cannot be used to enumerate accounts.

---

## How issues are prioritised

Ranking by percentage change alone surfaces noise: a 300% CPA rise on a £12 test budget would
outrank a 30% rise on the campaign carrying half the account. AdMate scores each finding on
**magnitude × share of account spend**, with money weighted at least as heavily as movement, then
bands it:

- **High** — investigate now.
- **Medium** — worth reviewing.
- **Low** — consider later.

Two supporting rules:

- **Materiality floor.** Entities below 2% of account spend are not flagged at all.
- **Opportunities cap at medium.** An efficient campaign worth scaling is upside, not urgency, so it
  never outranks a campaign quietly burning budget.

Findings are also deduplicated up the hierarchy: a CPA spike that appears on a campaign, its ad sets
and its ads is one finding, not three — unless a specific ad is materially worse, which is the
"which ad, specifically" detail a marketer actually wants.

---

## Competitor analysis

Research note on method and limits: **the five competitor websites could not be fetched directly
from this build environment** — `adriel.com`, `madgicx.com`, `revealbot.com`, `theadspend.com` and
`go-insights.com` are all blocked by the network egress policy. The capabilities below were gathered
from **web search results and third-party review sources in September 2026**, not from the vendors'
own pages. Treat them as *reported* rather than *verified first-hand*; specifics such as pricing and
exact feature names may have changed. Nothing in AdMate's implementation depends on these details
being exact — they informed which *problems* to solve, not what to copy.

| Competitor | Reported capability | What AdMate adopted | What it deliberately did not |
| --- | --- | --- | --- |
| **Adriel** | Unified dashboard over 650+ sources; KPI anomaly alerts for overspend, CPA, ROAS; white-label dashboards and custom domains for agencies | Account → campaign → ad set → ad drill-down in one view; workspace-per-client separation; a client-facing report structured as the white-label seam | Live connectors and hosted white-label domains — both need integration and billing infrastructure the MVP does not have |
| **Madgicx** | "AI Marketer" audits across targeting, auction, geo, demographics, creative and ad copy; One-Click Report as PDF or shareable link; tells you what to do next | AI recommendations as the **core** feature, not an add-on; a one-click client report; the "what should I do next" framing throughout | Breakdowns AdMate cannot honestly support. Audience/geo/demographic audits need breakdown exports; AdMate analyses only the dimensions present in your file |
| **Revealbot** | Rules engine with 47 condition types and AND/OR grouping; checks every 15–30 min; automated pause/budget actions; Slack, email, mobile notifications | User-defined monitoring: choose metric, condition, threshold and scope | Multi-condition rule trees and **automated actions**. Complex rule-building is the thing marketers ask for and then don't maintain. AdMate explains changes instead of requiring you to anticipate them, and never executes |
| **The Ad Spend** | 1,900+ detection algorithms against each account's own baseline every ~3 hours; spend anomalies, budget pacing, CPA drift with likely cause attached; "the system recommends, you decide"; approved changes written to an audit trail | The recommend-then-decide workflow, with an explicit status trail (New / In review / Action taken / Dismissed) and causes attached to findings | Continuous polling and the approve-and-execute step. The MVP is advisory-only by design |
| **Go Insights** | Per-metric behavioural baselines from 30–90 days of history including seasonality; deviation sized against that baseline; likely cause attached; concise Slack/email alerts; scheduled summaries | Deviation sizing, robust outlier detection (median + MAD rather than mean + SD, so one bad day does not move the baseline), plain-language alerts, prioritisation by what matters most | Long-horizon historical baselines. AdMate only ever has the file you uploaded, so it says "compared against the prior half of this report" and never implies a 90-day baseline it does not have |

### Where AdMate differentiates

1. **It works before any integration exists.** Every competitor above requires OAuth-connecting live
   ad accounts. That is a real barrier — for freelancers without admin access, for agencies during
   onboarding, and for anyone evaluating a tool. AdMate analyses the export you can produce in
   thirty seconds. Time-to-first-insight is a minute, not a procurement cycle.

2. **The AI is bounded, and the boundary is enforced in code.** Competitors describe AI audits;
   AdMate specifies the division of labour and tests it. Deterministic maths, LLM narration,
   automated rejection of unsupported claims. This is what makes an AI analyst usable for budget
   decisions rather than a plausible-sounding risk.

3. **It says what it cannot tell you.** Upload a report without conversion tracking and AdMate says
   so, declines to report CPA, and explains what to re-export — instead of showing zeros. Each
   insight carries an explicit confidence level with its reasoning, and a "what this report can't
   tell us" section. That honesty is a feature: a tool that is confidently wrong about £50k of spend
   is worse than no tool.

4. **It prioritises by money, not by drama** (see above).

5. **It is explicitly advisory.** Partly a scope decision, partly a trust one: an analyst you can
   check is more useful early than an optimiser you must supervise.

---

## Testing

```bash
npm test
```

64 tests, no network required:

- **Value coercion** — zero vs missing, currency symbols, `1,234.56` vs `1.234,56`, parenthesised
  negatives, percentages, Excel serial dates, ambiguous `dd/mm` vs `mm/dd`.
- **Column mapping** — "Cost / conv." never steals the spend column; "conversion value" is not
  mistaken for "conversions"; no canonical key is assigned twice; all four platforms detected.
- **Parsing** — Google's banner rows skipped, totals row excluded, thousands separators survive.
- **Validation** — every planted problem in the messy sample is reported.
- **Metrics** — derived metrics omitted when inputs are missing, `null` on divide-by-zero, frequency
  recomputed rather than summed, blended CPA from summed inputs rather than averaged ratios, period
  comparison refuses fewer than four days, robust z-score stays silent on small or flat samples.
- **Objectives, statistics and drivers** — objectives inferred per campaign; a traffic
  campaign is never judged on CPA; a 3 → 1 conversion "spike" is never strong evidence;
  small zero-conversion ads become "wait for data"; driver contributions sum exactly to
  the change; the retargeting signals merge into one fatigue diagnosis.
- **Assistant** — context resolution from clicks, names and conversation; invented
  figures, unknown names and promised outcomes are caught; the model path retries once
  and falls back (tested with a fake client); every suggested question has a no-key answer.
- **Detectors** — each planted scenario in the Meta sample is found (the zero-conversion
  campaign is an awareness campaign and is correctly *not* flagged for conversions); every finding carries evidence,
  actions, monitoring and causes; no CPA/ROAS findings on a report without conversion tracking;
  an empty report produces no findings rather than throwing.
- **Alerts** — rules fire, disabled rules never fire, change-based rules stay silent without dates.
- **AI validation** — fabricated figures and guaranteed outcomes are rejected; ordinary prose numbers
  are not false-positived; the local engine produces the full five-part structure.

Verified manually against the running production build: full signup → upload → map → analyse →
review → status-change journey; cross-user isolation (a second account gets 404 on every one of the
first account's resources); unauthenticated API access rejected; forged session cookies rejected;
file type, size and emptiness validation; and no horizontal overflow at 390px, 768px and 1440px.

---

## Sample data

| File | What it exercises |
| --- | --- |
| `meta-ads-14-days.csv` | Meta export, 14 days, 4 campaigns with ad sets and ads. Planted: a CPA spike driven by a conversion-rate collapse, creative fatigue (high frequency + falling CTR), a campaign spending with zero conversions, and an efficient campaign worth scaling |
| `google-ads-10-days.csv` | Google export with title/date banner rows, `Impr.` headers, quoted thousands separators and a totals row |
| `tiktok-ads-no-dates.csv` | No date column and no conversion tracking — shows the honest-gaps path |
| `messy-report-with-issues.csv` | Blanks, dashes, `N/A`, a duplicate row, a European decimal comma, an unparseable date and more clicks than impressions |

Samples are generated from a seeded PRNG, so the planted scenarios are reproducible and the
detectors can be tested against a known expected outcome.

---

## Known limitations

- **Analysis is per-report.** Comparisons are within a single uploaded file. Cross-report trending
  over time is not implemented.
- **Period comparison splits the file in half.** With no historical baseline available, "last 7 days
  vs prior 7 days" is what the data honestly supports. It is labelled that way everywhere.
- **Attribution lag is noted but not modelled.** Recent ROAS drops may partially recover; AdMate says
  so in its recommendations rather than adjusting figures.
- **Breakdown exports inflate entity counts.** A report split by age or placement repeats entity
  names per breakdown. Totals stay correct and AdMate warns about it, but it does not yet pivot
  breakdown dimensions.
- **SQLite is single-writer.** Fine for one user or a small team; move to Postgres for real
  concurrency.
- **Currency is per-workspace, not per-row.** A single report mixing currencies is not supported.
