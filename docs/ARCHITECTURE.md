# Architecture

Status: Phases 0-11 implemented. Last updated 2026-10-08.

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

Since Phase 3 the send *is* a message job naming both ids:

```js
{ tenantId, channelId, conversationId, contactId, direction, messageType,
  templateId, text, media, metadata, scheduledAt, priority, idempotencyKey }
```

No message may be dispatched without both ids resolved. There is no "default
tenant" fallback in the dispatch path; `messageJob()` rejects a job missing
either id rather than guessing.

Every producer hands its job to the **message service**
(`src/messaging/service.js`), which is the only way out. It owns the checks a
caller must not be able to route around — channel active, channel enabled for
that kind of traffic, recipient not opted out, idempotency key not already
used — and then enqueues on the channel's campaign manager, which owns the
queue, pacing, rate limit, retries and daily cap.

That manager was already the pipeline for campaigns. Phase 3 did not build a
second one: auto-replies, transactional sends and reminders now use this one,
so a reply is paced, retried and counted against the cap exactly like a
campaign row. The queue is priority-ordered — a reply or a receipt goes ahead
of a campaign backlog, while equal priorities keep FIFO order.

`messageType` is one of `campaign`, `transactional`, `auto_reply`, `reminder`,
`workflow`, and it decides both the priority and which channel capability the
job needs.

**Idempotency.** A caller that supplies a key gets the original message id back
on a retry rather than a second message. A caller that does not gets a
content-derived key, which is what makes a redelivered webhook produce one
reply instead of one per delivery. The guarantee is a partial unique index on
`messages(tenant_id, idempotency_key)`.

**Normalized errors.** `src/messaging/errors.js` maps a Cloud API numeric code,
a dropped WhatsApp Web session and a socket timeout onto one small set —
`DISCONNECTED`, `RATE_LIMITED`, `AUTH`, `INVALID_RECIPIENT`,
`TEMPLATE_REQUIRED`, `PROVIDER_UNAVAILABLE`, `CANCELLED`, `UNKNOWN` — each
carrying whether it is worth retrying. Upstream code never branches on which
transport threw.

`GET /api/queue` reports depth, in-flight count, a breakdown by message type,
accepted/duplicate/suppressed counts and the delivery-status histogram.

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

## 5a. Contacts

One row per number per tenant. `UNIQUE (tenant_id, phone)` is the duplicate
detection: importing the same sheet twice updates rather than duplicating, and
the same number can exist in two tenants' books independently.

```
contacts
  id, tenant_id, phone, name, email, status, opt_in_status,
  custom_fields, tags, source, created_at, updated_at
```

**What a business actually tracks lives in JSON, not in columns.** A clinic
stores `patient_id` and `doctor`; a school stores `class` and `parent_name`; a
shop stores `last_order_id`. `custom_fields` is a flat string map and `tags` is
an array, both filterable through SQLite's JSON1 functions, so a new industry
needs no migration.

**A segment is a stored filter, not a stored list.** `segments.filter` holds the
same object `ContactStore.find` takes, so a segment is re-evaluated every time
it is used and cannot go stale. A campaign started with `segmentId` resolves its
audience at send time and drops anyone who is not messageable.

Supported filter keys: `tags` (all of), `anyTags` (any of), `notTags`, `status`,
`optInStatus`, `optedOut`, `source`, `search`, `custom` (`{key: value}`),
`createdAfter`, `createdBefore`.

**Opt-out is deliberately not a column here.** `opt_outs` stays the one
authority the send path consults; `opt_in_status` records the consent basis we
hold. They are different facts, so there is nothing to keep in sync — a read
joins `opt_outs` and reports `optedOut` and `messageable` alongside.

**A timeline is derived, not stored.** `GET /api/contacts/:id/timeline` merges
`messages` and `inbound_messages` for that number. A third table could disagree
with the two that already hold the truth.

**Phone normalization is a trust boundary with a sharp edge.**
`normalizePhone(raw, countryCode)` takes what a human typed, so it is *not*
idempotent: a bare `919876543210` under country code `91` becomes
`91919876543210`, because the function cannot tell an E.164 number from a
national one that happens to start with the country code. Callers that have
already normalized — the sheet importer — say so explicitly rather than leaving
the store to guess from the digits.

---

## 5b. Templates

`TemplateStore` (`src/templates/`), tenant-scoped like every other store. A
template declares its variables; `personalize()` from `protocol.js` still does
the substituting, because a second templating language would be a second set of
bugs.

**History is append-only.** Editing the body or the declared variables writes a
new immutable `template_versions` row and bumps `current_version`. A rename, a
channel pin or an approval flip does not. `revert(id, v)` writes the old body
*forward* as a new version rather than deleting history. There is no `UPDATE`
anywhere against `template_versions`, and `UNIQUE (template_id, version)` makes
that enforceable rather than a convention.

`template_versions` carries no `tenant_id`: it is only reachable through a
template already resolved under the tenant, so cross-tenant reads 404. One owner
per fact beats two columns that can disagree.

**`validate()` is advice, not a gate.** The store saves half-written drafts on
purpose; the HTTP route is where a non-empty problem list becomes a 400, and
`?draft=true` opts out. Keeping the gate in the route means a workflow or an
import can stage something incomplete without fighting the store.

`compatibility(template, channel)` is a pure function: a `provider_template` is
Cloud-API-only and must be `approved`; `whatsapp_web` cannot send one at all;
`interactive` is Cloud-API-only. A template pinned to a `channel_id` refuses
every other channel.

**Known sharp edge, inherited:** `personalize` also runs spintax, so `{a|b}` is
a variable fallback when the context has `a` and a random pick otherwise.

---

## 5c. Workflows

`src/workflows/` is the engine from §7's format. The store owns definitions and
runs; the engine executes them. Both are tenant-scoped.

**A run pins the version it started on.** Editing a workflow never changes a run
already in flight — the single most important constraint here, and the reason
`workflow_versions` exists.

**The run row is the state. There is no closure and no timer.** `advance()`
executes steps until it hits a `wait`, a terminal state or an error, then writes
`status = 'waiting'` and `resume_at` and returns. That is what makes "wait 24
hours" survive a restart, which is the whole point of Phase 7.

Something has to come back for a parked run. `createApp({ scheduler: true })`
starts one in-process sweeper that calls `dueRuns(db, now)` across every tenant
and resumes each through its own tenant's engine. It is off by default so a test
never starts a timer it did not ask for; `index.js` turns it on.

> ponytail: one in-process sweeper, so `resume` needs no lease. Two app
> processes against one database would double-execute a run; the upgrade is a
> claim (`UPDATE ... WHERE status = 'waiting'`) inside `resume`.

**Dependency injection, not imports.** The engine takes
`{ store, messages, contacts, channels, renderTemplate, now, fetch }`. That is
what lets it be tested without standing up the app, and what keeps templates and
workflows from importing each other.

Steps are `{ id, action, params, next, onError }`. Conditions are a declarative
`{ field, op, value }` — no expression evaluator, no `eval`. The validator
rejects at save time what would otherwise fail at 3am: an unknown action, a jump
to a step that does not exist, a missing required param, and any cycle that does
not pass through a `wait`.

Implemented actions: `send_message`, `send_template`, `wait`, `condition`,
`branch`, `update_contact`, `set_field`, `add_tag`, `remove_tag`,
`stop_workflow`, `start_workflow`, `call_webhook`. Anything else is *rejected by
the validator*, not silently skipped — a workflow that claims to create a ticket
must not save until Phase 9 exists.

**Every step is logged** to `workflow_run_steps`, which is both a Phase 6
definition-of-done item and the only way Phase 18's tracing will work.

Sends go through `MessageService` like everything else, with
`messageType: 'workflow'` and `idempotencyKey: wf.<runId>.<stepId>`, so a
retried step gets the original message id back instead of sending twice. A run
is keyed on `(workflow, contact, event id)`, so the same event cannot start two
runs.

---

## 5d. The scheduler

`src/scheduler/` is a **generic** durable job runner. It does not know what a
workflow is: jobs carry an opaque `kind` and a JSON `payload`, and a handler is
registered per kind. That separation is the phase, not an accident of layering —
payment reminders become a second handler without touching it.

**The atomic claim is the correctness core.** Two workers must never get one
job, so claiming is a single `UPDATE ... WHERE id IN (SELECT ... WHERE status =
'pending' ...) RETURNING *`, never a `SELECT` followed by an `UPDATE`. The
loser's subquery no longer sees the row as pending, so overlap is structurally
impossible rather than merely unlikely.

**A lease is a timestamp, not a lock object.** A worker that dies holds nothing;
`reclaimExpiredLeases` flips expired leases back to `pending` once the lease
runs out, or straight to `dead` when the crash burned the last attempt, so a
repeatedly-crashing job cannot loop forever. A graceful release refunds the
attempt, because that job never ran.

Backoff reuses `RetryPolicy` from `campaign/limits.js`. Its `shouldRetry()` is
deliberately *not* used: that checks one global `maxRetries`, while the ceiling
here is per job (`scheduled_jobs.max_attempts`).

**A timed-out handler is failed and retried, but the abandoned promise keeps
running** — the scheduler cannot kill it. Handlers that must not double-execute
need their own idempotency.

---

## 5e. Conversations and human handoff

`src/inbox/` turns a stream of inbound messages into conversation state: one row
per `(tenant, channel, phone)`, created in `handleInbound` because that is where
every transport's inbound converges.

**`bot_paused` is the point of the phase.** While a human has the conversation,
automatic traffic is silenced. That guard lives in **one place** —
`MessageService.send` refuses `auto_reply`, `workflow`, `campaign` and
`reminder` when the conversation is paused, and lets `transactional` through,
because a human replying from the inbox *is* the takeover. Guarding there rather
than in the auto-reply engine and again in the workflow engine means a new
automatic path cannot forget to check. `handleInbound` also returns early, which
skips the typing delay and the FAQ lookup.

`unread_count` is a counter, not a computed value: `inbound_messages.is_read`
remains the per-message authority, and `markRead` zeroes the counter *and* marks
the messages in the same call, so the two cannot drift. The thread itself is
derived from `messages` + `inbound_messages`, keyed by phone and channel rather
than by contact, because a conversation can exist before a contact row does.

`channel_id` is `NOT NULL DEFAULT 0` rather than nullable: SQLite treats NULLs
as distinct in a UNIQUE index, so a nullable column would quietly defeat
`UNIQUE (tenant_id, channel_id, phone)`.

---

## 5f. Tickets

`src/tickets/`. `ticket_events` is append-only and `update()` is the only writer,
so **every field change leaves a row** with its from/to value. That is the audit
trail, not a nicety — and a no-op patch writes nothing and does not bump
`updated_at`.

SLA is one exported constant keyed by priority (`urgent` 2h … `low` 72h),
recomputed from `created_at` whenever priority changes rather than frozen at
creation.

**Notifying a customer is opt-in and close-out-only.** `notify: true` on a PATCH
sends, but only when the resulting status is `RESOLVED` or `CLOSED`. An agent
with a stale `notify: true` in their client payload cannot spam a customer by
editing a subject line. The send goes through `MessageService` with
`idempotencyKey: ticket:<id>:<STATUS>`, so a double PATCH is one message. The
store itself never sends anything.

A workflow can file one: `create_ticket`, `update_ticket` and `assign_agent` are
now real actions. The engine forces `source: 'workflow'` rather than letting a
definition claim it came from a person.

---

## 5g. The knowledge base

`src/knowledge/` supersedes the keyword engine without replacing it.
`matchFaq(text, items, opts)` is pure — no database — and tries, in order:
business-hours override → `exact` → `contains` → `regex` → `similarity` → an AI
seam → `fallback`.

Two deliberate improvements over `AutoReplyEngine.matchRule`: levels are tried
in order, so an EXACT item beats a CONTAINS item listed before it (list order
used to decide that); and within a level, higher `priority` wins instead of
whatever SQL returned first.

**Similarity is Sørensen-Dice over token sets, threshold 0.6, no dependency.**
Below threshold returns `null`, which means *escalate*, not "answer anyway":
a logged miss gets picked up by a human, a confidently wrong answer gets
believed. `faq_misses` — the questions nothing matched — is the most valuable
table here, because it tells an operator what to write next.

Wiring is fall-through: the FAQ answers first and the keyword engine is the
fallback, so with no FAQ items behaviour is byte-identical and an operator
migrates at their own pace.

**Phase 17 (AI) is cancelled, so the matcher is complete without it.** The
`aiFallback` option is a documented seam consulted only after `similarity`
misses; nothing in the repo supplies one.

---

## 5h. Business objects

`src/objects/`. Phase 11 lists eight object types, and eight tables of
near-identical CRUD would contradict the roadmap's own Rule 9. So: **one
`business_objects` table with a `type` discriminator and a JSON `data` column,
plus a declarative registry** in `types.js` giving each type its fields,
statuses and the events it emits. Adding "Invoice" is one registry entry. There
is no `if (type === ...)` outside the registry.

`occurs_at` is the one field promoted out of JSON to a column, because `due()`
range-queries it and `json_extract` ranges cannot use an index. That column is
what "24 hours before the appointment" and "payment overdue" read.

**Emission is awaited, not fire-and-forget.** Order: write the object, write the
log row, then `await emit(event)`. If dispatch fails the write is already
durable, an `emit_failed` row joins the trail, and the route answers `502` with
the object attached — because "the order saved but its confirmation workflow
never started" is otherwise an undiagnosable support ticket.

The store takes `emit` injected and never imports the workflow engine; the app
wires it to `engine.dispatch`.

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

Phase 3:

- [x] Provider-neutral message job, with tenant and channel required
- [x] One message service every producer goes through
- [x] Campaigns, auto-replies and transactional sends on the same queue
- [x] Priority ordering, so a reply does not wait behind a campaign
- [x] Idempotency keys, enforced by a unique index
- [x] Normalized delivery states and provider errors
- [x] Queue observability (`GET /api/queue`)
- [ ] Payment reminders still enqueue through the manager directly rather than
      through the service. They inherit pacing and the cap, but not the
      capability and idempotency checks.
- [ ] `scheduledAt` is carried on the job but nothing reads it yet. Phase 7.

Phase 4:

- [x] Contact CRUD, bulk import, tags and custom fields
- [x] Saved segments as stored filters, usable as campaign audiences
- [x] Opt-in state recorded, opt-out derived from the send path's authority
- [x] Contact timeline derived from the message tables
- [x] Duplicate detection per tenant, by database constraint
- [x] Cross-tenant contact and segment tests
- [x] Segment filters readable by the workflow engine (Phase 6 landed)

Phase 5:

- [x] Template CRUD, immutable versioning, revert
- [x] Preview rendering and variable validation
- [x] Tenant-level templates, channel pinning
- [x] Provider compatibility checks and approval state
- [x] Usage statistics (`use_count`, `last_used_at`)

Phase 6:

- [x] Workflow definition store with immutable versions; a run pins its version
- [x] Validator rejecting unknown actions, bad jumps and waitless cycles
- [x] Trigger matching with declarative conditions
- [x] Runtime: 12 action types, every step logged, tenant-isolated, idempotent
- [x] Durable waits: the run row is the state, no timer
- [ ] Actions deferred to their own phases, rejected by the validator until
      then: `create_ticket`/`update_ticket`/`assign_agent` (Phase 9),
      `add_to_campaign`/`remove_from_campaign` (Phase 13), `notify_team`,
      `send_media`.
- [ ] No workflow builder UI. Form-based editor is Phase 19.
- [x] `create_ticket` / `update_ticket` / `assign_agent` now implemented
      (Phase 9 landed)

Phases 8-11:

- [x] Conversations, assignment, internal notes, human takeover and handback
- [x] Tickets with an append-only event trail, SLA, CSAT and opt-in notification
- [x] FAQ with deterministic matching, versioned answers and a miss log
- [x] Business objects as one table plus a registry, emitting workflow events
- [ ] Trigger a workflow *on* a ticket state change. The hook point is the end
      of `TicketStore.update`; the inverse direction (a workflow filing a
      ticket) is done.
- [ ] `sweepDue` for `payment.due` / `subscription.expiring` / appointment
      reminders is implemented and idempotent, but no scheduler job calls it
      yet. One handler registration away.
- [ ] Knowledge-base per-category permissions. The role middleware already
      gates the whole runtime router; a second permission model with one
      tenant-wide scope would be an abstraction with one implementation.

Phase 7:

- [x] Persistent scheduled jobs, generic over `kind`
- [x] Atomic claim proven against concurrent owners
- [x] Lease expiry and crash recovery
- [x] Retry with backoff, max attempts, dead-letter and `retryDead`
- [x] Cancel, pause/resume by kind, graceful shutdown, per-job timeout
- [x] Execution metrics (`stats()`)
- [ ] The workflow sweeper currently polls `dueRuns` directly rather than
      enqueuing scheduler jobs. Both are durable; unifying them is worth doing
      when a second job kind arrives.
