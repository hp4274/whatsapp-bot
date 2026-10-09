# WhatsApp Sender

Multi-tenant WhatsApp automation platform. Express 5 backend + Angular 22 dashboard. Supports both the official Meta Cloud API and the unofficial `whatsapp-web.js` browser transport.

---

## Features

- **Multi-tenant** — isolated data, config, and runtime per tenant; channels are first-class resources (multiple numbers per tenant)
- **Transports** — Meta Cloud API (production), whatsapp-web.js (QR browser session), Sandbox (safe local dev)
- **Campaign engine** — bulk messaging with adaptive pacing, daily cap, dedup, pause/resume/stop, spintax, per-contact personalization
- **Contacts** — CSV/XLSX import, tags, custom fields, segments (stored filters), per-contact timeline
- **Templates** — versioned message templates with variable interpolation, draft/approval flow
- **Workflow engine** — durable multi-step automations; runs survive restarts; 12 actions (send, wait, branch, tickets, etc.)
- **Scheduler** — generic durable job runner with leases, retries and dead-lettering
- **Inbox** — unified conversation view, human handoff, bot pause/resume, unread counters
- **Tickets** — append-only event log, SLA per priority, agent assignment, customer notifications
- **Knowledge base** — FAQ with exact/contains/regex/fuzzy matching (Sørensen-Dice), miss analytics
- **Business objects** — generic typed entities (orders, appointments, etc.) with workflow emission
- **Billing** — subscription plans, usage tracking, lifecycle management
- **Campaigns v2** — audience-resolved campaigns, scheduling, stats
- **Automation recipes** — 13 pre-built workflow templates
- **Public API** — scoped API keys, idempotency, v1 REST endpoints, webhook delivery
- **Observability** — structured request logging, metrics snapshot, queue depth gauges
- **Security** — AES-256-GCM credential encryption, webhook signature verification, rate limiting, scrypt password hashes, audit log
- **Auto-replies** — keyword rules (exact/contains/regex/fallback), per-sender cooldown, opt-out compliance (STOP/START)
- **Payment reminders** — flexible sheet import, campaign-pipeline delivery
- **Realtime** — Server-Sent Events for live status, QR codes, campaign progress

---

## Requirements

- **Node.js >= 22.5** (uses built-in `node:sqlite` and `node:test`)
- Chrome/Chromium — only if using the `whatsapp_web` transport

---

## Installation

```bash
npm run install:all   # installs server + web dependencies
```

---

## Development

```bash
npm run dev           # Express on :3000 + Angular dev server (concurrent)
```

For server-only:

```bash
npm run dev:server
```

For frontend-only:

```bash
npm run dev:web
```

---

## Production

```bash
npm run build         # build Angular into web/dist
npm start             # serve API + frontend from one process on :3000
```

The server auto-creates a super admin on first run. Either set the env vars or read the generated password from stdout (printed once):

```bash
SUPER_ADMIN_EMAIL=admin@example.com \
SUPER_ADMIN_PASSWORD=changeme \
npm start
```

---

## Configuration

Config lives in `~/.whatsapp_sender_web/config.json` — never in the source tree. Override the directory with:

```bash
WHATSAPP_SENDER_HOME=/path/to/data npm start
```

Other env vars:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `WHATSAPP_ACCESS_TOKEN` | — | Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | — | Cloud API phone number ID |

All other settings (transport, rate limits, retry policy, safety pacing, webhook, sending windows) are managed through the dashboard or `PUT /api/config`.

---

## Testing

```bash
npm test              # runs server test suite (node --test, no framework)
```

406 tests, all passing.

---

## Architecture

```
package.json            root scripts
scripts/dev.mjs         concurrent dev launcher
server/src/
  index.js              entry point; graceful shutdown; first-run super admin
  app.js                Express factory; all REST routes; SSE
  config.js             defaults, load/save, env overrides
  db.js                 SQLite wrapper; db.forTenant(id) / db.forChannel(id)
  tenancy.js            multi-tenant control plane; roles; audit log
  channels.js           per-channel runtimes; capability gates; sending windows
  protocol.js           phone normalization; message statuses
  contactStore.js       contacts; tags; custom fields; segments
  messaging/            unified send pipeline (job + service + priority queue)
  campaign/             campaign orchestration; rate limiter; safety pacing
  autoreply/            keyword engine; opt-out compliance
  transports/           cloud_api | whatsapp_web | sandbox
  templates/            versioned templates; variable interpolation
  workflows/            durable workflow engine; run state machine
  scheduler/            generic job store; lease-based workers
  inbox/                conversations; human handoff
  tickets/              ticket store; SLA; event log
  knowledge/            FAQ matcher; miss analytics
  objects/              typed business objects; workflow emission
  billing/              plans; usage; subscription lifecycle
  campaigns/            audience-resolved campaign CRUD + execution
  recipes/              13 pre-built workflow templates
  publicapi/            API keys; idempotency; v1 REST; webhooks
  observability/        structured logging; metrics
  security/             credential encryption; signature verification; rate limit
  schema.js             module schema registry (features self-register)
server/test/            node:test suites
web/src/app/            Angular 22 standalone components; signal store; SSE
```

**Isolation model.** `db.forTenant(id)` returns a prototype-delegated wrapper that stamps and filters every query by `tenant_id`. Each tenant runtime is lazy-initialized and holds its own config, transport, campaign manager, auto-reply engine and SSE client set. Channels nest inside tenants the same way.

**Send pipeline.** Every send — campaign, workflow, auto-reply, transactional — goes through `messaging/service.js`, the single exit point. Checks run in order: channel active → capability enabled → not opted out → idempotency key unused → enqueue. The queue is priority-ordered (auto_reply < transactional < workflow < reminder < campaign), FIFO within a priority.

**Workflow state.** The run row is the state. `advance()` runs steps until a wait/terminal/error, writes `status='waiting'` + `resume_at`, and returns. The sweeper polls `dueRuns` on a timer and resumes them. Editing a live workflow never affects runs in flight (runs pin their version).

---

## REST API

All routes under `/api`. Authentication: `Authorization: Bearer <token>`.

| Group | Routes |
| --- | --- |
| Auth | `POST auth/login`, `GET auth/me`, `POST auth/logout` |
| Config | `GET/PUT config`, `GET connection`, `POST connection/connect\|disconnect\|logout`, `GET health` |
| Channels | `GET/POST channels`, `GET/PATCH/DELETE channels/:id`, `POST channels/:id/default` |
| Messaging | `POST messages`, `POST media/upload`, `GET media/:id`, `GET queue` |
| Contacts | `GET/POST contacts`, `GET/PUT/DELETE contacts/:id`, `POST contacts/:id/tags`, `GET contacts/:id/timeline`, `POST contacts/import` |
| Segments | `GET/POST segments`, `PUT/DELETE segments/:id`, `GET segments/:id/contacts` |
| Campaign | `POST campaign/start`, `POST campaign/:action`, `GET campaign/stats`, `GET safety`, `GET history` |
| Campaigns v2 | `GET/POST campaigns`, `GET/PUT/DELETE campaigns/:id`, `POST campaigns/:id/start\|pause\|cancel`, `GET campaigns/:id/stats` |
| Templates | `GET/POST templates`, `GET/PUT/DELETE templates/:id`, `POST templates/:id/revert\|preview` |
| Workflows | `GET/POST workflows`, `GET/PUT/DELETE workflows/:id`, `GET workflows/:id/runs`, `GET workflow-runs/:runId`, `POST workflow-runs/:runId/retry\|stop`, `POST events` |
| Jobs | `GET jobs`, `POST jobs/:id/retry`, `DELETE jobs/:id` |
| Inbox | `GET conversations`, `GET conversations/:id`, `POST conversations/:id/reply\|assign\|status\|read\|notes\|takeover\|handback`, `GET inbox/stats` |
| Tickets | `GET/POST tickets`, `GET/PATCH tickets/:id`, `POST tickets/:id/notes\|satisfaction`, `GET tickets/:id/events`, `GET tickets/stats` |
| FAQ | `GET/POST faq`, `GET/PUT/DELETE faq/:id`, `POST faq/match`, `GET faq/misses\|stats` |
| Objects | `GET/POST objects/:type`, `GET/PUT/DELETE objects/:type/:id`, `GET object-types` |
| Billing | `GET plans`, `GET billing/usage`, `GET billing/subscription` |
| Public API | `/v1/*` (API key auth, idempotency header) |
| Auto-replies | `GET/POST auto-replies`, `PUT/DELETE auto-replies/:id`, `POST auto-replies/preview` |
| Opt-outs | `GET/POST optouts`, `DELETE optouts/:phone` |
| Webhook | `GET/POST webhook/:tenantId` |
| Realtime | `GET events` (SSE) |
| Team | `GET/POST users`, `PATCH users/:id` |
| Platform | `GET/POST admin/tenants`, `PATCH admin/tenants/:id`, `GET admin/audit-logs` |

---

## Tech Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js >= 22.5, ES modules |
| Backend | Express 5, multer 2, qrcode, xlsx |
| WhatsApp (unofficial) | whatsapp-web.js ^1.34 + Chrome LocalAuth |
| WhatsApp (official) | Meta Cloud API Graph v23.0 |
| Storage | SQLite (`node:sqlite`) in `~/.whatsapp_sender_web` |
| Realtime | Server-Sent Events |
| Frontend | Angular 22, standalone components, signals, RxJS 7.8, SCSS |
| Tests | `node:test` (built-in, no framework) |

---

## Known Limitations

- WhatsApp Web automation is unofficial; Cloud API is the compliant production path
- SQLite only (PostgreSQL deferred; `db.forTenant` is the seam for a driver swap)
- Login throttle is in-memory (resets on restart; does not survive clustering)
- The workflow sweeper runs in-process; two app processes on one DB would double-execute jobs
- SSE uses `?token=` because `EventSource` cannot set headers
- Node < 22.5 will fail (`node:sqlite` required)
