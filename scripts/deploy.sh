#!/bin/bash
# Production update. Run on the server: bash /var/www/whatsapp-bot/scripts/deploy.sh
set -e

main() {
  echo "Updating WhatsApp Bot..."
  cd /var/www/whatsapp-bot

  echo "Pulling latest git changes..."
  local before
  before=$(git rev-parse HEAD)
  git pull

  echo "Installing server dependencies from the lock file..."
  # Dev dependencies are screenshot scripts only; production never loads them.
  npm --prefix server ci --omit=dev

  # The frontend only needs a rebuild when web/ changed (or was never built).
  if [ ! -d web/dist ] || ! git diff --quiet "$before" HEAD -- web/; then
    echo "Building frontend..."
    npm --prefix web ci
    npm run build
  else
    echo "web/ unchanged: keeping the current build."
  fi

  echo "Restarting application..."
  # ecosystem.config.cjs holds the restart rules (memory cap, backoff, max restarts).
  pm2 startOrRestart ecosystem.config.cjs

  # A boot that fails (say, the encryption-key gate) must not read as a finished deploy.
  echo "Waiting for the app to answer..."
  local port
  port=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2)
  for _ in $(seq 30); do
    if curl -fsS "http://127.0.0.1:${port:-3000}/api/health" >/dev/null 2>&1; then
      echo "Production update complete."
      pm2 status
      return 0
    fi
    sleep 2
  done
  echo "ERROR: the app did not answer /api/health within 60s. Check: pm2 logs whatsapp-bot" >&2
  pm2 status
  exit 1
}
# A function body is parsed whole, so `git pull` replacing this file mid-run is safe.
main "$@"
exit
