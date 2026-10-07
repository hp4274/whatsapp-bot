# WhatsApp Sender — Project Memory

Last updated: 2026-10-07. Multi-tenant WhatsApp automation platform: Express backend + Angular dashboard. Rewritten from an earlier Python desktop app (archived outside this repo). Phases 0-4 of `phases/README.md` turned it from a single-operator local tool into a multi-tenant SaaS foundation; see `docs/ARCHITECTURE.md` for the frozen product model.

## 1. Tech stack

| Layer | Choice |
| :-- | :-- |
| Runtime | Node.js >= 22.5 (uses built-in `node:sqlite`, `node:test`), ES modules |
| Backend | Express 5, multer 2 (uploads), qrcode (QR as data URL), xlsx (CSV/XLSX parsing) |
| WhatsApp (unofficial) | `whatsapp-web.js` ^1.34 driving Chrome/Chromium with `LocalAuth` session |
| WhatsApp (official) | Meta WhatsApp Cloud API (Graph `v23.0`) over HTTP + webhook |
| Storage | SQLite (`messages.db`) in `~/.whatsapp_sender_web` (override with `WHATSAPP_SENDER_HOME`) |
| Realtime | Server-Sent Events at `/api/events` |
| Frontend | Angular 22, standalone components, lazy routes, signals, RxJS 7.8, SCSS, no UI framework |
| Tests | `node --test` (70 tests, all passing on 2026-10-07) |
| Dev tooling | `scripts/dev.mjs` runs server (`--watch`) and web (`ng serve`) together |

Config: JSON file `config.json` in the app dir (never in source tree). Env overrides: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `PORT` (3000), `HOST` (127.0.0.1).

## 2. Repo layout

```
package.json            root scripts: install:all, dev, build, start, test
scripts/dev.mjs         combined dev launcher
phases/                 phase specs (A1..E1) + README roadmap
server/src/
  index.js              entry; serves web/dist when built; graceful shutdown
  app.js                Express app factory, all REST routes, SSE
  config.js             defaults + load/save config, paths
  db.js                 SQLite wrapper (messages, inbound, opt-outs, auto-replies)
  protocol.js           phone normalization, statuses, receipt ranking
  contacts.js           CSV/XLSX import, flexible column mapping
  paymentReminders.js   payment-reminder import + template rendering
  campaign/
    manager.js          campaign orchestration, single FIFO worker
    queue.js            message queue, state + duplicate protection
    limits.js           token-bucket RateLimiter + retry policy (backoff, jitter)
    safety.js           adaptive pacing + daily cap
    spintax.js          {a|b|c} variation engine
  autoreply/
    engine.js           keyword rule matcher + replies
    optout.js           STOP / START handling
  transports/
    base.js             transport interface + error classification
    cloudApi.js         Meta Cloud API transport
    whatsappWeb.js      whatsapp-web.js transport (QR, inbound, media)
    sandbox.js          fake transport for safe local testing
server/test/            core.test.js, safety.test.js, api.test.js
web/src/app/
  core/api.ts           typed HTTP client
  core/store.ts         signal store + SSE
  connection/ campaign/ auto-replies/ payment-reminder/ history/   lazy views
```

## 3. How it works

**Tenancy (the frame everything else sits in).** The tenant is the isolation boundary. `db.forTenant(id)` returns a prototype-delegated `Database` that filters and stamps every query by `tenant_id`. `createApp` does not mount feature routes directly: it authenticates, resolves the tenant (the user's own, or `X-Tenant-Id` for a super admin), then dispatches into `runtimeFor(tenantId).router`. Each tenant runtime is lazy and holds its own scoped DB handle, `config.json`, transport, `CampaignManager`, `AutoReplyEngine`, SSE client set, media map and `wwebjs_auth/` dir. Route handler bodies were never rewritten; they read `state.db`/`state.config` as before. Tenant 1 is the legacy install and keeps the original paths, so an existing deployment upgrades in place.

**Channels.** A `whatsapp_channel` is one registered number. The tenant runtime is only a dispatcher: it owns the channel list (`src/channels.js`) and hands each request to that channel's own runtime, which holds its transport, `CampaignManager`, `AutoReplyEngine`, SSE clients and WhatsApp Web profile dir. A request picks a channel with `X-Channel-Id` (or `?channel=`); without one it gets the tenant's default. The channel's `settings` JSON *is* the old config object, so `GET`/`PUT /api/config` became per-channel for free and no existing route changed. `db.forChannel(id)` stamps `messages.channel_id` and `inbound_messages.channel_id`; the daily cap counts per channel, history reads stay tenant-wide unless asked. One gate (`SEND_ROUTES`) enforces Rule 2 on every send: channel active, capability enabled, inside its sending window, else 409. Capabilities default to all ten on; opt-out is not one of them, so STOP is honoured even with `auto_replies` off. Business hours are evaluated in the channel's own timezone via `Intl.DateTimeFormat`. A tenant always keeps at least one channel, exactly one of which is the default.

**Messaging core (Phase 3).** Everything that sends builds a message job (`messaging/job.js`, tenant and channel required, no defaults) and hands it to the message service (`messaging/service.js`), the one way out. The service owns the unskippable checks - channel active, capability enabled, not opted out, idempotency key unused - then enqueues on the channel's `CampaignManager`, which already owned the queue, pacing, rate limit, retries and daily cap. Auto-replies used to call `transport.sendMessage` directly and skipped all of it; they no longer do. The queue is priority-ordered (`auto_reply` < `transactional` < `workflow` < `reminder` < `campaign`), FIFO within a priority. Idempotency is a partial unique index on `messages(tenant_id, idempotency_key)`; a retry returns the original message id. `messaging/errors.js` normalizes every transport's failures to one set with a retryable flag. `GET /api/queue` reports depth, in-flight, by-type, counts and the status histogram.

**Contacts (Phase 4).** `contactStore.js`, one row per number per tenant, `UNIQUE (tenant_id, phone)` as the duplicate detection. `custom_fields` (flat string map) and `tags` (array) are JSON, filtered with SQLite JSON1, so a new industry needs no migration. A segment is a stored *filter*, re-evaluated on use, so it cannot go stale; `POST /api/campaign/start` accepts `segmentId` and resolves the audience at send time, dropping anyone not messageable. Opt-out stays in `opt_outs` (the send path's authority) and is joined on read as `optedOut`/`messageable`; `opt_in_status` separately records the consent basis. Timelines are derived from `messages` + `inbound_messages`, not stored.

**Auth.** scrypt password hashes, random 32-byte bearer tokens stored as sha256, 7-day sessions, in-memory login throttle (5 fails per 10 min). Role ladder `agent < admin < owner < super_admin` is a code constant, not a table. Agents may only write `/messages` and `/inbox/mark-read`. Nobody may create or disable a user at or above their own rank. Suspending a tenant deletes its sessions immediately and makes its webhook 404. Every admin action lands in `audit_logs`. First run creates a super admin from `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD`, or prints a generated password once.

**Transport abstraction.** Everything sends through one interface (`base.js`): `connect`, `sendMessage(to, text, media?)`, `isConnected`, inbound callback. Three implementations: `cloud_api`, `whatsapp_web`, `sandbox`. Errors are classified (retryable vs permanent) so the retry policy knows what to do.

**Campaign flow.** Import contacts (CSV/XLSX, headers normalized, phone numbers normalized/validated) -> preview rendered messages -> start campaign. `manager.js` enqueues rows in SQLite and a single worker drains them FIFO. Per message: opt-out check -> spintax + `{column}` personalization -> safety pacing delay -> rate limiter -> transport send -> retries with exponential backoff + jitter -> status saved. Duplicate sends are prevented per number. Pause/resume/stop via `/api/campaign/:action`. Progress is pushed over SSE.

**Safety (`safety.js`).** Adaptive random delay between messages, tiered by batch size (4-12s for <=10 up to 40-95s for >1000), periodic long rests (every 40 msgs, 2-5 min), and a daily cap (default 250). Hitting the cap PAUSES the campaign (rows stay QUEUED) instead of failing. `/api/safety` previews pacing and budget for a batch size. Configurable in `config.json`.

**Inbound pipeline.** `whatsapp-web.js` message events (and Cloud API webhook POSTs) are stored in `inbound_messages`. Opt-out runs first (STOP/UNSUBSCRIBE/CANCEL/QUIT/OPTOUT/END -> blacklist + confirmation; START/UNSTOP/SUBSCRIBE -> re-subscribe). Otherwise the auto-reply engine matches active rules (EXACT, CONTAINS, REGEX, then FALLBACK), applies per-sender+rule cooldown (default 300s), waits a human-like typing delay (2.5-4.5s), and replies. Reply templates support `{name}`, `{sender}`, `{time_greeting}`.

**Payment reminders.** `paymentReminders.js` imports a sheet with flexible aliases (name, phone, remaining/balance/due amount, due date, custom message), validates the amount, and fills a default or custom template (`{name}`, `{remaining}`). Sent through the normal campaign pipeline, so pacing and opt-outs apply.

**Media.** `/api/media/upload` stores an attachment (image/PDF/document); campaigns send it with the text as caption on both transports.

**WhatsApp Web specifics.** QR is rendered in the UI via SSE/state. Session persists in `wwebjs_auth/` (`LocalAuth`). A Chrome profile-lock error is detected (`isProfileLockError`) and surfaced as a clear message instead of crashing the API.

**Frontend.** Routes: `login`, `connection`, `channels`, `contacts`, `campaign`, `auto-replies`, `payment-reminder`, `history`, `team` (admin+), `admin/tenants` (super admin). All but `login` are behind `authGuard`/`roleGuard`. `core/auth.ts` holds the token (localStorage), user, tenant, the super admin's acting tenant and the active channel; its `authInterceptor` adds `Authorization`, `X-Tenant-Id` and `X-Channel-Id` (never on `/api/channels` itself, which is tenant-level) and signs you out on 401. The `channels` view lists every number with live health, capability toggles, sending window and "Work on this"; picking one re-opens the SSE stream against it. `provideAppInitializer` restores the session before the first route resolves. The signal store no longer auto-starts: `store.start()` opens the SSE stream after sign-in, `store.stop()` closes it on sign-out or when leaving a tenant. Light/dark themes.

## 4. REST API (all under `/api`)

- Config/connection: `GET/PUT config`, `GET connection`, `POST connection/connect|disconnect|logout`, `GET health`
- Sending: `POST messages`, `POST contacts/import`, `POST contacts/preview`, `POST media/upload`, `GET media/:id`
- Campaign: `POST campaign/start`, `POST campaign/:action`, `GET campaign/stats`, `GET safety`, `GET history`
- Payment reminders: `POST payment-reminders/import`, `POST payment-reminders/send`
- Inbox: `GET inbox/messages`, `GET inbox/conversations`, `POST inbox/mark-read`
- Auto-replies: `GET/POST auto-replies`, `PUT/DELETE auto-replies/:id`, `POST auto-replies/preview`
- Opt-outs: `GET/POST optouts`, `DELETE optouts/:phone`
- Webhook (Cloud API, public, per tenant): `GET/POST webhook/:tenantId`, and `GET/POST webhook` for tenant 1
- Auth: `POST auth/login`, `GET auth/me`, `POST auth/logout`
- Channels: `GET/POST channels`, `GET/PATCH/DELETE channels/:id`, `POST channels/:id/default`
- Contacts: `GET/POST contacts`, `GET/PUT/DELETE contacts/:id`, `POST contacts/:id/tags`, `GET contacts/:id/timeline`, `POST contacts/import?save=true&tags=`
- Segments: `GET/POST segments`, `PUT/DELETE segments/:id`, `GET segments/:id/contacts`
- Queue: `GET queue`
- Platform (super admin): `GET/POST admin/tenants`, `PATCH admin/tenants/:id`, `GET admin/audit-logs`
- Team (admin+): `GET/POST users`, `PATCH users/:id`
- Realtime: `GET events` (SSE)

## 5. DB tables

Tenant-owned, all carrying `tenant_id`: `messages` and `inbound_messages` (both also carry `channel_id`; `messages` also carries `message_type`, `direction`, `idempotency_key`), `opt_outs`, `auto_replies`, `whatsapp_channels`, `contacts`, `segments`. Control plane: `tenants`, `users`, `sessions`, `audit_logs`.

## 6. Implemented so far

Git history: initial import -> remove zip -> `feat(phase-a)` inbound automation -> `feat(phase-b)` campaign variation + media -> `fix` combined dev startup -> `fix` keep API alive on profile lock.

- Backend rewrite in Node (port of Python protocol, config, DB, queue, limiter, transports, campaign manager, contact import) + test suite.
- Angular dashboard (connection, campaign, history) with design system, themes, SSE store.
- Sending safety: adaptive pacing, rests, daily quota, UI card on Connection page, quota/ETA on Campaign page.
- Phase A1 inbound core + schema; A2 keyword auto-reply engine; A3 opt-out compliance.
- Phase B1 spintax; B2 multi-column personalization; B3 media attachments.
- Phase D1 Angular auto-reply rule manager (`auto-replies` view).
- Payment reminder feature (server module, routes, Angular view).
- `whatsapp-web.js` profile-lock handling; `npm run dev` combined launcher.
- **Phase 0** architecture freeze: `docs/ARCHITECTURE.md` (isolation boundary, request lifecycle, roles, channel model, event/workflow/message-job formats, platform-vs-tenant config split, provider and compliance rules).
- **Phase 1** multi-tenant foundation: tenancy control plane (`src/tenancy.js`), scoped DB handles, per-tenant runtimes, auth + roles + audit log, legacy migration to tenant 1, 18 cross-tenant tests in `server/test/tenancy.test.js` (88/88 suite green).
- Angular auth layer: login page, interceptor, guards, super admin tenant console, team management, role-gated nav.
- **Phase 3** unified messaging core: message job, message service, priority queue, idempotency, normalized provider errors, `GET /api/queue`. 14 tests in `server/test/messaging.test.js`.
- **Phase 4** contacts, tags, custom fields, segments and timelines: `src/contactStore.js`, Angular `contacts` view with tag cloud, saved segments and a per-contact timeline. 17 tests in `server/test/contacts-store.test.js` (133/133 suite green).
- **Phase 2** WhatsApp channels: `src/channels.js`, per-channel runtimes, capability and sending-window gates, channel audit log, credential redaction, Angular `channels` view. 14 tests in `server/test/channels.test.js` (102/102 suite green).

**Uncommitted at time of writing:** payment reminders (`paymentReminders.js`, `payment-reminder/` view, `/api/payment-reminders/*`), auto-replies view, `phases/`, plus edits to `app.js`, `db.js`, `whatsappWeb.js`, `api.test.js`, `api.ts`, routes.

## 7. Not done yet

From `phase.md` (the SaaS roadmap):

- **PostgreSQL** — deferred. Still SQLite; `db.forTenant` is the seam that makes it a driver swap.
- **Permissions table** — deferred. Roles stay a code constant until a customer needs a custom role.
- Phase 5 templates with versioning and provider approval state
- Phase 6-7 workflow engine and durable scheduler; Phase 8-10 inbox, tickets, FAQ
- Phase 14-15 full super admin console, plans and usage metering

From `phases/`:

- C1 warm-up ramp + failure circuit breaker (auto-pause on error spike)
- C2 quality watcher + send window; B4 campaign scheduler; A4 interactive menus
- D2 Angular live inbox (API endpoints exist; no UI view yet)
- E1 AI fallback responder (Gemini/OpenAI); E2 transactional trigger API

## 8. Gotchas

- WhatsApp Web automation is unofficial and can get a number banned; safety pacing reduces but does not remove that risk. Cloud API is the compliant path and the production default.
- The webhook POST has **no signature check** (`X-Hub-Signature-256`). Pre-existing, tracked for Phase 18.
- Channel credentials sit in plaintext JSON in `whatsapp_channels.settings`. Redacted on read, not encrypted at rest. Phase 18.
- `normalizePhone(raw, cc)` is **not idempotent**: a bare `919876543210` under cc `91` becomes `91919876543210`. It takes what a human typed. Callers holding an already-normalized number must pass `{ normalized: true }` to the contact store.
- Payment reminders still enqueue through the campaign manager directly, not through the message service, so they skip the capability and idempotency checks (they do get pacing and the daily cap).
- Inbound still resolves to the tenant's **default** channel: the webhook path carries `:tenantId` but not `:channelId`. A tenant with two Cloud API numbers will attribute both to the default until that lands.
- SSE carries the bearer token as `?token=` because `EventSource` cannot set headers. Swap for a short-lived stream ticket before these URLs reach a proxy log.
- The login throttle is in-memory and per process; it resets on restart and does not survive clustering.
- The auto-reply tests wait on a real 2500-4500ms typing delay. `waitFor` in `api.test.js` defaults to 6000ms for that reason; do not lower it.
- Only one Chrome instance may use the session profile; close other windows if connect fails with the profile-lock message.
- Node < 22.5 will fail (needs `node:sqlite`).
- `.reticle-setup-crash.log` in repo root is a stray tool log, not project code.
- `.trash-phases/` holds the superseded A1-E1 phase specs, moved aside on 2026-10-07. Delete it once C1/D2/E1 are either done or re-filed.

## 9. Commands

```
npm run install:all     # install server + web deps
npm run dev             # server (:3000) + Angular dev server
npm run build           # build web into web/dist
npm start               # server only; serves web/dist if built
npm test                # server tests (node --test)
```
