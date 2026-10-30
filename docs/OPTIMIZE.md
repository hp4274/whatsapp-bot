# Optimization backlog

Everything worth optimizing in this codebase, found by reading the code (server, web app, deploy and
dependencies). Every item points at the line that costs something. **Nothing was benchmarked:** the
High / Med / Low impact labels are judgement calls based on how often each path runs. Measure before and
after (see [How to measure](#how-to-measure)).

Paths are relative to the repo root. Line numbers are as of 2026-10-30.

## Done (2026-10-30, server)

- **Database:** the five indexes below, `busy_timeout`, `PRAGMA optimize` on open, a statement cache on the shared
  connection ([db.js](../server/src/db.js)), and the sent-proto cleanup moved from every send to once an hour (reads
  still ignore anything over 14 days old).
- **Batched writes:** campaign enqueue in one transaction ([campaign/manager.js](../server/src/campaign/manager.js));
  contact import in one transaction with a savepoint per row ([contactStore.js](../server/src/contactStore.js)).
- **Quadratic paths:** audience lookup by `Map` ([campaigns/store.js](../server/src/campaigns/store.js)); the inbox sync
  reads only this tenant's new rows ([inbox/store.js](../server/src/inbox/store.js)); one opt-out read per contact page.
- **Fewer writes:** campaign stats are written only when a number changed.
- **`GET /channels`** reuses the running number's quota ([channelUsage.js](../server/src/channelUsage.js)).
- **Memory:** media keeps its path, never its bytes ([mediaStore.js](../server/src/mediaStore.js)); `receipts` is capped at
  20k; a slow SSE tab is dropped above 1 MB buffered.
- **Transport:** address book saved at most every 5s (flushed on disconnect); LID lookups run in parallel.
- **Sweep:** no overlapping passes. **`/history`:** `limit` capped at 5,000.
- **Ops:** static chunks cached for a year (`index.html` revalidated); served files log at debug; `deploy.sh` waits for
  `/api/health`, installs server deps with `--omit=dev`, and skips the web build when `web/` didn't change;
  `setup-vps.sh` installs `pm2-logrotate`. The old Chromium session (`server/.test_wwebjs`, `.wwebjs_cache`) is
  untracked and ignored.

**Left on purpose:**
- **Updating the sending limit in memory after each send.** Getting this wrong over-sends past WhatsApp's caps.
  The indexes and statement cache make the full recount cheaper instead.
- **Caching `platformPolicy()` and the auto-reply/FAQ reads.** A plan change through billing doesn't go through
  `set()`, so a cache could serve the old plan's limits.
- **`multer.diskStorage`.** The upload buffer is now freed after each request; streaming would mean reworking hashing
  and type sniffing.
- **Dropping indexes and the worker-thread backup.** Both need measurements on real data first.
- **The per-deploy `npm audit`.** Removed from `deploy.sh`; run it from CI or by hand.

## Start here

The biggest win for the fewest lines, in the order to do them.

1. **Batch the big writes in one transaction.** A 10k-recipient campaign does 10k separate commits, and a
   contact import does about 7 statements and one commit per row.
   [server/src/campaign/manager.js:456](../server/src/campaign/manager.js#L456) /
   [:567](../server/src/campaign/manager.js#L567),
   [server/src/contactStore.js:108](../server/src/contactStore.js#L108).
   Send one summary event per batch, not one per row.
2. **Stop recomputing the sending ledger after every send.** `quota.invalidate()` runs after each message, so the
   next one re-runs ~14 aggregate queries
   ([server/src/campaign/manager.js:1261](../server/src/campaign/manager.js#L1261)).
   `GET /channels` builds a fresh quota every call instead of reusing the live one
   ([server/src/channelUsage.js:39](../server/src/channelUsage.js#L39); reuse it the way
   [server/src/policy/channelOps.js:151](../server/src/policy/channelOps.js#L151) already does).
3. **Add the missing indexes and a busy timeout** (details in [Database](#database)):
   `messages(tenant_id, campaign_id, recipient)`, `messages(updated_at)`, `messages(tenant_id, created_at)`,
   `inbound_messages(tenant_id, received_at)`, `inbound_messages(tenant_id, sender, received_at)`, and
   `PRAGMA busy_timeout`.
4. **Stop holding media in RAM forever.** Every uploaded or sent file's buffer stays in `state.media` for the life of
   the process ([server/src/app.js:1618](../server/src/app.js#L1618),
   [server/src/mediaStore.js:29](../server/src/mediaStore.js#L29)). Uploads are also read into memory, up to 64 MB each
   ([server/src/app.js:133](../server/src/app.js#L133)).
5. **Rotate logs.** Every request, including each JS chunk, font and icon, is logged at info, and nothing rotates
   `~/.pm2/logs` ([server/src/observability/logger.js:149](../server/src/observability/logger.js#L149)).
6. **Let static files be cached.** Node serves `web/dist` with `max-age=0`, although the chunk names are hashed
   ([server/src/index.js:76](../server/src/index.js#L76)).
7. **Subset the icon font.** Every page loads 202 KB of render-blocking CSS and a 774 KB woff2 for ~5,000 Tabler
   icons; the app uses about 243 ([web/src/index.html:12](../web/src/index.html#L12)).
8. **Untrack the old Chromium session.** `server/.test_wwebjs` (207 files) and `server/.wwebjs_cache` are about 20 MB
   of the repo and may hold a WhatsApp Web login.

## Database

| What | Why it costs | Smallest fix | Impact |
| --- | --- | --- | --- |
| `latestRows` finds each recipient's last row with `SELECT MAX(rowid) … WHERE campaign_id = … AND recipient = …` ([campaigns/store.js:533](../server/src/campaigns/store.js#L533)) | Only `campaign_id` is indexed, so each row's subquery scans the whole campaign: quadratic. Runs for the report, retry and retarget. | Index `messages(tenant_id, campaign_id, recipient)` | High |
| Ban guard runs every minute: `WHERE m.direction = 'outbound' … AND m.updated_at >= ?` ([policy/channelOps.js:250](../server/src/policy/channelOps.js#L250)) | No index has `updated_at`: a full scan of every tenant's messages, every minute. It also does one upsert per channel per run. | Index `messages(updated_at)` (also helps the ledger's `failures` / `unsent`) | High |
| Inbox list re-syncs when the global `MAX(rowid)` moves ([inbox/store.js:176](../server/src/inbox/store.js#L176)) | During any campaign, every open inbox re-runs a `UNION ALL … GROUP BY phone` over that tenant's whole history. | Check per tenant, or update `conversations` inside `insert` / `insertInbound` and drop the sync | High |
| No composite index for tenant + time: `history` ([db.js:693](../server/src/db.js#L693)), `bulkCountsSince` ([:1168](../server/src/db.js#L1168)), `getInboundMessages` ([:1213](../server/src/db.js#L1213)), `getConversations` ([:1229](../server/src/db.js#L1229)) | They filter by tenant and sort by time with only single-column indexes. | `messages(tenant_id, created_at)`, `inbound_messages(tenant_id, received_at)`, `inbound_messages(tenant_id, sender, received_at)` | Med |
| No `PRAGMA busy_timeout` (WAL and `synchronous=NORMAL` are set at [db.js:493](../server/src/db.js#L493)) | A second connection (backup, restore script) gets `SQLITE_BUSY` right away instead of waiting. | `PRAGMA busy_timeout = 5000` | Med |
| 471 `prepare()` calls, none cached, including hot paths: `insert` ([db.js:561](../server/src/db.js#L561)), `updateStatus` ([:597](../server/src/db.js#L597)), `applyReceipt` ([:606](../server/src/db.js#L606)), `insertInbound` ([:1189](../server/src/db.js#L1189)) | Each send and receipt recompiles its SQL. | A lazy statement cache on `Database`, keyed by SQL text | Med |
| 11 indexes on `messages` ([db.js:152](../server/src/db.js#L152)) | Every `updateStatus` maintains them. `idx_messages_status` (low selectivity) and `idx_messages_tenant` (covered by the composites) are probably unused. | Confirm with `EXPLAIN QUERY PLAN`, then drop them | Med |
| Contact list checks opt-outs one row at a time ([contactStore.js:335](../server/src/contactStore.js#L335), up to 5,000 rows); `listSegments` runs one `count()` per segment ([:432](../server/src/contactStore.js#L432)) | One extra query per contact. | `LEFT JOIN opt_outs` in `find` | Med |
| Unbounded reads: `/history` takes any `limit` ([app.js:1867](../server/src/app.js#L1867)); `getConversations`, `getOptOuts`, `getAllOptOuts` have no LIMIT ([db.js:1218](../server/src/db.js#L1218), [:1281](../server/src/db.js#L1281), [:1292](../server/src/db.js#L1292)); `getAllOptOuts` is loaded on every campaign queue ([campaign/manager.js:402](../server/src/campaign/manager.js#L402)); `/number-collections` parses every tenant's list of up to 50k numbers ([app.js:2929](../server/src/app.js#L2929)) | Cost grows with the data, not with the request. | Cap limits, `NOT EXISTS` in SQL, counts only in list views | Med |
| `GET /campaigns/:id/stats` writes a snapshot ([campaigns/store.js:447](../server/src/campaigns/store.js#L447)); the detail page polls it | A write on every read. | Write only when the numbers changed | Low |
| `saveSentProto` runs `DELETE … WHERE at < ?` on every send ([db.js:1303](../server/src/db.js#L1303)) | A delete per message for a 14-day cleanup. | Move it into the hourly sweep | Low |
| Daily backup runs `VACUUM INTO` on the main thread ([backup.js:101](../server/src/backup.js#L101)) | HTTP and every WhatsApp socket stall while it copies. | Run it in a `worker_thread` with its own read-only connection | Low |
| The live database never shrinks (no `auto_vacuum`, no `PRAGMA optimize`) | Old rows are deleted regularly, but the file only grows. | `PRAGMA optimize` daily; monthly `VACUUM` or `auto_vacuum=INCREMENTAL` | Low |

## Campaign and sending engine

| What | Why it costs | Smallest fix | Impact |
| --- | --- | --- | --- |
| Enqueue inserts one row and emits one event per recipient ([campaign/manager.js:567](../server/src/campaign/manager.js#L567), [:578](../server/src/campaign/manager.js#L578)) | 10k commits, and 10k SSE messages to every open tab. | One transaction, one prepared insert, one summary event | High |
| Ledger cache dropped after each send ([campaign/manager.js:1261](../server/src/campaign/manager.js#L1261)); ledger queries at [db.js:777](../server/src/db.js#L777)–[913](../server/src/db.js#L913) | Several of those queries scan a number's whole delivery history, once per message. | Update `bulkToday`, `lastHour` and `lastSentAt` in memory after a send; full recompute every 30s | High |
| `GET /channels` builds `new DailyQuota` per channel per call ([channelUsage.js:39](../server/src/channelUsage.js#L39)); the web polls it every 30s | ~14 queries plus `channelQuality` per channel per poll. | Use `runtime.state.manager.quota` when present | High |
| `#contactFor` runs `campaign.audience.find(...)` per row ([campaigns/store.js:914](../server/src/campaigns/store.js#L914)), from `recover` ([:795](../server/src/campaigns/store.js#L795)) and `retryFailed` ([:501](../server/src/campaigns/store.js#L501)) | Quadratic; `recover` runs on the 5s sweep after a restart. | Build a `Map` of digits to entry once per call | High |
| `platformPolicy()` recomputed at 33 call sites ([policy/index.js:258](../server/src/policy/index.js#L258)), twice per routed POST ([app.js:2182](../server/src/app.js#L2182)) and per inbound message | Subscription lookup, plan lookup and three `JSON.parse`s each time. | 5s per-tenant cache like `securityFor` ([app.js:2268](../server/src/app.js#L2268)), cleared on `set()` | Med |
| Each inbound message lists all auto-reply rules ([autoreply/engine.js:249](../server/src/autoreply/engine.js#L249)) and all FAQ items ([knowledge/store.js:319](../server/src/knowledge/store.js#L319)) | Two full reads per incoming message. | Per-tenant cache, cleared on write | Med |
| The 5s sweep has no overlap guard ([app.js:3453](../server/src/app.js#L3453)) | It awaits slow work, so two runs can overlap; the comment at [:3286](../server/src/app.js#L3286) assumes they can't. | A `running` flag | Med |

## Memory

| What | Why it costs | Smallest fix | Impact |
| --- | --- | --- | --- |
| Media buffers kept in `state.media` ([app.js:1618](../server/src/app.js#L1618)); `MediaStore` caches whole files and never evicts ([mediaStore.js:29](../server/src/mediaStore.js#L29), [:59](../server/src/mediaStore.js#L59)) | Every image and video stays in RAM until restart, inside a process capped at 1 GB. | Keep metadata and the path; Baileys already sends from `{ url: filePath }` ([transports/baileys.js:1063](../server/src/transports/baileys.js#L1063)) | High |
| Video uploads use `multer.memoryStorage()` with a 64 MB limit ([app.js:133](../server/src/app.js#L133)) | A few uploads at once add hundreds of MB. | `multer.diskStorage` into a temp folder in the data dir | Med |
| `receipts` Map grows one entry per message and is never cleared ([transports/baileys.js:179](../server/src/transports/baileys.js#L179)) | Grows for the life of the socket. | Cap it (about 10k) or drop entries after 48h | Med |
| The per-tenant runtime map never evicts ([app.js:2285](../server/src/app.js#L2285)); the watchdog touches every active tenant every 30s ([:3409](../server/src/app.js#L3409)) | Memory grows with every tenant ever loaded. | Evict idle runtimes that have no connected socket | Low |
| SSE `broadcast` ignores `write()` returning false ([app.js:3688](../server/src/app.js#L3688)) | A slow tab buffers without limit. | Drop or close the client when it can't keep up | Low |
| One pm2 process runs HTTP, every tenant's socket and the scheduler, with `max_memory_restart: '1G'` ([ecosystem.config.cjs](../ecosystem.config.cjs)) | Any memory restart disconnects every tenant at once. | Fix the leaks above first; later run the scheduler and transports as their own pm2 app | Med |

## WhatsApp transport

| What | Why it costs | Smallest fix | Impact |
| --- | --- | --- | --- |
| The whole address book is rewritten with `writeFileSync` on every changed `contacts.update` ([transports/baileys.js:847](../server/src/transports/baileys.js#L847)), after two `JSON.stringify`s per contact ([:838](../server/src/transports/baileys.js#L838)) | History sync sends many batches, so this blocks the event loop repeatedly. | Debounce about 5s and use async `writeFile` | Med |
| Group members resolved one at a time: `await phoneOf(sock, p)` ([transports/baileys.js:726](../server/src/transports/baileys.js#L726), same at [:765](../server/src/transports/baileys.js#L765)) | Serial lookups across every member of every group. | `Promise.all(participants.map(...))` | Low |

## Web app

Already good: all 32 routes lazy-load, ngx-charts sits in its own lazy chunk, every component is OnPush,
and timers are cleaned up. Initial JS is about 385 KB, under the 500 KB budget.

| What | Why it costs | Smallest fix | Impact |
| --- | --- | --- | --- |
| The full Tabler icon CSS (202 KB) and woff2 (774 KB) load on every page; a 1 MB `.woff` fallback ships too ([web/src/index.html:12](../web/src/index.html#L12)) | About 243 of ~5,000 icons are used; the CSS blocks rendering. | Subset font and CSS from the used names, or inline SVG; drop the `.woff` | High |
| Google Fonts stylesheet on the critical path ([web/src/index.html:11](../web/src/index.html#L11)) | A third-party request blocks first paint. | Self-host Inter woff2 with `font-display: swap` and a preload | Med |
| A global 1s clock that never pauses ([web/src/app/core/store.ts:147](../web/src/app/core/store.ts#L147)) | Re-runs `quiet` in [campaigns-list.ts:146](../web/src/app/campaigns/campaigns-list.ts#L146) and per-row relative-time methods every second, even in hidden tabs. | A minute signal for "x min ago"; keep 1s only for countdowns; pause on `visibilitychange` | Med |
| History renders every record, no limit ([web/src/app/history/history.ts:88](../web/src/app/history/history.ts#L88)) | The API supports `limit` ([core/api.ts:582](../web/src/app/core/api.ts#L582)) but it isn't passed. | `limit` plus "load more", as `campaign-recipients.ts` does | Med |
| Inbox renders up to 300 rows ([inbox/inbox.ts:293](../web/src/app/inbox/inbox.ts#L293)) and Records up to 500 ([records/records.ts:44](../web/src/app/records/records.ts#L44)), unvirtualized | Hundreds of DOM rows, each calling a time formatter. | `cdk-virtual-scroll` (`@angular/cdk` is already installed) or a 50-row window | Med |
| The fleet-health poll ignores hidden tabs ([web/src/app/app.ts:163](../web/src/app/app.ts#L163)) | Polls every 60s in the background. | `if (!document.hidden) load()` | Low |
| Campaign detail polls every 3s while running, even though SSE covers it ([campaigns/campaign-detail.ts:265](../web/src/app/campaigns/campaign-detail.ts#L265)) | Requests the server doesn't need. | Poll only while `!store.streamOnline()` and the tab is visible | Low |
| A new `Intl` formatter per call: [campaign-format.ts:49](../web/src/app/campaigns/campaign-format.ts#L49), [wa-format.ts:197](../web/src/app/campaign/wa-format.ts#L197), [channel-meta.ts:112](../web/src/app/channels/channel-meta.ts#L112), [records.ts:282](../web/src/app/records/records.ts#L282), [plans-api.ts:71](../web/src/app/admin/plans-api.ts#L71) | Formatters are expensive to build, and these run per row and per second. | Module-level cache, like `rtf` in [contact-util.ts:12](../web/src/app/contacts/contact-util.ts#L12) | Low |
| Template methods allocate arrays per change detection: `countEntries()` ([history.ts:113](../web/src/app/history/history.ts#L113)), `activeBrakes` / `shadowTriggers` in [channels-ops.html](../web/src/app/admin/channels-ops.html), `planMeters` in [ops.html](../web/src/app/admin/ops.html) | New arrays every check. | `computed()`, or precompute per row | Low |
| Editable lists tracked by `$index`: [contact-drawer.html:217](../web/src/app/contacts/contact-drawer.html#L217), [inbox-contact-panel.html:134](../web/src/app/inbox/inbox-contact-panel.html#L134), [policy-table.html:32](../web/src/app/admin/policy-table.html#L32), [import-wizard.html:155](../web/src/app/contacts/import-wizard.html#L155) | DOM gets re-rendered or reused for the wrong row. | Track by a stable key | Low |
| `api.settings()` is fetched separately by auto-replies and three school tabs; `api.usage()` by ops and analytics | Duplicate requests, no shared cache in [core/api.ts](../web/src/app/core/api.ts). | A shared settings signal, invalidated by the existing `store.watch` topics | Low |
| Empty dead files: `web/src/app/admin/accounts.component.ts`, `web/src/app/admin/tenant-settings.component.ts` | Noise. | Delete | Low |

## Deploy and ops

| What | Why it costs | Smallest fix | Impact |
| --- | --- | --- | --- |
| No log rotation; every request logged at info, static files included ([observability/logger.js:149](../server/src/observability/logger.js#L149), mounted at [app.js:2256](../server/src/app.js#L2256)) | `~/.pm2/logs` grows until the disk fills. | `pm2 install pm2-logrotate` in [scripts/setup-vps.sh](../scripts/setup-vps.sh); log successful non-`/api` requests at debug | High |
| `express.static` with default headers ([server/src/index.js:76](../server/src/index.js#L76)) although chunks are hashed ([web/angular.json:51](../web/angular.json#L51)) | Every visit revalidates every chunk through the process that runs the sockets. | `immutable, maxAge: '1y'` for hashed files and `no-cache` for `index.html`; better, Caddy `file_server` for `web/dist` | High |
| [scripts/deploy.sh](../scripts/deploy.sh) never checks the app came back after `pm2 startOrRestart` | A failed boot (for example the encryption-key gate) still prints "complete". | Curl `/api/health` in a loop after restart; `exit 1` on failure | High |
| `deploy.sh` rebuilds `web` every time, runs `npm audit` every time, and installs server dev deps | Slow deploys and a longer window before restart. | Skip the web build when `web/` didn't change; `--omit=dev` for the server; move the audit to a weekly job | Low |
| Uploads live in `server/uploads`, inside the checkout ([app.js:141](../server/src/app.js#L141)), and the backup skips them | Lost on a re-clone, never backed up, never cleaned. | Move them under the data dir, add them to the backup, clean files no campaign references | Med |

## Dependencies and repo

| What | Why it costs | Smallest fix | Impact |
| --- | --- | --- | --- |
| `server/.test_wwebjs` (207 files) and `server/.wwebjs_cache` are tracked: about 20 MB, unused by code or tests | Every clone and every VPS `git pull` carries them, and they may hold a WhatsApp Web session. | `git rm -r --cached`, add both to `.gitignore`; rewrite history only if size matters | High |
| `xlsx@0.18.5` parses user uploads ([contacts.js:138](../server/src/contacts.js#L138), [campaign/importer.js:35](../server/src/campaign/importer.js#L35)) | Known advisories CVE-2023-30533 (prototype pollution) and CVE-2024-22363 (ReDoS); the npm package is no longer updated. | SheetJS's own CDN build (0.20.x) or `exceljs` | Med |
| ngx-charts (and with it d3, `@angular/cdk`, `@angular/animations`) serves one admin page ([admin/ops.ts:15](../web/src/app/admin/ops.ts#L15)) | A 276 KB lazy chunk for a few charts. | A small SVG chart would remove all four; low priority because it is already lazy | Low |
| Root files tracked by mistake: `MEMORY.md`, `todo.md`, `.claude/MEMORY.md`, `.claude/TODO.md` (although `.gitignore` lists `.claude/`), `phases/`, `sample_contacts.csv` | Clutter in every checkout. | `git rm --cached`; move the CSV to `server/test/fixtures` if a test needs it | Low |
| `engines` says `node >=22.5.0` ([server/package.json](../server/package.json)); the VPS setup installs Node 24 | The declared floor isn't what runs in production. | Raise it to `>=24` | Low |
| A test waits 1.1s on a real clock ([server/test/number-change.test.js:78](../server/test/number-change.test.js#L78)) | Slows every test run. | `mock.timers` or an injected clock | Low |

## Checked and fine

So nobody audits these again:

- Server dependencies are all used (`qrcode`, `multer`, `@cacheable/node-cache`; `puppeteer-core` is dev-only for screenshot scripts).
- SQLite already runs in WAL with `synchronous=NORMAL`.
- Web: every route lazy-loads, every component is OnPush, every component timer is cleared on destroy, `store.watch` is debounced, and Contacts and Campaigns page on the server.
- `@angular/cdk` and `@angular/animations` look unused but are peer dependencies of ngx-charts.

## How to measure

- **Indexes and queries:** run `EXPLAIN QUERY PLAN <query>` in `sqlite3` against a copy of the database. Look for
  `SCAN messages`, which means no index. Check again after adding each index.
- **Send throughput:** time a 1,000-recipient campaign's enqueue in the sandbox transport
  (`WHATSAPP_SENDER_SANDBOX=1`) before and after the transaction change.
- **Memory:** watch `pm2 monit` and `GET /api/metrics` while uploading media and running a campaign. The process
  should level off, not climb.
- **Web:** `npm --prefix web run build` prints chunk sizes; Lighthouse in Chrome DevTools for the icon and font work
  (first contentful paint, total transfer).
- **Logs and disk:** check `du -sh ~/.pm2/logs` on the VPS daily for a week.
