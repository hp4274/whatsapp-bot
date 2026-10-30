#!/bin/bash
# First-time setup on a fresh Ubuntu/Debian VPS, as root, in one command:
#   curl -fsSL https://raw.githubusercontent.com/hp4274/whatsapp-bot/main/scripts/setup-vps.sh | sudo bash -s -- bot.example.com admin@example.com
# Args: [domain] [admin email]. With a domain (its DNS A record pointing here) Caddy gets HTTPS on its own;
# without one the app is served over plain HTTP on port 80. A private repo: set REPO_URL with a token in it.
# Safe to run again: it pulls, rebuilds and restarts, and never touches an existing .env.
# Later updates: sudo -u whatsapp bash /var/www/whatsapp-bot/scripts/deploy.sh
set -euo pipefail

main() {
  DOMAIN="${1:-}"
  ADMIN_EMAIL="${2:-admin@whatsapp.local}"
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin@2210}"
  REPO_URL="${REPO_URL:-https://github.com/hp4274/whatsapp-bot.git}"
  APP_USER=whatsapp
  APP_DIR=/var/www/whatsapp-bot
  PORT=3000

  [ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
  export DEBIAN_FRONTEND=noninteractive

  echo "==> System packages"
  apt-get update -q
  apt-get install -yq curl git ufw openssl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

  echo "==> Node.js 24"
  if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' 2>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -yq nodejs
  fi
  command -v pm2 >/dev/null || npm install -g pm2

  echo "==> Caddy (reverse proxy, automatic HTTPS)"
  if ! command -v caddy >/dev/null; then
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
    apt-get install -yq caddy
  fi

  echo "==> App user and code"
  id "$APP_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$APP_USER"
  mkdir -p "$(dirname "$APP_DIR")"
  if [ -d "$APP_DIR/.git" ]; then
    sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
  else
    install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
    sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR"
  fi

  if [ ! -f "$APP_DIR/.env" ]; then
    echo "==> Writing $APP_DIR/.env"
    cat > "$APP_DIR/.env" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
TRUST_PROXY=1
PUBLIC_BASE_URL=$([ -n "$DOMAIN" ] && echo "https://$DOMAIN" || echo "http://$(curl -fsS4 https://ifconfig.me || hostname -I | cut -d' ' -f1)")
SUPER_ADMIN_EMAIL=$ADMIN_EMAIL
SUPER_ADMIN_PASSWORD=$ADMIN_PASSWORD
WHATSAPP_ENCRYPTION_KEY=$(openssl rand -hex 32)
EOF
    chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
    chmod 600 "$APP_DIR/.env"
  fi

  echo "==> Install, build, start"
  sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm --prefix server ci && npm --prefix web ci && npm run build \
    && pm2 startOrRestart ecosystem.config.cjs && pm2 save"
  env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null

  echo "==> Caddy site"
  cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN:-:80} {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  systemctl enable --now caddy
  systemctl reload caddy

  echo "==> Firewall and clock"
  ufw allow OpenSSH
  ufw allow 80/tcp # HTTPS certificate challenge and the redirect to HTTPS
  ufw allow 443/tcp
  ufw --force enable
  timedatectl set-ntp true || true

  echo
  echo "Done. Open: $(grep '^PUBLIC_BASE_URL=' "$APP_DIR/.env" | cut -d= -f2-)"
  echo "Super admin: $(grep '^SUPER_ADMIN_EMAIL=' "$APP_DIR/.env" | cut -d= -f2-) / the SUPER_ADMIN_PASSWORD in $APP_DIR/.env"
  echo "(.env re-applies that password on every start: change it there, then: sudo -u $APP_USER pm2 restart whatsapp-bot)"
  echo "Save WHATSAPP_ENCRYPTION_KEY from $APP_DIR/.env somewhere off this server: without it no backup can be read."
}
# A function body is parsed whole, so `git pull` replacing this file mid-run is safe.
main "$@"
exit
