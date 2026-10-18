#!/usr/bin/env bash
# Deploy the committed app to Namecheap (hub.shilohliving.app) and push to GitHub.
#
#   scripts/deploy.sh            push + deploy HEAD
#   scripts/deploy.sh --env      also upload the local .env
#   scripts/deploy.sh --deps     also reinstall requirements.txt on the server
#   scripts/deploy.sh --migrate  back up the database, then apply new migrations/*.sql
set -euo pipefail

SSH_HOST="shilzikx@server353.web-hosting.com"
SSH_OPTS=(-i "$HOME/.ssh/namecheap_ed25519" -p 21098 -o BatchMode=yes)
APP_ROOT="shilohliving_hub"
VENV="virtualenv/$APP_ROOT/3.12/bin"
HEALTH_URL="https://hub.shilohliving.app/api/health"

cd "$(dirname "$0")/.."

UPLOAD_ENV=0; INSTALL_DEPS=0; MIGRATE=0
for arg in "$@"; do
  case "$arg" in
    --env)  UPLOAD_ENV=1 ;;
    --deps) INSTALL_DEPS=1 ;;
    --migrate) MIGRATE=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes - commit first so live matches GitHub." >&2
  git status --short >&2
  exit 1
fi

echo "==> Pushing to GitHub"
git push origin HEAD

echo "==> Uploading $(git rev-parse --short HEAD) to $APP_ROOT"
git archive --format=tar HEAD -- . ':!scripts' ':!.gitignore' ':!.env.example' ':!CLAUDE.md' \
  | ssh "${SSH_OPTS[@]}" "$SSH_HOST" "tar xf - -C ~/$APP_ROOT"

if [ "$UPLOAD_ENV" = 1 ]; then
  echo "==> Uploading .env"
  ssh "${SSH_OPTS[@]}" "$SSH_HOST" "umask 077; cat > ~/$APP_ROOT/.env" < .env
fi

if [ "$INSTALL_DEPS" = 1 ]; then
  echo "==> Installing requirements"
  ssh "${SSH_OPTS[@]}" "$SSH_HOST" "~/$VENV/pip install -q -r ~/$APP_ROOT/requirements.txt"
fi

if [ "$MIGRATE" = 1 ]; then
  echo "==> Backing up database to ~/backups"
  # .env may have Windows line endings; strip them before reading the DB settings
  ssh "${SSH_OPTS[@]}" "$SSH_HOST" 'cd ~/'"$APP_ROOT"' && eval "$(tr -d "\r" < .env | grep -E "^DB_[A-Z_]+=" | sed "s/^/export /")" \
    && mkdir -p ~/backups && umask 077 \
    && f=~/backups/shiloh-$(date +%Y%m%d-%H%M%S).sql.gz \
    && mysqldump --single-transaction --routines --triggers --no-tablespaces -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" 2>/dev/null | gzip > "$f" \
    && [ "$(gzip -dc "$f" | head -c 100 | wc -c)" -gt 0 ] && echo "    saved $f"'
  echo "==> Applying migrations"
  ssh "${SSH_OPTS[@]}" "$SSH_HOST" "~/$VENV/python ~/$APP_ROOT/migrations/apply.py"
fi

echo "==> Restarting app"
ssh "${SSH_OPTS[@]}" "$SSH_HOST" "mkdir -p ~/$APP_ROOT/tmp && touch ~/$APP_ROOT/tmp/restart.txt"

echo "==> Hourly jobs (cron: overdue bills + reminders)"
# Replaces our own line only; other cron jobs (SSL renewal) are kept
CRON_LINE='7 * * * * cd $HOME/'"$APP_ROOT"' && $HOME/'"$VENV"'/python tools/daily_jobs.py >> $HOME/'"$APP_ROOT"'/daily_jobs.log 2>&1'
ssh "${SSH_OPTS[@]}" "$SSH_HOST" "(crontab -l 2>/dev/null | grep -v 'tools/daily_jobs.py'; echo '$CRON_LINE') | crontab -"

echo "==> Health check"
sleep 3
curl -fsS -m 30 "$HEALTH_URL" && echo
