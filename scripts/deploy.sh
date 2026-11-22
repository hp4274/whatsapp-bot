#!/bin/bash
# Production update. Run on the server as the app's user: sudo -u whatsapp bash /var/www/whatsapp-bot/scripts/deploy.sh
set -e

APP_DIR=/var/www/whatsapp-bot
APP_NAME=whatsapp-bot

main() {
  echo "Updating WhatsApp Bot..."
  cd "$APP_DIR"

  # Run as anyone else (root, say) and pm2 starts a second copy with its own data folder: two processes then fight
  # over the same WhatsApp logins (docs/OPS.md "Server setup").
  local owner
  owner=$(stat -c %U "$APP_DIR")
  if [ "$(id -un)" != "$owner" ]; then
    echo "ERROR: run this as $owner, not $(id -un): sudo -u $owner bash $APP_DIR/scripts/deploy.sh" >&2
    exit 1
  fi

  echo "Pulling latest git changes..."
  local before
  before=$(git rev-parse HEAD)
  git pull
  if [ "$before" = "$(git rev-parse HEAD)" ]; then
    echo "Already up to date at $(git rev-parse --short HEAD): restarting anyway."
  else
    echo "Deploying $(git rev-parse --short "$before") -> $(git rev-parse --short HEAD):"
    git log --oneline "$before"..HEAD | head -20
  fi

  echo "Installing server dependencies from the lock file..."
  # Dev dependencies are screenshot scripts only; production never loads them.
  npm --prefix server ci --omit=dev
  # A warning only (docs/OPS.md): a deploy is not held back by an advisory, but it is seen.
  npm --prefix server audit --omit=dev --audit-level=high \
    || echo "WARNING: npm audit reports high-severity issues (or could not run). Review them after this deploy."

  # The frontend only needs a rebuild when web/ changed (or was never built).
  if [ ! -d web/dist ] || ! git diff --quiet "$before" HEAD -- web/; then
    echo "Building frontend..."
    npm --prefix web ci
    npm run build
  else
    echo "web/ unchanged: keeping the current build."
  fi

  echo "Restarting application..."
  local restarted_after
  restarted_after=$(($(date +%s) * 1000))
  # ecosystem.config.cjs holds the restart rules (memory cap, backoff, max restarts).
  pm2 startOrRestart ecosystem.config.cjs

  # A boot that fails (say, the encryption-key gate) must not read as a finished deploy. And /api/health answers from
  # whatever holds the port: a process older than this restart (pm2 did not restart it, or a stray copy under another
  # user) would pass while the new code never runs, so its start time must be newer than the restart.
  echo "Waiting for the new code to answer..."
  local port health started
  port=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2)
  for _ in $(seq 30); do
    health=$(curl -fsS "http://127.0.0.1:${port:-3000}/api/health" 2>/dev/null || true)
    started=$(echo "$health" | grep -o '"startedAt":[0-9]*' | cut -d: -f2)
    if [ -n "$started" ] && [ "$started" -ge "$restarted_after" ]; then
      echo "Production update complete."
      pm2 status
      return 0
    fi
    sleep 2
  done
  if [ -n "$health" ]; then
    echo "ERROR: an older server process is still answering on port ${port:-3000}, so the new code is not running." >&2
    echo "       pm2 did not restart it, or a second copy holds the port (often a root-run pm2: sudo pm2 delete $APP_NAME)." >&2
  else
    echo "ERROR: the app did not answer /api/health within 60s. Check: pm2 logs $APP_NAME" >&2
  fi
  pm2 status
  exit 1
}

# A function body is parsed whole, so `git pull` replacing this file mid-run is safe.
main "$@"
exit
