# ---------------------------------------------------------------------------
# AdMate production image
#
# Multi-stage so the shipped layer carries no compiler toolchain and no dev
# dependencies. better-sqlite3 is a native module, so it is compiled inside
# the builder against the same base image the runner uses - a binary built on
# a developer's macOS machine would not load here.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1


# --- deps: install node modules, building native addons as needed -----------
FROM base AS deps
WORKDIR /app

# node-gyp needs these when no prebuilt better-sqlite3 binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci


# --- builder: compile the Next.js standalone server -------------------------
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# A build-time placeholder only. The real secret is injected at runtime by the
# host; this exists so the production build does not trip the startup guard
# while pre-rendering pages.
ENV SESSION_SECRET=build-time-placeholder-not-used-at-runtime
ENV NODE_ENV=production

RUN npm run build


# --- runner: the image that actually ships ----------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    ADMATE_DB_PATH=/data/admate.db

# Run unprivileged. The volume is chowned so SQLite can create its database
# and the WAL/SHM sidecars alongside it.
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs \
    && mkdir -p /data \
    && chown -R nextjs:nodejs /data

# standalone output excludes public/ and .next/static - both must be copied.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# Mounted by the host; declared so a plain `docker run` still persists data.
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
