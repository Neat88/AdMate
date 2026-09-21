#!/bin/sh
set -e

# Railway, Render and Fly attach their persistent volume at runtime, after the
# image is built. The mount arrives owned by root, so a chown baked into the
# Dockerfile does not apply to it - the app would start and then fail to write
# its database.
#
# So: start as root, take ownership of the data directory, then drop to the
# unprivileged account before exec'ing the server. The application process
# itself never runs as root.
#
# IDs are numeric on purpose. setpriv does not resolve user or group *names*
# (util-linux refuses with "failed to parse reuid"), and these match the
# nextjs:nodejs account the Dockerfile creates with --uid 1001 --gid 1001.
APP_UID=1001
APP_GID=1001

DB_PATH="${ADMATE_DB_PATH:-/data/admate.db}"
DB_DIR="$(dirname "$DB_PATH")"

mkdir -p "$DB_DIR"

if [ "$(id -u)" = "0" ]; then
  if ! chown -R "$APP_UID:$APP_GID" "$DB_DIR" 2>/dev/null; then
    echo "entrypoint: could not chown $DB_DIR - continuing in case it is already writable" >&2
  fi
  exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups "$@"
fi

# Already unprivileged (some hosts pin the user): run directly.
exec "$@"
