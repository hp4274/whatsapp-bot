# Bulk health and security todo

Every item was checked against the code. **[app]** = built in this repo. **[ops]** = server setup, documented. File references are where the change goes.

## Already done or not true (no work)
- **Typing indicator before each send** already exists. `baileys.js:458-470` sends composing, waits, then paused; the delay comes from `humanize.js:336`, and it's switched on by `humanTiming`.
- **Rest-interval jitter** already exists (`manager.js:766-771`), as do the daily pace variation and quiet windows (`humanize.js:223-253`).
- **"The block and report brakes can never fire"** is not true. Today a block means a campaign message stuck on one tick for 24h (`manager.js:807`, `db.js:931`). A report means a complaint word in an incoming message (`app.js:3205`). Both are proxies, and section 1 redefines the block check.
- **"Two pacing models"** do not conflict when sending: QR numbers always use the level's gaps. `PACING_TIERS` is dead code and is removed in section 2.
- **"Not on WhatsApp" inflating the failure brake** does not happen; it's already counted separately.
- **Cloud API items** (131049, quality rating, §12) no longer apply because Cloud was removed.

## Later (not in this round)
- **Randomize campaign start by up to ±90 minutes.** About 5 lines in `campaigns/store.js` when a scheduled campaign starts. My recommendation is still to skip it: it exists to look less automated, and the engine's safety comes from sending less.
- **Use `messaging-history.set` as a starting signal.** Count the number's existing one-to-one chats when it links. Use that count to pre-select a higher answer in the two-question setup, so well-established numbers aren't held near the bottom. The user still confirms the answer; it never skips the questions silently.

## Rollout rule
- **Shadow mode for new brakes.** The new brakes (delivery, stuck, unstable), demotion and the promotion health gate ship behind `sending.brakesMode = 'shadow' | 'enforce'`, default `shadow`.
  - In shadow mode they are calculated and logged as `safety_events` rows with `kind: 'shadow'`, plus an admin view, but they never stop or slow sending.
  - Switch to `enforce` after 7 days of reviewing the triggers.
  - The existing brakes keep working as they do today.

## 1. Delivery health [app]
- [x] **Delivery data comes from the DB.** Compute these from `messages`, not an in-memory map, in `db.sendingLedger` (`db.js`). Both use the same window: messages sent between 2h and 24h ago. The 2h floor skips messages that simply haven't landed yet.
  - `sentWin`: messages sent in that window.
  - `deliveredWin`: of those, how many reached two ticks.
  - `stuckWin` = `sentWin − deliveredWin − failed`: still on one tick.
- [x] **Delivery brake.** `sentWin ≥ 20` and `deliveredWin / sentWin < 85%`: no bulk or new chats for 12h.
- [x] **Stuck brake.** `stuckWin / sentWin > 20%`, with the same window on both sides, so the rate can never pass 100%: no bulk or new chats for 12h. Both thresholds go in `BRAKES` (`humanize.js`), which an admin can edit.
- [x] **Block = one recipient blocked us, judged once, in a fixed window.**
  - A campaign message is judged exactly once, when it is 48h old. It counts as a block only if all three hold:
    1. it is still on one tick at 48h
    2. that recipient sent nothing inbound and had no delivery from us between hour 24 and hour 48 after it was sent
    3. the number's own delivered rate over that same 24–48h is at least 95%
  - Messages older than 48h are never judged again, so a number that stops sending can't build up blocks.
  - When the number's delivery is below 95%, a stuck message is left to the stuck brake and is never counted as a block. One incident trips one brake, not two.
  - Changes go in `db.stuckSent`, `manager.scanHealth` and a `block_checked` marker so each message is judged only once.
- [x] **Run the block and stuck check on a timer**, every 10 minutes per connected number, not only while sending. Use the app watchdog.
- [x] **Rate limits (429).** Baileys raises `err.data === 429`, message `rate-overlimit`.
  - In `baileys.js #send`, tag the error `RATE_LIMITED`.
  - The manager waits at least 90s before retrying (today it retries after 5–10s, `manager.js:1083`).
  - 3 rate limits in 1 hour turn on the `restricted` brake.
  - Fix the `classifyError` regex (`errors.js`) so it matches.
- [x] **Connection handling** (`baileys.js:236-283`):
  - Bad session (500), multidevice mismatch (411) and restart required (515) are handled explicitly. A bad session clears the stored login and asks for a re-scan instead of looping.
  - The reconnect count is per socket, in memory, and starts at 0 on every clean process start. Process restarts are counted separately and never feed this brake.
  - More than 8 socket reconnects within one process lifetime and one hour turns on an `unstable` brake for 8h. That is a pause only, never a demotion.
  - An unexpected logout raises an ops alert (section 5).

## 2. Levels that go down as well as up [app]
- [x] **Growth cap: 35% over the best recent clean day.** The level's daily limit is a destination, not a minimum.
  - `todayBulk = min(levelCeiling, max(startDaily, bestCleanDay × multiplier))`
  - **`bestCleanDay`**: the most bulk messages *delivered* (not attempted) in one day over the last 7 days. Days when any brake was on are left out, so a day held down by a brake doesn't count as a low day.
  - **`multiplier`**: 1.35 normally. 1.15 if any brake turned on in the last 7 days: after a throttle the number climbs back slowly instead of jumping to the maximum.
  - **`startDaily`**: the daily limit the number started at (from the questions, or level 1's 10). It only matters when there's no clean day yet, so a promotion can't use it to jump.
  - **What this means, stated plainly:**
    - Growth is 35% a day over the best recent clean day, not over yesterday.
    - After one small campaign day, the cap goes back to `best × 1.35`, because the number has already shown it can handle that amount.
    - Example: six days at 100, then a 30 day, then the next day's cap is 135, not 40.
    - A promotion example: 40 → 54 → 60, not 40 → 60.
  - **Only brakes that are actually on count.** `brakeIn7d` and the brake days left out of the best day use only brakes that really applied: the existing ones, and the new ones once they are in `enforce` mode. Rows recorded in shadow mode (`kind: 'shadow'`) never count, so shadow mode changes nothing about sending, the growth cap included.
  - **No clean day in the last 7, for example a brake on every day:** the number holds flat instead of growing.
    - `todayBulk = min(levelCeiling, max(level 1's day (10), the most recent day's delivered count))`, with a multiplier of 1.0.
    - `startDaily` is not used here, so a number that skipped the questions can't jump back to the plan limit after a week of brakes.
  - **`startDaily` applies only when there is no delivered bulk history at all**: a new number, or one whose history restarted after a ban or a number change.
  - Goes in `allowanceFrom` (`safety.js`). The ledger gets `bestCleanDay7`, `lastDayDelivered`, `hasHistory` and `brakeIn7d`. Brake days come from the `safety_events` rows written by brakes that really applied.
- [x] **Promotion requires good health.** A number only moves up if, over 7 days:
  - at least 92% of messages were delivered,
  - at most 5% got stuck,
  - at least 10% of people replied (once 40 or more were reached),
  - at most 3% failed.

  Goes in `meets()` (`humanize.js`).
- [x] **Demotion.**
  - Delivered below 85% or stuck above 20%: drop 2 levels.
  - Delivered below 90% or replies below 5%: drop 1 level.
- [x] **Probation after a demotion.** No promotion for 48h after a demotion. After that, a promotion needs two health checks in a row that pass, at least 6h apart. Store `demoted_at`, `clean_checks` and `last_level` in `channel_ops`. This stops the level bouncing up and down.
- [x] **Idle decay.** Today a number drops one level after 3 idle days. Extend it: one more level for every further 3 idle days, down to the starting level.
- [x] **Audit log of level changes.** Every computed change (promote, demote with its reason, probation hold, idle) writes a `safety_events` row with `kind: 'level'`, the old and new level, and a reason code. Show it in the admin number view.
- [x] **Remove the leftover pacing table.** Delete `PACING_TIERS` and its fallback in `paceFor` (`safety.js:145-201`). Rewrite `docs/BULK_MESSAGING_GUIDE.md` to match the code.

## 3. Choosing which number sends [app]
- [x] **Health-aware routing.** In `quotaLeft` (`channelOps.js:123`), the `quota` routing skips numbers with an active delivery, stuck, unstable, failure, block or restricted brake. Among the rest, the most remaining quota wins, and ties go to the higher delivered rate. In shadow mode, routing ignores the new brakes.

## 4. Security [app]. Encryption goes last and behind a flag.
- [x] **One login folder per number.** The default number stops sharing the root `SESSION_DIR` (`app.js:1903`). A lock file in each login folder stops a second process from using it.
- [x] **QR code expiry.** Use the `qrTimeout` setting (180s; today nothing reads it, `config.js:52`). After 3 unscanned codes, stop and show "QR expired, try again". The connection page shows a countdown.
- [x] **Daily encrypted backup.**
  - `VACUUM INTO` a temporary file, then encrypt it with `security/crypto.js` (AES-256-GCM, streamed), then delete the plaintext copy. The login folders are copied already encrypted.
  - Saved under `backups/YYYY-MM-DD/`, keeping 7 days.
  - The admin view shows the last backup.
  - Backups contain phone numbers, so a plaintext copy is never kept.
- [x] **Monthly restore test.** A `npm run restore -- <dir>` script decrypts a backup into a scratch folder and opens it read-only, to check the tables and row counts. Write it up in `docs/OPS.md` as a monthly task, with a log line each time it's run.
- [x] **API key lifetime.** *(server done, enforced on /api/v1)*
  - An optional platform-wide maximum key age (a policy field).
  - An expiry date field in the developer screen.
  - A warning 14 days before a key expires.
- [x] **Dependencies.**
  - Pin Baileys to an exact version.
  - `npm ci` in `scripts/deploy.sh`.
  - Take `package-lock.json` out of `.gitignore`.
  - Run `npm audit --audit-level=high` in CI and in deploy, as a warning only, never blocking the build. *(the repo has no CI config, so it runs only in `scripts/deploy.sh`)*
- [x] **Crash restarts.** On `uncaughtException`, log it and exit so pm2 restarts the app. Add `ecosystem.config.cjs` with `max_memory_restart`, `exp_backoff_restart_delay` and `max_restarts`. Restarts are counted in a metric only; they never count toward the reconnect brake.
- [x] **Log redaction.**
  - Logs never contain message bodies.
  - Phone numbers are masked to their last 4 digits.
  - Apply this in `observability/logger.js`, which already has redaction. Add a test that a send path's log lines contain neither.
- [x] **Encrypt the WhatsApp login files.** This goes last, behind the flag `WHATSAPP_ENCRYPT_AUTH=1`.
  - An auth state that wraps Baileys' file storage and encrypts every file with `crypto.js`.
  - Plaintext files are encrypted the first time they're read.
  - Tested against a copy of real login files before the flag is turned on.
  - **The flag only works one way, and this is documented in `docs/OPS.md`.** Once files are encrypted, turning the flag off would leave Baileys reading ciphertext. So:
    - If the flag is off but encrypted login files exist, startup refuses with a clear message.
    - The supported way back is `npm run auth:decrypt`: it decrypts each file with a temp-file write and a rename, then the flag can be turned off.
- [x] **Startup gate for a lost key.** Encrypted data must never be lost silently and never cause numbers to re-link.
  - Before anything that writes or links starts, the app checks a known test value against the current key, and against the previous key if one is set.
  - If neither key can decrypt it, startup refuses and an alert is sent. It never clears the logins or asks for a new QR scan.
  - The only way past the gate is the right key. Nothing in the app can skip it.
  - Turning encryption on (the flag above) also requires `WHATSAPP_ENCRYPTION_KEY_BACKUP_CONFIRMED=<key id>` to match the current key's id. That confirms the key has been saved off the server before the first file is encrypted. The monthly restore test (below) shows that the saved key really decrypts a backup.
  - In production, a missing key also stops startup: `requireEncryptionKey()` already exists and gets called here.
- [x] **Re-encrypting on key rotation.** Encrypted values carry a key id. The env var takes the current key plus the previous one: `WHATSAPP_ENCRYPTION_KEY` and `WHATSAPP_ENCRYPTION_KEY_PREVIOUS`.
  - At startup, if the stored key id differs, `reencrypt(old, new)` runs once over:
    - login files, one at a time, each written to a temp file and then renamed
    - sealed channel settings
    - backups
  - A file that fails keeps its old copy and raises an alert. Without this, changing the key would make every number re-link.

## 5. Ops alerts [app]
- [x] **One alert channel.**
  - `OPS_ALERT_WEBHOOK` sends a JSON POST, signed with HMAC-SHA256 using `OPS_ALERT_SECRET` in an `X-Signature` header (timestamp plus body, so an old alert can't be replayed).
  - Every alert is also written to `logger.error` and to the audit log.
  - **Limits:**
    - At most 1 per kind per number per hour.
    - At most 30 a hour across the whole platform.
    - Anything over a limit isn't sent, but is counted. One summary alert a hour then reports "N alerts held back, by kind". The audit log still records every alert.
  - **Changing the secret:** `OPS_ALERT_SECRET` can be set together with `OPS_ALERT_SECRET_PREVIOUS`. While both are set, the header carries two signatures (`X-Signature: t=…,v1=<current>,v0=<previous>`), so the receiver can switch secrets without losing alerts. `docs/OPS.md` describes the steps: set the new secret as current and the old one as previous, update the receiver, then remove the previous one.
- [x] **What raises an alert:**
  - an unexpected logout or a ban
  - the `unstable` brake
  - a delivery or stuck brake, including shadow triggers, labelled as shadow
  - the dead-man check: a number has messages waiting during sending hours but has sent nothing for 6h
  - a backup failing (section 4 calls `app.locals.opsAlert({ kind: 'backup_failed' })`)
  - a re-encryption failing (section 4 calls `app.locals.opsAlert({ kind: 'reencrypt_failed' })`)
- [x] **Receiver documentation.** `docs/OPS.md` shows how a receiver checks the HMAC and the timestamp.

## 6. Server setup [ops], documented in `docs/OPS.md`
- [x] Run as a non-root user with a memory cap.
- [x] SSH with keys only, password login off; firewall allows outbound 80/443 and inbound SSH/HTTPS only.
- [x] NTP keeps the clock synced. Optionally warn at startup if the clock is more than 2 minutes off.
- [x] One fixed outbound IP per server; no rotating proxies.
- [x] Rotate the encryption key every 90 days (using the re-encryption step above), the API keys every 90 days, and `OPS_ALERT_SECRET` using its two-signature overlap.
- [x] **Key backup is required, not optional.** Save the encryption key off the server before turning encryption on; the app's startup gate enforces this. Losing the key means losing every login, so a key that hasn't been backed up blocks encryption from being turned on at all.
- [x] Write down that the encryption flag only works one way and how to undo it with `npm run auth:decrypt`.
- [x] Monthly restore test (see section 4).

## Tests and checks
- `cd server && npm test` stays green, apart from the 3 known storage 429s.
- New tests, covering each of these:
  - the delivery and stuck brakes, using the same 2–24h window on both sides, with a case where old stuck messages would push the rate over 100% under the old math
  - shadow mode: logged, sending never stopped
  - the block check:
    - only counted when delivery is at least 95%
    - each message judged once, at 48h
    - an idle number with old stuck messages builds up no blocks
  - the growth cap:
    - six days at 100 then one day at 30 gives a next-day cap of at most 135
    - a brake day is left out of the best day
    - the multiplier drops to 1.15 after a brake
    - delivered counts, not attempted
    - shadow-mode rows never affect the cap
    - all 7 days braked: the cap holds flat at the latest day, never falls back to `startDaily`, and never drops below 10
  - 429 backoff
  - the reconnect count resetting on a fresh start, and process restarts never counting toward it
  - bad session handling
  - a promotion under the growth cap (40 → 54 → 60)
  - promotion requiring good health
  - demotion and probation (48h, then two passing checks)
  - level audit rows
  - QR expiry
  - backups encrypted with no plaintext left behind, and a restore round trip
  - alerts:
    - HMAC signature
    - two signatures while the secret is being changed
    - the per-number limit
    - the platform limit of 30 an hour, plus the summary alert
  - encryption safety:
    - flag off with encrypted files: startup refuses
    - `auth:decrypt` round trip
    - wrong key: startup refuses, no logins are cleared, and an alert is sent
    - the flag won't turn on without the backup-confirmed key id
  - log redaction
  - encrypted login read and write, migration of old plaintext files, and `reencrypt` with an interrupted file
  - health-aware routing
- `cd web && npx ng build` stays clean.

## Order of work
1. Sections 1, 2 and 3, in shadow mode.
2. Section 5 alerts, so the shadow triggers are visible.
3. Section 4. Encryption and re-encryption go last, behind the flag.
4. Section 6 docs.

Each section runs as its own workflow: implement, `npm test`, two reviewers (correctness, safety), then fixes. Simple edits use low effort; brakes, the growth cap and encryption use high effort.
