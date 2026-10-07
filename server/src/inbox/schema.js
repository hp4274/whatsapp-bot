/**
 * Tables for the unified inbox.
 *
 * A conversation is not a third copy of the message history - the thread is
 * still read from `messages` + `inbound_messages`.  What lives here is the
 * state a human needs that the message tables cannot express: who owns the
 * conversation, whether it is still open, and whether the bot has been told to
 * stay quiet because an agent is typing.
 *
 * `channel_id` is NOT NULL with a 0 sentinel rather than nullable, because
 * SQLite treats NULLs as distinct in a UNIQUE index: a nullable channel_id
 * would let the same number open an unbounded number of "no channel"
 * conversations, which is exactly what the constraint exists to prevent.
 */

export const INBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       INTEGER NOT NULL,
    channel_id      INTEGER NOT NULL DEFAULT 0,
    contact_id      INTEGER,
    phone           TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    -- A user id, or NULL for the unassigned queue.
    assigned_to     INTEGER,
    unread_count    INTEGER NOT NULL DEFAULT 0,
    last_message_at TEXT,
    last_inbound_at TEXT,
    -- Human takeover: while this is 1, auto-replies and workflow sends for
    -- this number must not fire.
    bot_paused      INTEGER NOT NULL DEFAULT 0,
    tags            TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (tenant_id, channel_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_conversations_status   ON conversations(tenant_id, status, last_message_at);
CREATE INDEX IF NOT EXISTS idx_conversations_assigned ON conversations(tenant_id, assigned_to);
-- The takeover predicate is on the auto-reply hot path: it looks up by number.
CREATE INDEX IF NOT EXISTS idx_conversations_phone    ON conversations(tenant_id, phone);

CREATE TABLE IF NOT EXISTS conversation_notes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       INTEGER NOT NULL,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         INTEGER,
    body            TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_notes ON conversation_notes(conversation_id, id);
`;
