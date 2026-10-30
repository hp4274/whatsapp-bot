# Operations

## Ops alerts

The server sends one kind of alert to one place. Set these in the server's environment:

| Variable | What it does |
| --- | --- |
| `OPS_ALERT_WEBHOOK` | URL that receives each alert as a JSON `POST`. Unset: alerts still go to the error log and the audit log. |
| `OPS_ALERT_SECRET` | Signs every alert (HMAC-SHA256) in the `X-Signature` header. |
| `OPS_ALERT_SECRET_PREVIOUS` | Only while changing the secret: adds a second signature made with the old secret. |

Every alert is also written as an `error` log line (`ops alert: <kind>`) and as an audit row with action
`ops.alert` (super admin: `GET /api/admin/audit-logs`), including alerts the limits held back.

### What raises one

| `kind` | When |
| --- | --- |
| `logout` | The number was logged out from the phone or by WhatsApp, not from this app. |
| `ban` | WhatsApp banned the number. |
| `unstable` | The connection dropped more than 8 times in an hour (the 8h brake). |
| `delivery`, `stuck` | The delivery or stuck brake started. `shadow: true` means it was only logged (`sending.brakesMode = 'shadow'`). |
| `dead_man` | Messages have been waiting in sending hours and the number has sent nothing for 6 hours. |
| `backup_failed`, `reencrypt_failed` | The daily backup or a re-encryption after a key change failed. |
| `encryption_key` | Startup refused: the encryption key is missing or cannot decrypt this server's data. |
| `held_back` | The hourly summary of alerts the limits did not send (`total`, `byKind`). |

### Limits

- At most 1 alert per kind per number per hour.
- At most 30 alerts per hour across the whole platform.
- Anything over a limit is not sent but is counted; one `held_back` summary per hour reports the counts by kind.

### The body

```json
{
  "kind": "stuck",
  "tenantId": 1,
  "channelId": 3,
  "number": "…3210",
  "shadow": true,
  "at": "2026-10-26T10:00:00.000Z",
  "text": "Shadow (not applied): …",
  "detail": "2026-10-26T22:00:00.000Z"
}
```

Only the last 4 digits of the number are sent.

### Checking an alert on the receiver

The header looks like `X-Signature: t=1793008800,v1=<hex>` (and `,v0=<hex>` while the secret is being changed).
`v1` is `HMAC-SHA256(secret, "<t>.<raw body>")` in hex. The timestamp is inside the signed string, so an old
alert cannot be replayed with a new time.

1. Read the raw request body before parsing the JSON.
2. Split the header on `,` and `=` to get `t`, `v1` and, if present, `v0`.
3. Refuse the alert if `t` is more than 5 minutes from your clock.
4. Compute `HMAC-SHA256(secret, t + "." + rawBody)` in hex and compare it with `v1` (or `v0`) using a
   constant-time compare. Accept if either matches.

```js
import crypto from 'node:crypto';

export function verifyOpsAlert(rawBody, header, secret, toleranceMs = 5 * 60_000) {
    const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')));
    const t = Number(parts.t);
    if (!Number.isFinite(t) || Math.abs(Date.now() - t * 1000) > toleranceMs) return false;
    const want = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'), 'hex');
    return [parts.v1, parts.v0].filter(Boolean).some((sig) => {
        const given = Buffer.from(sig, 'hex');
        return given.length === want.length && crypto.timingSafeEqual(given, want);
    });
}
```

### Changing `OPS_ALERT_SECRET`

1. Set the new secret as `OPS_ALERT_SECRET` and the old one as `OPS_ALERT_SECRET_PREVIOUS`; restart. Alerts
   now carry `v1` (new) and `v0` (old), so the receiver keeps accepting them on the old secret.
2. Update the receiver to the new secret.
3. Remove `OPS_ALERT_SECRET_PREVIOUS`; restart.

## Backups

Once a day (UTC) the server writes `backups/YYYY-MM-DD/` in the data folder (`~/.whatsapp_sender_web`):

- `messages.db.enc`: the database, copied with `VACUUM INTO` and encrypted with `WHATSAPP_ENCRYPTION_KEY`
  (AES-256-GCM). The plaintext copy is deleted straight away; it is never kept.
- `logins/…/*.enc`: every WhatsApp login file, each encrypted the same way (copied as it is when
  `WHATSAPP_ENCRYPT_AUTH=1` has already encrypted it).

The newest 7 days are kept. With no `WHATSAPP_ENCRYPTION_KEY` there is no backup at all, and a `backup_failed`
alert is raised once a day. The last attempt is `backup` in `GET /api/admin/health-detail`
(`{ at, day, ok, dir, bytes, loginFiles, error }`).

**Keep a copy of `WHATSAPP_ENCRYPTION_KEY` off the server.** Without it no backup can be read.

### Monthly restore test

Once a month, check that a backup really opens with the key you have saved:

```bash
cd /var/www/whatsapp-bot/server
npm run restore -- ~/.whatsapp_sender_web/backups/2026-10-26
```

It decrypts the backup into a scratch folder, opens the database read-only, prints every table with its row
count, then deletes the scratch copy (`--keep` leaves it; it holds phone numbers, so delete it yourself). Each
run adds one line to `backups/restore-tests.log` (`ok`, `tables`, `loginFiles`, or `error`). A wrong key or a
damaged file prints `Restore FAILED` and exits 1.

## Encryption key

`WHATSAPP_ENCRYPTION_KEY` (64 hex chars, base64 of 32 bytes, or a passphrase) encrypts channel credentials,
backups and, with `WHATSAPP_ENCRYPT_AUTH=1`, the WhatsApp login files. Every encrypted value carries the id of
the key that encrypted it (8 hex chars, shown as `encryption.keyId` in `GET /api/admin/health-detail`).

### Startup gate

`encryption-check.json` in the data folder holds a known value encrypted with the key. At every start, before
anything writes or links, the server opens it with the current key (and the previous one, if set). If neither
works, or the key is missing, startup stops with an `encryption_key` alert. Nothing is deleted and no number is
asked to scan a QR again: set the right key and start again. Nothing in the app skips this check. With
`NODE_ENV=production` (pm2) a missing key also stops startup. Never delete `encryption-check.json`.

### Encrypting the login files (one way)

1. Save `WHATSAPP_ENCRYPTION_KEY` off the server. Losing it means every number has to link again.
2. Set `WHATSAPP_ENCRYPT_AUTH=1` and `WHATSAPP_ENCRYPTION_KEY_BACKUP_CONFIRMED=<key id>`. The startup error
   prints the id. Without a matching id the server will not start with the flag on.
3. Restart. Each login file is encrypted the first time it is read.

The flag only works one way. With the flag off and encrypted login files on disk, startup refuses, because
Baileys would read the ciphertext as "no login". To go back:

```bash
pm2 stop whatsapp-bot
cd /var/www/whatsapp-bot/server && npm run auth:decrypt   # each file: decrypted to a temp file, then renamed
# remove WHATSAPP_ENCRYPT_AUTH from the environment, then
pm2 start ecosystem.config.cjs
```

### Changing the key

1. Set the new key as `WHATSAPP_ENCRYPTION_KEY` and the old one as `WHATSAPP_ENCRYPTION_KEY_PREVIOUS`. With the
   flag on, also set `WHATSAPP_ENCRYPTION_KEY_BACKUP_CONFIRMED` to the new key's id once the new key is saved
   off the server.
2. Restart. The first start re-encrypts the login files, the sealed channel settings and the backups, one at a
   time, each through a temp file and a rename. A file that fails keeps its old copy (still readable with the
   previous key) and raises `reencrypt_failed`. The next start tries again. The result is
   `encryption.lastReencrypt` in `GET /api/admin/health-detail`.
3. When `lastReencrypt.failed` is 0 and `encryption.checkedKeyId` equals `encryption.keyId`, remove
   `WHATSAPP_ENCRYPTION_KEY_PREVIOUS`.

## Restarts and dependencies

- pm2 runs the app from `ecosystem.config.cjs` (memory cap, growing restart delay, max restarts). First time:
  `pm2 delete whatsapp-bot; pm2 start ecosystem.config.cjs; pm2 save`. `scripts/deploy.sh` then uses
  `pm2 startOrRestart ecosystem.config.cjs`.
- On an uncaught exception the server logs it and exits; pm2 restarts it. Crash restarts are counted in the
  `process_restarts` gauge (`GET /api/metrics`). They never count toward the reconnect brake.
- `scripts/deploy.sh` installs with `npm ci` from the committed lock files and runs `npm audit --audit-level=high`
  as a warning only. Baileys is pinned to an exact version in `server/package.json`; upgrade it on purpose.
- Logs never contain message text, and phone numbers are cut to their last 4 digits (`observability/logger.js`).

## Server setup

**Fresh VPS in one command** (Ubuntu/Debian, as root; point the domain's DNS A record at the server first):
`curl -fsSL https://raw.githubusercontent.com/hp4274/whatsapp-bot/main/scripts/setup-vps.sh | sudo bash -s -- bot.example.com admin@example.com`.
`scripts/setup-vps.sh` does everything below except the SSH lock-down: Node 24, pm2 under its own `whatsapp`
user, a `.env` with a generated encryption key, Caddy with automatic HTTPS, ufw and NTP.

- **User and memory.** Run the app as its own non-root user (e.g. `adduser --disabled-password whatsapp`), with
  pm2 started by that user. The memory cap is `max_memory_restart: '1G'` in `ecosystem.config.cjs`; pm2 restarts
  the app above it.
  Moving an install that ran as root: as root `pm2 delete whatsapp-bot; pm2 unstartup`. Move
  `/root/.whatsapp_sender_web` to the new user's home (or set `WHATSAPP_SENDER_HOME` to a fixed path in the
  `env` of `ecosystem.config.cjs`), then `chown -R whatsapp:whatsapp` it and `/var/www/whatsapp-bot`, and
  `chmod 700` the data folder. As the user: `pm2 start ecosystem.config.cjs; pm2 save; pm2 startup` (run the
  command it prints). From then on run deploy only as that user (`sudo -u whatsapp bash scripts/deploy.sh`),
  never as root: a root copy reads a different data folder and two processes would fight over the same logins.
- **SSH and firewall.** SSH with keys only: `PasswordAuthentication no` and `PermitRootLogin no` in
  `/etc/ssh/sshd_config`. Firewall (e.g. `ufw default deny incoming; ufw allow OpenSSH; ufw allow 443/tcp`)
  lets in SSH and HTTPS only; outbound allows 80/443 (plus DNS and NTP).
- **Clock.** Keep NTP on (`timedatectl set-ntp true`; `timedatectl` shows `System clock synchronized: yes`).
  Alert signatures, receipts and the 48h block check all depend on the clock.
- **Egress IP.** One fixed outbound IP per server. No rotating proxies or VPNs: a number that moves between
  IPs looks less trustworthy, not more.

## Rotation every 90 days

| What | How |
| --- | --- |
| `WHATSAPP_ENCRYPTION_KEY` | First, whether or not `WHATSAPP_ENCRYPT_AUTH` is on: save the new key off the server before restarting (backups are re-encrypted with it on start, so the old copy stops opening them). Then "Changing the key" above. After the next daily backup, run the restore test with the saved new key, and only then drop `WHATSAPP_ENCRYPTION_KEY_PREVIOUS`. |
| API keys | Create a new key for the tenant (`/api-keys`), switch the client over, then revoke only the old one (`DELETE /api/api-keys/:id` as tenant admin, or the developer screen). `POST /api/admin/tenants/:id/api-keys/revoke` revokes every key of the tenant: emergency use only. `security.apiKeyMaxAgeDays` (e.g. 90) enforces the rotation. |
| `OPS_ALERT_SECRET` | "Changing `OPS_ALERT_SECRET`" above: two signatures overlap until the receiver uses the new secret. |

Monthly: run the restore test above and note the date.

## Environment variables

| Variable | What it does |
| --- | --- |
| `WHATSAPP_SENDER_HOME` | Data folder (default `~/.whatsapp_sender_web`): database, logins, backups. |
| `WHATSAPP_ENCRYPTION_KEY` | Encrypts channel settings, backups and (with the flag) login files. Back it up off the server. |
| `WHATSAPP_ENCRYPTION_KEY_PREVIOUS` | Only while changing the key. |
| `WHATSAPP_ENCRYPT_AUTH` | `1` encrypts login files. One way: undo only with `npm run auth:decrypt`. |
| `WHATSAPP_ENCRYPTION_KEY_BACKUP_CONFIRMED` | The key id you have saved off the server. Without it matching, the flag will not turn on. |
| `OPS_ALERT_WEBHOOK`, `OPS_ALERT_SECRET`, `OPS_ALERT_SECRET_PREVIOUS` | See "Ops alerts". |
| `PORT`, `HOST`, `PUBLIC_BASE_URL`, `TRUST_PROXY`, `NODE_ENV`, `LOG_LEVEL` | Usual web server settings. |
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | First super admin account. The password is re-applied on every start (resetting a changed password and signing the admin out), so remove it from the environment (and `pm2 save`) after the first login and change the password in the app. If unset, a generated password is printed to the pm2 log: change it and clear it from the logs. |
| `WHATSAPP_SENDER_FAST`, `WHATSAPP_SENDER_SANDBOX` | Test only, never in production. `FAST=1` turns off the daytime, rest and quiet-time holds; `SANDBOX` turns on the fake transport. |
