# Architecture

Status: Phases 0, 1 and 2 implemented. Last updated 2026-10-07.

This document is the contract the rest of the roadmap builds against. If a new
feature cannot say which tenant and which channel it belongs to, it does not
get written.

---

## 1. The isolation boundary

**The tenant is the only isolation boundary.** One tenant is one business. A
tenant owns its users, its WhatsApp channels, its contacts, its messages, its
campaigns and its automations. Nothing is shared between tenants except the
process and the database connection.

Everything tenant-owned is reached through a scoped database handle:

```js
const scoped = db.forTenant(tenantId);   // server/src/db.js
```

`forTenant` returns a prototype-delegated copy of the `Database` carrying a
`tenantId`. Every query on it filters by that id and every insert stamps it.
There is no way to read another tenant's rows through a scoped handle short of
writing raw SQL, which the application layer never does.

The super admin is the one actor with no tenant of its own. It selects a tenant
to act on per request with the `X-Tenant-Id` header, and that selection is
validated against the tenants table before any handler runs.

### Why this and not row-level security

SQLite has no row-level security, and the application is a single Node process.
A scoped handle gives the same guarantee one layer up, costs nothing at
runtime, and survives a later move to PostgreSQL unchanged — at which point RLS
becomes a second belt rather than a rewrite.

---

## 2. Request lifecycle

Every authenticated request resolves in this order, and a failure at any step
ends it:

```
HTTP request
  -> bearer token            (Authorization: Bearer <token>, or ?token= for SSE)
  -> session lookup          sha256(token) in the sessions table
  -> user                    live, not disabled
  -> tenant                  the user's own, or X-Tenant-Id for a super admin
  -> tenant status           must be 'active'
  -> role check              the route's minimum role on the ladder
  -> tenant runtime          the per-tenant engine for that tenant id
  -> route handler
```

The last two steps are the important ones. `createApp` in `server/src/app.js`
does not mount the feature routes directly. It mounts a dispatcher that resolves
the tenant, then hands the request to `runtimeFor(tenantId).router`. Each tenant
gets its own runtime, created lazily on first use and cached:

```
tenant runtime                   db.forTenant(id), Channels
  |- channel runtime  (per channel, lazy)
  |    |- scoped database handle   db.forTenant(id).forChannel(channelId)
  |    |- settings                 the channel row's `settings` JSON
  |    |- transport instance       Cloud API | WhatsApp Web | sandbox
  |    |- CampaignManager
  |    |- AutoReplyEngine
  |    |- SSE client set
  |    |- media map
  |    |- WhatsApp Web session dir <dataDir>/.../channels/<id>/wwebjs_auth
  |- channel runtime
  |- ...
```

The tenant runtime is itself only a dispatcher: it owns the channel list and
hands each request to one channel's runtime, the same shape as `createApp`
handing a request to one tenant. A request names its channel with
`X-Channel-Id` (or `?channel=`); without one it gets the tenant's default
channel. Addressing another tenant's channel id is a 404, not a 403 — the id
simply does not exist inside that tenant's scope.

Route handler bodies were not rewritten for multi-tenancy. They read
`state.db` and `state.config` exactly as before; those now point at a scoped
handle and a per-tenant config file. The isolation lives in the dispatcher, not
in a thousand `WHERE tenant_id = ?` clauses sprinkled through handlers.

Tenant 1 is the legacy single-tenant installation. Its runtime uses the root
database handle and the original config path, so an existing install keeps its
data and its WhatsApp session across the upgrade.

---

## 3. Roles and permissions

Roles are a fixed ladder, not a table:

```
agent  <  admin  <  owner  <  super_admin
```

| Role | May do |
|---|---|
| `agent` | Read everything in its tenant; send messages; mark inbox read |
| `admin` | Everything an agent may, plus all tenant configuration, plus managing users below itself |
| `owner` | Everything an admin may; created only by the platform admin |
| `super_admin` | Create and suspend tenants; read the platform audit log; act as any tenant. Has no tenant of its own |

Two rules the server enforces, not the UI:

- A write by an `agent` is rejected unless the path is in `AGENT_WRITES`
  (currently `/messages` and `/inbox/mark-read`). Agents talk to customers;
  they do not change how the account behaves.
- Nobody may create or disable a user at or above their own rank. Owners come
  from the platform admin, never from inside the tenant.

**A permissions table is deliberately deferred.** It earns its place the day a
customer needs to define a custom role. Until then it is four rows of
configuration pretending to be a feature.

---

## 4. The channel

A `whatsapp_channel` is a first-class resource: one registered WhatsApp number,
owned by exactly one tenant, independently configurable.

```
whatsapp_channels
  id, tenant_id, provider, phone_number,
  provider_account_id, provider_phone_number_id,
  status, display_name, settings, capabilities,
  timezone, business_hours, is_default,
  created_at, updated_at
```

`settings` is a JSON blob holding the exact object the app has always called
"config": transport choice, provider credentials, rate limits, retry policy,
daily cap, pacing. The channel did not invent a second configuration language;
it gave the existing one an owner. `GET`/`PUT /api/config` is now a view onto
the addressed channel's `settings`, which is why every existing route and view
kept working unchanged.

**Storing a channel does not validate its settings.** A number can exist before
its credentials do — the app has always booted with an unconfigured Cloud API
transport. `PUT /config` and `POST /connection/connect` are the gates that
refuse an incomplete configuration, and they still are.

**Capabilities** say what a channel may be used for: `campaigns`,
`transactional_messages`, `workflow_messages`, `appointment_reminders`,
`order_updates`, `lead_followups`, `faq`, `auto_replies`, `ticketing`, `ai`.
All are on by default. Opt-out handling is deliberately *not* a capability: a
channel with `auto_replies` switched off still honours STOP.

**Business hours** are `{ start, end, days? }` evaluated in the channel's own
`timezone` through `Intl.DateTimeFormat`, so the same instant is inside one
number's window and outside another's.

**Phone number text is never the ownership key.** Numbers get reassigned,
reformatted and ported. `channel_id` is the key; the number is a display
attribute of the channel.

Anything attached to a number carries `channel_id` alongside `tenant_id`:
`messages.channel_id` and `inbound_messages.channel_id` are stamped by
`db.forChannel(id)`. Reads stay tenant-wide unless a caller asks for one
channel — an operator looking at history wants the whole business, not one
number — but the daily cap counts per channel, so a tenant's second number has
its own budget.

Each tenant keeps at least one channel; the last one cannot be deleted, and
exactly one is always the default.

---

## 5. How a message finds its tenant and channel

### Outbound

The caller already has both a tenant and a channel context — the dispatcher
resolved them before the handler ran — so a send goes out on that channel's
transport. Before it does, one gate enforces Rule 2 (`SEND_ROUTES` in
`app.js`): the channel must be `active`, must list the capability the route
needs, and must be inside its sending window. Otherwise the request is a 409
naming which of the three failed.

From Phase 3 onward the send becomes a message job that names both ids
explicitly:

```js
{ tenantId, channelId, conversationId, contactId, direction, messageType,
  templateId, text, media, metadata, scheduledAt, priority, idempotencyKey }
```

No message may be dispatched without both ids resolved. There is no "default
tenant" fallback in the dispatch path.

### Inbound

Inbound is the hard direction, because Meta cannot send a bearer token. The
webhook is therefore public and identifies the tenant by **URL path**:

```
POST /api/webhook/:tenantId      -> that tenant's runtime
POST /api/webhook                -> tenant 1, for the legacy install
```

The dispatcher checks the tenant exists and is `active` before the request
reaches any handler; a suspended or unknown tenant gets a bare 404, which tells
a prober nothing. From Phase 2 the path carries the channel too, and the
provider's phone number id in the payload is cross-checked against the channel
row rather than trusted.

**Known gap:** the webhook POST has no signature verification. This predates
multi-tenancy and is tracked for Phase 18 (`X-Hub-Signature-256` against the
app secret). Until then the webhook is authenticated only by URL obscurity,
which is not authentication.

For WhatsApp Web there is no webhook: the transport holds a live session per
tenant in its own profile directory, and inbound messages arrive on that
session's event emitter, already inside the right runtime.

---

## 6. Event format

Two kinds of event exist, and they should not be confused.

**Server-sent events** are the existing UI transport: live connection state,
campaign stats, QR codes, pacing. They are per-tenant — each runtime owns its
own client set — and scoped by the same dispatcher as every other route.
EventSource cannot set headers, so `/api/events` accepts `?token=` and
`?tenant=` in the query string. This is a known tradeoff: a stream URL in a
proxy log is a bearer token in a proxy log. The fix, when it matters, is a
short-lived single-use stream ticket rather than the session token.

**Business events** (Phase 6) are what triggers a workflow. Proposed shape:

```js
{
  id,              // uuid, the idempotency key for the whole causal chain
  tenantId,
  channelId,       // null for events that are not about a conversation
  type,            // 'order.created', 'message.received', 'payment.due', ...
  occurredAt,      // when the thing happened, not when we heard about it
  subject: { kind, id },   // 'contact' | 'order' | 'appointment' | ...
  data,            // type-specific payload
  source,          // 'api' | 'webhook' | 'internal' | 'scheduler'
}
```

A trigger matches on `type` plus optional conditions over `data`. The engine
never inspects `source` to decide behaviour — an order created by the API and
one created by a Shopify webhook must run the same workflow.

---

## 7. Workflow format (Phase 6)

```js
{
  id, tenantId, channelId,     // channelId may be null: resolve at run time
  name, status, version,       // versions are immutable once a run references them
  trigger: { type, conditions: [] },
  steps: [ { id, action, params, next, onError } ],
}
```

A run is a row, not a closure:

```
workflow_runs
  run_id, tenant_id, workflow_id, workflow_version, contact_id, channel_id,
  status, current_step, context, started_at, finished_at, error
```

Keeping the run in the database rather than in memory is what makes "wait 24
hours" survive a restart, which is the entire point of Phase 7.

---

## 8. Platform configuration versus tenant configuration

The distinction decides where a setting lives, and who may change it.

**Platform configuration** is set by the operator, lives in environment
variables or a platform table, and is invisible to tenants:

- Database location, listen port, data directory
- `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` (first-run bootstrap only)
- Session TTL, login throttle thresholds
- Hard sending ceilings that no tenant may exceed
- Feature flags gating unreleased work
- Provider credentials belonging to the platform rather than to a tenant

**Tenant configuration** is set by a tenant's own admins, lives in that tenant's
`config.json` (later: `tenant_settings` and `whatsapp_channels` rows), and is
scoped to them:

- Transport choice and its credentials
- Rate limits, retry policy, daily caps, pacing windows
- Template defaults, default country code
- Auto-reply rules, business hours, timezone

The rule: **a tenant setting may only ever be more restrictive than the
platform setting of the same name.** A tenant can lower its daily cap. It
cannot raise it past the platform ceiling. Enforcement belongs in the config
layer, not in each caller.

---

## 9. Providers

**Meta Cloud API is the production default.** It is the only transport with a
supported contract, delivery receipts, and an account that survives scrutiny.

**`whatsapp-web.js` is an internal and optional transport, and it carries
real risk.** It drives a logged-in WhatsApp Web session through a headless
browser. That is not a supported integration: the account can be banned, the
session can be invalidated without warning, and a library update can break it
overnight. It is kept because it needs no business verification and is useful
for development and for low-volume internal use. It must be labelled as such
wherever a tenant can select it, and it must never be the default for a new
tenant.

**`sandbox` is the test transport.** It records what would have been sent and
reports `SANDBOX` status. Every test suite uses it.

Compliance obligations that belong to the platform, not to individual workflow
authors:

- **Consent.** No message to a contact without a recorded opt-in basis.
- **Opt-out.** STOP handling is enforced centrally in the dispatch path, before
  any workflow or campaign decides to send. A workflow author cannot opt out of
  opt-out.
- **Templates.** Outside the 24-hour customer service window, Cloud API accepts
  only pre-approved templates. Template approval state is provider state and
  must be stored and checked, not assumed.
- **Prohibited use.** Bulk unsolicited messaging gets numbers banned regardless
  of what the law says locally. The pacing and daily-cap system is a product
  requirement, not a nicety.
- **Audit.** Every administrative action is logged with tenant, user, action and
  target. Already implemented; see `audit_logs`.

---

## 10. What does not change during migration

These keep working exactly as they do today. They were scoped, not rewritten:

- `protocol.js` — phone normalisation, status enum, personalisation
- `contacts.js` — CSV and Excel import
- `campaign/` — manager, queue, limits, adaptive safety and pacing
- `autoreply/` — keyword engine and opt-out handling
- `paymentReminders.js`
- `transports/` — the transport abstraction and all four implementations
- The Angular views for connection, campaign, auto-replies, reminders, history

The old single-tenant database is migrated in place: existing rows are assigned
to tenant 1, which keeps the original config path and WhatsApp session
directory. An existing install upgrades without an export or a re-pairing.

---

## 11. Definition of done for Phase 0 and Phase 1

Phase 0:

- [x] `tenant` defined as the primary isolation boundary (§1)
- [x] `whatsapp_channel` defined as a first-class resource (§4)
- [x] Roles and permissions defined (§3)
- [x] Common event format defined (§6)
- [x] Common workflow format defined (§7)
- [x] Common message job format defined (§5)
- [x] Platform versus tenant configuration defined (§8)
- [x] Features that remain unchanged listed (§10)
- [x] Provider limits, consent, opt-out and template rules documented (§9)
- [x] Production default provider decided: Meta Cloud API (§9)
- [x] `whatsapp-web.js` kept as optional, with explicit risk labelling (§9)
- [x] This document explains how a message identifies its tenant and channel (§5)

Phase 1:

- [x] Tenants, users, sessions and audit log tables
- [x] Password auth (scrypt), bearer sessions, login throttling
- [x] Role ladder and authorisation middleware
- [x] Tenant middleware, with `X-Tenant-Id` for super admins
- [x] `tenant_id` on every tenant-owned table
- [x] Legacy data migrated to tenant 1
- [x] Audit logging on administrative operations
- [x] Tenant-scoped SSE channels
- [x] Cross-tenant access tests (`server/test/tenancy.test.js`)
- [x] Suspension kills live sessions immediately and darkens the webhook
- [ ] PostgreSQL — **deferred.** SQLite remains the store for now. The scoped
      handle in §1 is the seam that makes this a driver swap rather than a
      rewrite.

Phase 2:

- [x] `whatsapp_channels` table and CRUD API
- [x] One tenant owning several numbers, each with its own transport, config,
      connection, campaign manager and auto-reply engine
- [x] Per-channel daily limits, pacing, timezone and sending window
- [x] Per-channel capability flags, enforced on every send route
- [x] Default channel selection, and routing by id or capability
- [x] Channel health and status surfaced without opening the channel
- [x] Channel administration in the audit log
- [x] Credentials redacted on read (`accessToken`, `webhookVerifyToken`)
- [x] Cross-tenant channel access tests (`server/test/channels.test.js`)
- [ ] At-rest encryption for channel credentials — Phase 18. They are
      plaintext JSON in `settings` today.
- [ ] Per-channel webhook paths (`/api/webhook/:tenantId/:channelId`) and
      cross-checking the provider's phone number id against the channel row.
      Inbound still resolves to the tenant's default channel.
