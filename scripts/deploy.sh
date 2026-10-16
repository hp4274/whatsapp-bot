#!/bin/bash
# Production update. Run on the server: bash /var/www/whatsapp-bot/scripts/deploy.sh
set -e

main() {
  echo "Updating WhatsApp Bot..."
  cd /var/www/whatsapp-bot

  echo "Pulling latest git changes..."
  git pull

  echo "Checking dependencies..."
  npm run install:all

  echo "Building frontend..."
  npm run build

  echo "Restarting application..."
  pm2 restart whatsapp-bot

  echo "Production update complete."
  pm2 status
}
# A function body is parsed whole, so `git pull` replacing this file mid-run is safe.
main "$@"
exit
