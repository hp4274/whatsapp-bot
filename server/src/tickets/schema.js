/**
 * Phase 9 tables. Add to `MODULE_SCHEMAS` in `src/schema.js`.
 *
 * `ticket_events` is append-only: it is the audit trail an operator shows a
 * customer when they dispute what was promised, so nothing in this codebase
 * ever UPDATEs or DELETEs a row in it. Every field change on a ticket writes
 * one, which is why `tickets` can be a plain mutable row.
 *
 * `conversation_id` is a bare INTEGER with no foreign key. Phase 8 owns the
 * conversation table and the two phases ship independently; a ticket filed
 * before conversations exist is still a ticket.
 */

export const TICKETS_SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    channel_id INTEGER,
    contact_id INTEGER,
    conversation_id INTEGER,
    reference TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'OPEN',
    assigned_to INTEGER,
    source TEXT NOT NULL DEFAULT 'manual',
    subject TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    sla_due_at TEXT,
    first_response_at TEXT,
    resolved_at TEXT,
    satisfaction_score INTEGER,
    satisfaction_comment TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_reference ON tickets(tenant_id, reference);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant_status ON tickets(tenant_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned ON tickets(tenant_id, assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tickets_contact ON tickets(tenant_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_tickets_sla ON tickets(tenant_id, status, sla_due_at);

CREATE TABLE IF NOT EXISTS ticket_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    ticket_id INTEGER NOT NULL,
    user_id INTEGER,
    kind TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT,
    body TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events(tenant_id, ticket_id, id);
`;
