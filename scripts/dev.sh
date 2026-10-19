#!/usr/bin/env bash
# Run the real app locally at http://localhost:5000 with its own database and sample data.
#
#   scripts/dev.sh           start (first run sets everything up, ~1 minute)
#   scripts/dev.sh --reset   throw away the local database and start fresh
#
# Uses WAMP's MariaDB as a private server for this project only: data in .localdb/, port 3310,
# root with no password, nothing installed as a Windows service. Emails are not sent. Sign-in
# accounts are printed on first run (see scripts/seed_local.py). Emails (e.g. password reset
# links) are printed in this window instead. Ctrl+C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."

MARIADB_BIN="${MARIADB_BIN:-$(ls -d /c/wamp64/bin/mariadb/mariadb*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$MARIADB_BIN/mariadbd.exe" ] || { echo "MariaDB not found. Set MARIADB_BIN to a folder containing mariadbd.exe." >&2; exit 1; }
DATA=.localdb/data
PORT=3310
SQL=("$MARIADB_BIN/mariadb.exe" -h 127.0.0.1 -P $PORT -u root)

if [ "${1:-}" = "--reset" ]; then rm -rf .localdb; fi

if [ ! -d "$DATA" ]; then
  echo "==> Creating local database files"
  mkdir -p .localdb
  "$MARIADB_BIN/mariadb-install-db.exe" --datadir="$(cd .localdb && pwd -W)/data" --port=$PORT >/dev/null
fi

echo "==> Starting local MariaDB on port $PORT"
"$MARIADB_BIN/mariadbd.exe" --datadir="$(cd "$DATA" && pwd -W)" --port=$PORT --bind-address=127.0.0.1 \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci > .localdb/mariadb.log 2>&1 &
DB_PID=$!
trap 'kill $DB_PID 2>/dev/null || true' EXIT
# --connect-timeout: a client started before the server listens can otherwise hang forever
for _ in $(seq 60); do "${SQL[@]}" --connect-timeout=2 -e "SELECT 1" >/dev/null 2>&1 && break; sleep 0.5; done

if [ ! -d .venv ]; then
  echo "==> Creating .venv with the app's packages"
  python -m venv .venv
  .venv/Scripts/python -m pip install -q -r requirements.txt
fi

export DB_HOST=127.0.0.1 DB_PORT=$PORT DB_USER=root DB_PASSWORD= DB_NAME=shiloh_local
export SMTP_PASSWORD= APP_URL=http://localhost:5000 DEV_SHOW_EMAILS=1
if ! "${SQL[@]}" -e "SELECT 1 FROM shiloh_local.users LIMIT 0" >/dev/null 2>&1; then
  echo "==> Loading the app's tables and sample data"
  "${SQL[@]}" -e "DROP DATABASE IF EXISTS shiloh_local; CREATE DATABASE shiloh_local CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
  "${SQL[@]}" shiloh_local < db/schema_base.sql
fi
.venv/Scripts/python migrations/apply.py
.venv/Scripts/python scripts/seed_local.py

echo "==> App running at http://localhost:5000  (Ctrl+C to stop)"
.venv/Scripts/python -c "import app; app.app.run(host='127.0.0.1', port=5000, debug=False)"
