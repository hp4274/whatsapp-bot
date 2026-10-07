# WhatsApp Automation Platform — Implementation Phases

Last updated: 2026-10-07. Phases 0 to 4 are complete; see `docs/ARCHITECTURE.md`
for the frozen product model.

## Purpose

This roadmap converts the current **WhatsApp Sender** into a multi-tenant SaaS product where one platform can manage many businesses, each with its own users, WhatsApp numbers, contacts, automations, templates, inbox, tickets, and business data.

The central architecture principle is:

> **One automation engine, many independent tenant configurations.**

The same engine executes different workflows for different businesses and different WhatsApp channels without mixing their data or behavior.

---

# Product Model

```text
SUPER ADMIN
    |
    +-- Tenants / Businesses
    |      |
    |      +-- Users / Roles
    |      +-- WhatsApp Channels
    |      +-- Contacts
    |      +-- Conversations / Inbox
    |      +-- Templates
    |      +-- Workflows
    |      +-- Workflow Runs
    |      +-- Tickets
    |      +-- Business Objects
    |      +-- Campaigns
    |      +-- Analytics
    |      +-- Settings
    |
    +-- Plans / Limits
    +-- Feature Flags
    +-- Platform Policies
    +-- Audit Logs
    +-- System Health
```

Core execution path:

```text
EVENT
  -> TRIGGER MATCH
  -> WORKFLOW
  -> CONDITIONS
  -> ACTIONS
  -> MESSAGE JOB
  -> QUEUE
  -> WHATSAPP CHANNEL
  -> DELIVERY STATUS
  -> NEXT WORKFLOW STEP
```

---

# Phase 0 — Architecture Freeze & Safety Boundary — DONE

## Goal

Freeze the product model before adding more business-specific features.

Delivered as `docs/ARCHITECTURE.md`.

## Tasks

- [x] Define `tenant` as the primary isolation boundary.
- [x] Define `whatsapp_channel` as a first-class resource.
- [x] Define roles and permissions.
- [x] Define a common event format.
- [x] Define a common workflow format.
- [x] Define a common message job format.
- [x] Define the difference between platform configuration and tenant configuration.
- [x] Define which existing features remain unchanged during migration.
- [x] Document WhatsApp provider limitations, consent/opt-out requirements, template requirements, and prohibited/restricted use cases before exposing production controls.
- [x] Decide which provider is the production default. Recommended: Meta Cloud API.
- [x] Keep `whatsapp-web.js` as an optional/internal transport with explicit risk labeling.

## Definition of Done

- [x] No new feature is implemented directly against a hard-coded global WhatsApp account.
- [x] Every new feature specifies its tenant ownership and channel ownership.
- [x] Architecture document explains how a message identifies its tenant and channel.

---

# Phase 1 — Multi-Tenant SaaS Foundation — DONE

## Goal

Convert the current single-user/local application into a true multi-business application.

## New Core Entities

```text
tenants
users
roles
permissions
user_roles
whatsapp_channels
tenant_settings
feature_flags
plans
subscriptions
usage_counters
audit_logs
```

## Recommended Core Relationships

```text
Tenant
  |
  +-- Users
  +-- WhatsApp Channels
  +-- Contacts
  +-- Workflows
  +-- Templates
  +-- Conversations
  +-- Tickets
  +-- Campaigns
  +-- Business Objects
```

## Database Rules

Every tenant-owned table must have `tenant_id`.

Examples:

```text
contacts.tenant_id
messages.tenant_id
conversations.tenant_id
campaigns.tenant_id
workflows.tenant_id
auto_replies.tenant_id
tickets.tenant_id
```

For resources attached to a WhatsApp number, also store:

```text
channel_id
```

Do not rely on phone number text as the ownership key.

## Tasks

- [ ] Move long-term SaaS storage target from SQLite to PostgreSQL. **Deferred: still SQLite. `db.forTenant` is the seam that makes this a driver swap.**
- [x] Create tenant table.
- [x] Create user/auth system.
- [x] Create roles and permissions. *(Role ladder as a code constant; a permissions table is deferred until a customer needs a custom role.)*
- [x] Add tenant middleware.
- [x] Add authorization middleware.
- [x] Add `tenant_id` to every tenant-owned record.
- [x] Add migration strategy for existing local data.
- [x] Add audit logging for administrative operations.
- [x] Add tenant-aware API validation.
- [x] Add tenant-aware SSE channels.
- [x] Prevent cross-tenant resource access by ID guessing.
- [x] Add automated tests that attempt cross-tenant access.

## Definition of Done

- [x] Customer A cannot see Customer B's contacts.
- [x] Customer A cannot read Customer B's messages.
- [x] Customer A cannot trigger Customer B's workflow.
- [x] Customer A cannot send through Customer B's WhatsApp channel.
- [x] Super Admin can access all tenants according to platform permissions.

---

# Phase 2 — WhatsApp Channel Management — DONE

## Goal

Make every registered WhatsApp number an independently configurable channel.

## Entity

```text
whatsapp_channels
------------------
id
tenant_id
provider
phone_number
provider_account_id
provider_phone_number_id
status
display_name
settings
timezone
business_hours
created_at
updated_at
```

## Channel Capabilities

```text
campaigns
transactional_messages
workflow_messages
appointment_reminders
order_updates
lead_followups
faq
auto_replies
ticketing
ai
```

Capabilities can be enabled/disabled per channel.

## Tasks

- [x] Create channel CRUD API.
- [x] Connect/disconnect individual channels.
- [x] Store provider-specific credentials securely. *(Credentials live in the channel's `settings` JSON and are redacted on read; at-rest encryption is Phase 18.)*
- [x] Support one tenant owning multiple channels.
- [x] Add channel health/status.
- [x] Add channel-specific daily limits.
- [x] Add channel-specific sending windows.
- [x] Add channel-specific timezone.
- [x] Add channel feature flags.
- [x] Add default channel selection for workflows.
- [x] Add channel routing rules.
- [x] Add channel audit log.

## Super Admin Controls

```text
Channel
  |- Enable / Disable
  |- Disconnect
  |- Logout
  |- Change limits
  |- Enable features
  |- Disable features
  |- View health
  |- View usage
  |- View errors
```

## Definition of Done

- [x] One tenant can have multiple numbers.
- [x] Each number behaves independently.
- [x] A workflow can explicitly select its channel.
- [x] No message can be sent without a resolved tenant + channel context.

---

# Phase 3 — Unified Messaging Core — DONE

## Goal

Separate business events and automation from the actual WhatsApp transport.

## New Services / Modules

```text
messaging/
  message-service.js
  message-job.js
  renderer.js
  dispatcher.js
  delivery-status.js
  provider-router.js
```

## Standard Message Job

```js
{
  tenantId,
  channelId,
  conversationId,
  contactId,
  direction,
  messageType,
  templateId,
  text,
  media,
  metadata,
  scheduledAt,
  priority,
}
```

## Tasks

- [x] Create provider-neutral message job.
- [x] Keep current transport abstraction.
- [x] Route messages through a single messaging service.
- [x] Move campaign sends onto the common message job pipeline.
- [x] Move auto-replies onto the common message pipeline.
- [ ] Move payment reminders onto the common message pipeline. **Partial: they
      enqueue through the manager, so they get pacing and the daily cap, but
      not the service's capability and idempotency checks.**
- [x] Normalize delivery states.
- [x] Normalize provider errors.
- [x] Add idempotency key.
- [x] Add tenant/channel ownership to jobs.
- [x] Add queue observability.

## Definition of Done

Campaign, auto-reply, reminder, and workflow messages all use the same underlying dispatch pipeline.

---

# Phase 4 — Contacts, Tags & Custom Fields — DONE

## Goal

Create a flexible contact system capable of supporting different industries.

## Core Contact Model

```text
contacts
--------
id
tenant_id
phone
name
email
status
opt_in_status
custom_fields
tags
source
created_at
updated_at
```

## Example Custom Fields

### Clinic

```text
patient_id
doctor
department
appointment_date
```

### School

```text
student_id
class
division
roll_number
parent_name
```

### E-commerce

```text
customer_id
last_order_id
order_total
preferred_category
```

## Tasks

- [x] Add contact CRUD.
- [x] Add bulk import.
- [x] Add tags.
- [x] Add custom fields.
- [x] Add saved segments. *(Stored filters, re-evaluated on use.)*
- [x] Add opt-in state.
- [x] Add opt-out state. *(`opt_outs` stays the authority; joined on read.)*
- [x] Add contact timeline.
- [x] Add duplicate detection per tenant. *(`UNIQUE (tenant_id, phone)`.)*
- [x] Add segment filters usable by workflows. *(The filter object is the seam;
      the workflow engine itself arrives in Phase 6.)*

---

# Phase 5 — Templates & Message Variables

## Goal

Create a reusable template system for transactional and automated messages.

## Template Types

```text
text
media
provider_template
interactive
notification
```

## Variables

```text
{name}
{phone}
{order_id}
{appointment_date}
{remaining}
{due_date}
{ticket_id}
{tracking_id}
{custom_field}
```

## Tasks

- [ ] Create template CRUD.
- [ ] Add template versioning.
- [ ] Add preview rendering.
- [ ] Add variable validation.
- [ ] Add tenant-level templates.
- [ ] Add channel/provider compatibility checks.
- [ ] Add template usage statistics.
- [ ] Add template approval/status state where provider rules require it.

---

# Phase 6 — Workflow Engine Foundation

## Goal

Build the core automation engine.

This is the most important phase of the product.

## Workflow Structure

```text
Workflow
  |
  +-- Trigger
  +-- Conditions
  +-- Steps
  +-- Variables
  +-- Channel
  +-- Status
  +-- Version
```

## Trigger Types

### Event

```text
contact.created
lead.created
lead.updated
appointment.created
appointment.updated
order.created
order.status_changed
payment.due
subscription.expiring
event.created
ticket.created
ticket.status_changed
```

### Message

```text
message.received
keyword.detected
button.clicked
list.selected
```

### Time

```text
time.before
 time.after
specific_datetime
recurring_schedule
```

### External

```text
webhook.received
api.event
integration.event
```

## Action Types

```text
send_message
send_template
send_media
wait
condition
branch
update_contact
set_field
add_tag
remove_tag
create_ticket
update_ticket
assign_agent
notify_team
call_webhook
start_workflow
stop_workflow
add_to_campaign
remove_from_campaign
```

## Workflow Runtime

Create:

```text
workflow_runs
workflow_run_steps
workflow_schedules
workflow_events
```

Each run should contain:

```text
run_id
tenant_id
workflow_id
contact_id
channel_id
status
current_step
started_at
finished_at
error
context
```

## Definition of Done

- [ ] A workflow can be created without coding.
- [ ] A workflow can be triggered by an event.
- [ ] A workflow can wait.
- [ ] A workflow can branch.
- [ ] A workflow can send a message.
- [ ] A workflow can update data.
- [ ] A workflow can fail and retry safely.
- [ ] Workflow execution is tenant-isolated.
- [ ] Workflow execution is idempotent.
- [ ] Every step is logged.

---

# Phase 7 — Workflow Scheduler & Reliability

## Goal

Make delayed workflows reliable enough for reminders and follow-ups.

## Required Components

```text
scheduler
queue
worker
retry-policy
dead-letter handling
idempotency
lock/lease
```

## Use Cases

```text
24 hours before appointment
2 hours before appointment
1 day after lead creation
3 days after quote
7 days before subscription expiry
1 day after payment becomes overdue
```

## Tasks

- [ ] Build persistent scheduled jobs.
- [ ] Recover scheduled jobs after restart.
- [ ] Add job locking.
- [ ] Add retry policy.
- [ ] Add maximum attempts.
- [ ] Add dead-letter state.
- [ ] Add cancellation.
- [ ] Add pause/resume.
- [ ] Add workflow timeout.
- [ ] Add execution metrics.

---

# Phase 8 — Unified Inbox & Human Handoff

## Goal

Move from a bot-only product to a customer communication platform.

## Features

```text
Conversations
Messages
Unread state
Assignments
Teams
Internal notes
Tags
Customer profile
Workflow state
Ticket state
```

## Conversation Flow

```text
Customer message
      |
      +--> Opt-out
      |
      +--> Active workflow
      |
      +--> FAQ
      |
      +--> Auto-reply
      |
      +--> AI fallback
      |
      +--> Human agent
```

## Tasks

- [ ] Build Angular inbox.
- [ ] Conversation list.
- [ ] Message thread.
- [ ] Search.
- [ ] Filters.
- [ ] Assignment.
- [ ] Internal notes.
- [ ] Human takeover.
- [ ] Return-to-bot control.
- [ ] Realtime updates through SSE/WebSocket as appropriate.

---

# Phase 9 — Ticket / Complaint Engine

## Goal

Create a generic ticket system reusable by any business.

## Ticket Model

```text
tickets
-------
id
tenant_id
contact_id
conversation_id
category
priority
status
assigned_to
source
metadata
created_at
updated_at
```

## Statuses

```text
OPEN
IN_PROGRESS
WAITING_CUSTOMER
RESOLVED
CLOSED
```

## Tasks

- [ ] Create tickets manually.
- [ ] Create tickets from workflow.
- [ ] Create tickets from message intent/keyword.
- [ ] Assign agents.
- [ ] Add SLA fields.
- [ ] Add ticket history.
- [ ] Trigger workflows on ticket state changes.
- [ ] Notify customer on major status changes.
- [ ] Collect satisfaction feedback after resolution.

---

# Phase 10 — Knowledge Base & FAQ Engine

## Goal

Replace simple keyword replies with a reusable FAQ layer.

## Knowledge Model

```text
knowledge_bases
knowledge_articles
faq_items
faq_categories
```

## Initial Matching Levels

```text
1. EXACT keyword
2. CONTAINS
3. REGEX
4. FAQ similarity / intent matching
5. AI fallback
6. HUMAN HANDOFF
```

Do not make AI mandatory for basic FAQ operation.

## Tasks

- [ ] FAQ CRUD.
- [ ] Categories.
- [ ] Multiple answers/versions.
- [ ] Business-hours fallback.
- [ ] Human escalation.
- [ ] FAQ analytics.
- [ ] Optional AI fallback.
- [ ] Knowledge base permissions.

---

# Phase 11 — Business Object Layer

## Goal

Give workflows structured business data to work with.

## Standard Objects

```text
Lead
Appointment
Order
Payment
Subscription
Event
Student
Ticket
```

## Example

```text
Appointment
-----------
id
tenant_id
contact_id
service
date_time
status
staff_id
metadata
```

```text
Order
-----
id
tenant_id
contact_id
order_number
status
amount
tracking_id
metadata
```

## Tasks

- [ ] Create generic object/event interfaces.
- [ ] Create API endpoints.
- [ ] Allow workflows to read object fields.
- [ ] Allow workflows to update object state.
- [ ] Create webhook event emission when objects change.

---

# Phase 12 — Ready-Made Automation Modules

## Goal

Turn the generic workflow engine into easy-to-use business products.

These should be **workflow templates + business objects + UI**, not separate automation engines.

## Appointment Module

```text
Appointment created
 -> reminder
 -> confirm / reschedule / cancel
 -> update appointment
 -> follow-up feedback
```

## Order Module

```text
Order created
 -> order confirmation
 -> shipped
 -> tracking update
 -> delivered
 -> feedback
```

## Lead Module

```text
Lead created
 -> welcome message
 -> delayed follow-up
 -> another follow-up
 -> stop on reply
 -> assign salesperson
```

## Payment Module

```text
Payment due
 -> reminder
 -> overdue reminder
 -> payment received
 -> stop reminders
```

## Subscription Module

```text
Subscription expiring
 -> reminder
 -> renewal reminder
 -> expiration notice
```

## Event Module

```text
Registration
 -> confirmation
 -> event reminder
 -> final reminder
 -> feedback
```

## School Module

```text
Announcement
 -> parents/students segment
 -> send notification

Fee due
 -> reminder

Event
 -> reminder
```

## Complaint Module

```text
Message/Intent
 -> create ticket
 -> assign
 -> status updates
 -> resolution feedback
```

---

# Phase 13 — Campaigns as a Special Workflow Type

## Goal

Keep the existing campaign engine, but make campaigns part of the wider messaging architecture.

## Migration

Current:

```text
campaign manager
 -> queue
 -> transport
```

Target:

```text
Campaign
 -> audience
 -> message jobs
 -> common queue
 -> channel
 -> delivery
```

## Tasks

- [ ] Preserve current adaptive pacing.
- [ ] Preserve daily caps.
- [ ] Preserve opt-out checks.
- [ ] Preserve duplicate protection.
- [x] Attach campaigns to tenant/channel. *(Done in Phase 2: campaign rows carry `channel_id`.)*
- [ ] Add segments as campaign audiences.
- [ ] Add template support.
- [ ] Add schedule.
- [ ] Add campaign analytics.

---

# Phase 14 — Super Admin Platform

## Goal

Create the central control plane for your service operator.

## Screens

```text
Dashboard
Tenants
Users
WhatsApp Channels
Plans
Subscriptions
Feature Flags
Message Usage
Workflow Usage
Tickets / Support
System Health
Audit Logs
Platform Settings
```

## Tenant Controls

```text
Status: Active / Suspended
Plan
Contact limit
Message limit
Workflow limit
AI enabled
Campaign enabled
FAQ enabled
Tickets enabled
Number limit
```

## Channel Controls

```text
Connected
Disconnected
Sending Enabled
Inbound Enabled
Campaign Enabled
Automation Enabled
Daily Limit
Business Hours
```

## Safety / Compliance Controls

- [ ] Platform-wide sending guardrails.
- [ ] Feature-level restrictions.
- [ ] Opt-out enforcement.
- [x] Audit trail.
- [ ] Suspicious activity flags.
- [x] Manual tenant suspension.
- [ ] Provider error monitoring.
- [ ] Template/usage visibility.

---

# Phase 15 — Billing, Plans & Usage

## Goal

Turn feature flags into monetization controls.

## Metered Usage

```text
active_channels
contacts
messages
workflow_runs
campaigns
agents
storage
ai_usage
api_requests
```

## Plan Structure

```text
Starter
Business
Enterprise
```

Do not hard-code plans inside business logic. Store them as configuration.

## Tasks

- [ ] Plans CRUD.
- [ ] Feature entitlements.
- [ ] Usage counters.
- [ ] Usage limits.
- [ ] Upgrade/downgrade behavior.
- [ ] Grace period behavior.
- [ ] Billing integration later.

---

# Phase 16 — External API & Integrations

## Goal

Allow customers to trigger automations from their existing software.

## APIs

```text
POST /api/v1/events
POST /api/v1/contacts
POST /api/v1/appointments
POST /api/v1/orders
POST /api/v1/payments
POST /api/v1/tickets
```

## Webhooks

```text
message.received
message.delivered
message.failed
workflow.started
workflow.completed
workflow.failed
ticket.created
ticket.updated
```

## Candidate Integrations

```text
Shopify
WooCommerce
CRM
Google Calendar
ERP
School Management Systems
Payment Systems
```

---

# Phase 17 — AI Layer

## Goal

Add AI only after the deterministic automation system is reliable.

## AI Features

```text
FAQ fallback
intent detection
conversation classification
lead qualification
conversation summary
reply suggestions
sentiment classification
smart routing
data extraction
```

## AI Flow

```text
Incoming Message
      |
      v
Deterministic Rules
      |
      v
FAQ / Workflow Match
      |
      v
AI Classification / Retrieval
      |
      v
Safe Response
      |
      +--> Human Handoff when confidence is low
```

## Tasks

- [ ] Provider abstraction for AI.
- [ ] Tenant-level AI enablement.
- [ ] AI budget/usage limits.
- [ ] Confidence threshold.
- [ ] Prompt/version management.
- [ ] Auditability.
- [ ] PII/data handling policy.
- [ ] Human fallback.

---

# Phase 18 — Observability, Security & Production Hardening

## Goal

Make the platform operable at real SaaS scale.

## Tasks

- [ ] Structured logs.
- [ ] Request IDs.
- [ ] Tenant IDs in logs.
- [ ] Workflow execution tracing.
- [ ] Queue metrics.
- [ ] Provider latency metrics.
- [ ] Error-rate alerts.
- [ ] Database backups.
- [ ] Secret management.
- [ ] Encryption for credentials. **Open: channel credentials are stored in plaintext JSON today.**
- [ ] Webhook signature verification (`X-Hub-Signature-256`). **Open: the webhook POST is unauthenticated.**
- [ ] Rate limiting on APIs.
- [ ] Abuse prevention.
- [ ] Permission tests.
- [ ] Data retention policy.
- [ ] Deletion/export flow per tenant.
- [ ] Health checks.
- [ ] Graceful worker shutdown.
- [ ] Disaster recovery procedure.

---

# Phase 19 — Frontend Productization

## Goal

Turn the Angular dashboard into a multi-role SaaS product.

## Super Admin Routes

```text
/admin/dashboard
/admin/tenants
/admin/tenants/:id
/admin/channels
/admin/plans
/admin/usage
/admin/audit-logs
/admin/health
```

## Tenant Routes

```text
/dashboard
/inbox
/contacts
/campaigns
/workflows
/templates
/tickets
/faq
/appointments
/orders
/leads
/payments
/subscriptions
/events
/analytics
/integrations
/settings
```

## Workflow Builder UI

Recommended first version:

```text
Trigger
   |
Condition
   |
Action
   |
Wait
   |
Action
```

Build a simple form-based editor first. Add full drag-and-drop only after the runtime model is stable.

---

# Phase 20 — Migration of the Current Project

## Goal

Migrate the existing WhatsApp Sender without throwing away working code.

## Existing Modules to Reuse

```text
protocol.js
contacts.js
campaign/manager.js
campaign/queue.js
campaign/limits.js
campaign/safety.js
autoreply/engine.js
autoreply/optout.js
paymentReminders.js
transports/base.js
transports/cloudApi.js
transports/whatsappWeb.js
transports/sandbox.js
```

## Migration Mapping

```text
OLD                         NEW
-------------------------------------------------
messages.db                PostgreSQL
config.json                tenant/channel settings
campaign manager           campaign + message service
autoreply engine           workflow + inbound rules
payment reminders          payment object + workflow
contacts                   tenant contacts
SSE store                  tenant-scoped realtime store
transport abstraction      channel/provider layer
```

## Important Rule

Do not delete the old system immediately.

Run both modes during migration where practical:

```text
legacy campaign path
        |
        +--> common message service

new workflow path
        |
        +--> common message service
```

Once the new path is stable, retire legacy execution pieces one by one.

---

# Recommended Implementation Order

Use this order even if the UI appears tempting to build first:

```text
1. Multi-tenancy                 DONE
2. Authentication + roles        DONE
3. WhatsApp channels             DONE
4. Common message service        DONE
5. Contacts + custom fields      DONE
6. Templates
7. Workflow data model
8. Workflow runtime
9. Scheduler
10. Unified inbox
11. Tickets
12. FAQ / knowledge base
13. Business objects
14. Ready-made automation modules
15. Super Admin controls
16. Plans + usage
17. Public API + integrations
18. AI
19. Production hardening
20. Full UI polish
```

---

# MVP Target

Do not try to launch every module at once.

A strong first SaaS MVP is:

```text
Multi-tenant accounts
        +
Multiple WhatsApp channels
        +
Contacts
        +
Templates
        +
Workflow engine
        +
Scheduler
        +
Inbox
        +
FAQ
        +
Tickets
        +
Appointment reminders
        +
Lead follow-up
        +
Payment reminders
        +
Super Admin
```

After this is stable, add:

```text
Orders
Subscriptions
Events
Schools
Advanced analytics
Integrations
AI
Billing automation
```

---

# Non-Negotiable Architecture Rules

## Rule 1 — Every request has a tenant context

```text
request
 -> authenticated user
 -> tenant
 -> permission
 -> resource
```

## Rule 2 — Every outbound message has tenant + channel context

```text
message_job
  -> tenant_id
  -> channel_id
```

## Rule 3 — The engine never hard-codes a business

Never write:

```js
if (business === 'ABC') { ... }
```

Use configuration and workflows instead.

## Rule 4 — Business modules use the same workflow runtime

```text
appointment workflow
order workflow
lead workflow
payment workflow
school workflow
```

All execute through the same engine.

## Rule 5 — Provider is separate from automation

```text
Workflow
  -> Message Service
      -> Provider Router
          -> Cloud API
          -> WhatsApp Web
          -> Sandbox
```

## Rule 6 — AI is optional

The platform must work correctly without AI.

## Rule 7 — Every automation execution is observable

Store:

```text
workflow run
step
input
output
status
error
timestamps
```

## Rule 8 — Tenant isolation is tested, not assumed

Every core API test suite should include cross-tenant denial tests.

## Rule 9 — Configuration beats code duplication

New industry modules should mostly add:

```text
object
fields
triggers
actions
templates
workflow recipes
UI
```

not a new automation engine.

## Rule 10 — Compliance is part of the product architecture

Consent, opt-out handling, provider rules, template requirements, limits, audit logs, and administrative controls must be enforced centrally rather than left to individual workflow authors.

---

# Suggested Future Repository Structure

```text
server/src/
  index.js
  app.js

  config/
  auth/
  tenants/
  users/
  permissions/

  channels/
  messaging/
  queue/

  contacts/
  conversations/
  inbox/
  templates/

  workflows/
    definitions/
    engine/
    scheduler/
    actions/
    triggers/
    conditions/
    runtime/

  campaigns/
  tickets/
  knowledge/

  objects/
    appointments/
    orders/
    leads/
    payments/
    subscriptions/
    events/
    students/

  integrations/
  analytics/
  billing/
  audit/
  compliance/

  transports/
    base.js
    cloudApi.js
    whatsappWeb.js
    sandbox.js
```

Frontend:

```text
web/src/app/
  core/
  auth/
  admin/
  dashboard/
  channels/
  inbox/
  contacts/
  campaigns/
  templates/
  workflows/
  tickets/
  faq/
  appointments/
  orders/
  leads/
  payments/
  subscriptions/
  events/
  analytics/
  integrations/
  settings/
```

---

# Final Product Concept

The product should eventually feel like:

```text
              YOUR SAAS
                  |
        +---------+---------+
        |                   |
    SUPER ADMIN         CUSTOMER
        |                   |
        |             WhatsApp Number(s)
        |                   |
        |               Contacts
        |                   |
        |              Conversations
        |                   |
        |              Workflows
        |                   |
        |          +--------+--------+
        |          |        |        |
        |       Reminder   FAQ    Tickets
        |          |        |        |
        |       Orders    AI      Humans
        |          |
        +------ Analytics / Usage / Billing
```

The strategic goal is **not** to build a collection of bots.

The strategic goal is to build a **tenant-aware communication and automation engine**, then package that engine into ready-made business workflows.

That architecture lets:

```text
Business A
  -> WhatsApp A
  -> Appointment workflows

Business B
  -> WhatsApp B
  -> Order workflows

Business C
  -> WhatsApp C
  -> School workflows

Business D
  -> WhatsApp D + WhatsApp E
  -> Sales + Support + Payment workflows
```

while the same underlying platform runs all of them safely and independently.
