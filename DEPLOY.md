# Deploying AdMate

AdMate stores data in SQLite — a file on disk. That single fact decides where it
can run.

| Host type | Works? | Why |
| --- | --- | --- |
| Railway, Render, Fly.io, VPS, any Docker host **with a persistent volume** | **Yes** | The database file survives restarts and redeploys |
| Vercel, Netlify, Cloudflare Workers, AWS Lambda | **No** | Serverless filesystems are read-only (or wiped per invocation). Signup fails on first write |

If you want Vercel specifically, the database layer must move to Postgres first.
That work is confined to `src/lib/db/` (~900 lines) — nothing else in the app
writes to disk, and uploaded files are parsed in memory and never stored.

---

## Railway (recommended — fastest to a working URL)

1. Push this branch to GitHub (already done).
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → pick `Neat88/AdMate`.
3. Railway reads `railway.json` and builds the `Dockerfile` automatically.
4. **Add a volume** — this is the step that matters:
   *Service → Settings → Volumes → New Volume*, mount path **`/data`**.
5. **Set the environment variables** (*Service → Variables*):

   | Variable | Value | Required |
   | --- | --- | --- |
   | `SESSION_SECRET` | 64 random hex chars (below) | **Yes** |
   | `ADMATE_DB_PATH` | `/data/admate.db` | **Yes** |
   | `ANTHROPIC_API_KEY` | your key | No — see [Analyst modes](#analyst-modes) |

   Generate the secret locally:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
6. *Settings → Networking → **Generate Domain***. That is your live URL.
7. Confirm it came up healthy:
   ```bash
   curl https://YOUR-APP.up.railway.app/api/health
   # {"status":"ok","database":"reachable","users":0,"analyst":"local",...}
   ```
8. Open the URL, create an account, and load a sample report from the upload page.

Free trial credit covers this comfortably; expect roughly $5/month after.

---

## Render

1. [render.com](https://render.com) → **New** → **Blueprint** → point it at the repo.
2. Render reads `render.yaml`, which already declares the disk at `/data`, the
   health check, and a generated `SESSION_SECRET`.
3. Add `ANTHROPIC_API_KEY` in the dashboard if you want Claude-written narratives.

**Note:** Render's free tier has **no persistent disk**, so `render.yaml` specifies
the `starter` plan (~$7/month). On the free tier your database is wiped on every
restart.

---

## Fly.io

```bash
fly launch --no-deploy                       # edit the app name in fly.toml
fly volumes create admate_data --size 1 --region iad
fly secrets set SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
fly secrets set ANTHROPIC_API_KEY=sk-ant-...  # optional
fly deploy
```

`fly.toml` pins `min_machines_running = 1`. Do not raise it: **SQLite tolerates
exactly one writer**, and two machines sharing a volume will corrupt the database.

---

## Any Docker host / your own VPS

```bash
docker build -t admate .
docker run -d --name admate -p 3000:3000 \
  -v admate_data:/data \
  -e SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  -e ADMATE_DB_PATH=/data/admate.db \
  admate
```

Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik) in front of it.
Session cookies are set `Secure` in production, so **sign-in will silently fail
over plain HTTP** — you need HTTPS.

---

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SESSION_SECRET` | **Yes in production** | none | Signs session cookies. AdMate refuses to start signing with a built-in default and returns a clear 503 from the auth routes instead of running insecurely |
| `ADMATE_DB_PATH` | Yes on a container host | `./data/admate.db` | Must point **inside the mounted volume**, or data is lost on redeploy |
| `ANTHROPIC_API_KEY` | No | unset | Enables Claude-written narratives |
| `ADMATE_MODEL` | No | `claude-sonnet-5` | Model used for narration |
| `ADMATE_CHAT_MODEL` | No | `ADMATE_MODEL` | Model used by the in-report assistant |
| `ADMATE_AI_DAILY_LIMIT` | No | `60` | Model-backed assistant answers per user per day |
| `PORT` | No | `3000` | Most hosts set this for you |

---

## Analyst modes

| `ANTHROPIC_API_KEY` | UI shows | Behaviour |
| --- | --- | --- |
| Not set | "Local analyst" | Insight narratives come from AdMate's built-in templates |
| Set | "Claude analyst" | Claude writes the narratives from the metrics AdMate computed |

**The numbers are identical in both modes.** The model never computes anything —
it receives pre-computed evidence and writes the explanation, and its output is
rejected if it cites a figure the evidence does not support. Deploying without a
key gives you a fully working product, just plainer prose.

---

## There is no demo account in production — on purpose

`npm run seed` creates `demo@admate.app` with a password published in the README.
Seeding a public deployment would hand anyone who read the repo a working login,
so the production image does not run it.

Your first visitor signs up normally, then loads a sample report from the upload
page (**Upload → "Or explore with sample data"**). The four sample files ship in
the image, so the demo experience works without a seeded account.

---

## How the container handles the volume

Railway, Render and Fly attach the persistent volume **at runtime**, after the
image is built, and it arrives owned by `root`. A container that runs as an
unprivileged user would start fine and then fail on the first write — the health
check would pass and every signup would fail.

`docker-entrypoint.sh` handles this: it starts as root, takes ownership of the
directory holding `ADMATE_DB_PATH`, then drops to the unprivileged `nextjs`
account (uid 1001) via `setpriv` before exec'ing the server. **The application
process never runs as root.**

Two details that matter if you edit it:

- `setpriv` does not resolve user or group *names* — it fails with
  "failed to parse reuid". The IDs are numeric on purpose.
- There is no `VOLUME` instruction in the Dockerfile. It would create an
  anonymous volume that conflicts with the named volume the host mounts.

## Operating notes

- **Back up the volume.** The whole database is one file. `admate.db`, `admate.db-wal`
  and `admate.db-shm` should be copied together, ideally with the app stopped.
- **Scale up, not out.** SQLite is single-writer. Give the machine more CPU/RAM
  rather than running two instances. When you genuinely need multiple instances,
  that is the signal to move to Postgres.
- **Health check.** `/api/health` queries the database rather than just returning
  200, so an unmounted volume reports unhealthy instead of quietly failing every
  signup. If it returns `"database":"unreachable"`, the volume is missing or
  `ADMATE_DB_PATH` points outside it.
- **Upload limits.** 10 MB and 50,000 rows per file, enforced in code. If your
  host has a smaller request body cap, raise it or the cap applies first.

---

## What was verified before shipping these files

Docker Hub is blocked from the environment this was built in, so **the image build
itself was not executed here.** What *was* tested is the part that actually carries
risk — that Next.js standalone output runs with the native SQLite module:

- `output: "standalone"` builds, and `better_sqlite3.node` is traced into it.
- The standalone server was run with the runner stage's exact file layout, env
  vars and an empty volume directory.
- It created the database on the volume, and the full journey passed against it:
  signup → upload → column mapping → analysis (16 findings, 4 alerts) → all eight
  pages rendering with real content. Static assets, the icon and the sample CSVs
  all served. No errors in the log.

The privilege-dropping entrypoint was tested separately against a **root-owned
volume**, reproducing exactly what these hosts mount: the directory was chowned
from `0:0` to `1001:1001`, the server came up healthy, a signup succeeded, and
the resulting `admate.db` was owned by uid 1001 — confirming the app writes to
the volume without running as root.

The Dockerfile's remaining risk is ordinary layer plumbing, which surfaces
immediately on your first build. If it fails, the likely cause is the native
module — check that the `deps` stage kept `python3 make g++`.

## Troubleshooting a failed build

Open the failed deployment on your host and read the **build logs** — the last
20-30 lines name the failing step. Common causes:

| Symptom in the log | Cause | Fix |
| --- | --- | --- |
| `npm ci` exits non-zero, mentions lockfile | `package.json` and `package-lock.json` out of sync | Run `npm install` locally, commit the lockfile |
| `node-gyp` / `better_sqlite3` compile errors | Build toolchain missing | Confirm the `deps` stage still installs `python3 make g++` |
| `JavaScript heap out of memory` | Build ran out of RAM | Raise the build resources on the host, or set `NODE_OPTIONS=--max-old-space-size=4096` as a build variable |
| `failed to solve` / cannot pull base image | Registry blocked or rate-limited | Retry; if it persists the host's builder cannot reach Docker Hub |
| Build succeeds, container restarts repeatedly | Runtime, not build | Check `SESSION_SECRET` is set and the volume is mounted at the path `ADMATE_DB_PATH` points into |
