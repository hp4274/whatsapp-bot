#!/bin/bash
# Production update. Run on the server: bash /var/www/whatsapp-bot/scripts/deploy.sh
set -e

main() {
  echo "Updating WhatsApp Bot..."
  cd /var/www/whatsapp-bot

  echo "Pulling latest git changes..."
  git pull

  echo "Installing dependencies from the lock files..."
  npm --prefix server ci
  npm --prefix web ci

  # A warning only: a published advisory must never block a deploy.
  echo "Auditing dependencies..."
  npm --prefix server audit --audit-level=high || echo "WARNING: npm audit found high-severity issues in server/ (not blocking)"
  npm --prefix web audit --audit-level=high || echo "WARNING: npm audit found high-severity issues in web/ (not blocking)"

  echo "Building frontend..."
  npm run build

  echo "Restarting application..."
  # ecosystem.config.cjs holds the restart rules (memory cap, backoff, max restarts).
  pm2 startOrRestart ecosystem.config.cjs

  echo "Production update complete."
  pm2 status
}
# A function body is parsed whole, so `git pull` replacing this file mid-run is safe.
main "$@"
exit
