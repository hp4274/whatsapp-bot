/**
 * The unified inbox: one row per number per channel, holding the state a human
 * agent needs on top of the message history.
 *
 * The thread itself is still derived from `messages` + `inbound_messages` -
 * the same join `ContactStore.timeline()` does - rather than copied into a
 * third table that could disagree with them.  This store does not reuse
 * `timeline()` because that method is keyed by contact id and returns newest
 * first; an inbox thread is keyed by number and channel (a conversation can
 * exist before a contact row does) and reads oldest first, which is what a
 * chat pane renders.
 *
 * `unread_count` is incremented, not computed.  `inbound_messages.is_read`
 * already exists and already counts unread per sender, so computing would mean
 * a correlated subquery on every list read for a number the UI polls
 * constantly.  The two are kept in step instead: `markRead` zeroes the column
 * and marks the sender's inbound rows read in the same call, so the derived
 * value and the authority cannot drift apart in the only direction that
 * matters (an agent having read a message).
 */

import { utcNow } from '../protocol.js';

export const CONVERSATION_STATUSES = Object.freeze(['open', 'pending', 'closed']);

export class InboxError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export class ConversationStore {
    /** @param {import('../db.js').Database} database a tenant- or channel-scoped handle */
    constructor(database) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        // 0 is the "no channel" sentinel; see the note in schema.js.
        this.channelId = database.channelId ?? 0;
        this.raw = database;
    }

    // ------------------------------------------------------------- writes --
    /**
     * A message arrived from this number: make sure a conversation exists and
     * bump the unread counter.  Called from the inbound path, so it has to be
     * cheap and must never throw on a number it has not seen.
     *
     * A new message on a closed conversation reopens it - the customer is
     * back, whatever an agent decided last week.
     */
    upsertForInbound({ phone, channelId, contactId = null, at = null } = {}) {
        const number = String(phone ?? '').trim();
        if (!number) throw new InboxError('a conversation needs a phone');
        const channel = channelId == null ? this.channelId : Number(channelId);
        const now = at ?? utcNow();
        const existing = this.getByPhone(number, channel);

        if (!existing) {
            const info = this.db.prepare(
                `INSERT INTO conversations (tenant_id, channel_id, contact_id, phone, status,
                                            unread_count, last_message_at, last_inbound_at,
                                            tags, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'open', 1, ?, ?, '[]', ?, ?)`)
                .run(this.tenantId, channel, contactId, number, now, now, now, now);
            return this.get(Number(info.lastInsertRowid));
        }

        this.db.prepare(
            `UPDATE conversations
             SET unread_count = unread_count + 1,
                 last_inbound_at = ?, last_message_at = ?,
                 status = CASE WHEN status = 'closed' THEN 'open' ELSE status END,
                 contact_id = COALESCE(?, contact_id),
                 updated_at = ?
             WHERE id = ? AND tenant_id = ?`)
            .run(now, now, contactId, now, existing.id, this.tenantId);
        return this.get(existing.id);
    }

    /** We sent something on this conversation. Keeps the list ordering honest. */
    touchOutbound(id, at = null) {
        const conversation = this.#require(id);
        const now = at ?? utcNow();
        this.db.prepare('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
            .run(now, now, conversation.id, this.tenantId);
        return this.get(conversation.id);
    }

    assign(id, userId) {
        const user = Number(userId);
        if (!Number.isInteger(user)) throw new InboxError('assign needs a user id');
        return this.#patch(id, 'assigned_to = ?', [user]);
    }

    unassign(id) {
        return this.#patch(id, 'assigned_to = NULL', []);
    }

    setStatus(id, status) {
        if (!CONVERSATION_STATUSES.includes(status)) {
            throw new InboxError(`status must be one of ${CONVERSATION_STATUSES.join(', ')}`);
        }
        return this.#patch(id, 'status = ?', [status]);
    }

    markRead(id) {
        const conversation = this.#require(id);
        // Zero the counter and the per-message flags together: two authorities
        // for "read" are tolerable only while they are written in one place.
        this.raw.markInboundRead?.(conversation.phone);
        return this.#patch(conversation.id, 'unread_count = 0', []);
    }

    addTag(id, tag) {
        const conversation = this.#require(id);
        const clean = normalizeTag(tag);
        if (!clean) throw new InboxError('a tag needs a name');
        if (conversation.tags.includes(clean)) return conversation;
        return this.#patch(conversation.id, 'tags = ?', [JSON.stringify([...conversation.tags, clean])]);
    }

    removeTag(id, tag) {
        const conversation = this.#require(id);
        const clean = normalizeTag(tag);
        return this.#patch(conversation.id, 'tags = ?',
            [JSON.stringify(conversation.tags.filter((value) => value !== clean))]);
    }

    /** Human takeover: the bot stops talking over the agent. */
    pauseBot(id) {
        return this.#patch(id, 'bot_paused = 1', []);
    }

    /** Hand back to the bot. */
    resumeBot(id) {
        return this.#patch(id, 'bot_paused = 0', []);
    }

    // -------------------------------------------------------------- reads --
    get(id) {
        const row = this.db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId);
        return row ? toConversation(row) : null;
    }

    getByPhone(phone, channelId) {
        const channel = channelId == null ? this.channelId : Number(channelId);
        const row = this.db.prepare(
            'SELECT * FROM conversations WHERE tenant_id = ? AND channel_id = ? AND phone = ?')
            .get(this.tenantId, channel, String(phone));
        return row ? toConversation(row) : null;
    }

    list({ status = null, assignedTo = undefined, unread = false, search = null, limit = 100 } = {}) {
        const clauses = ['tenant_id = ?'];
        const args = [this.tenantId];
        if (status) {
            clauses.push('status = ?');
            args.push(String(status));
        }
        if (assignedTo === null || assignedTo === 'none') {
            clauses.push('assigned_to IS NULL');
        } else if (assignedTo !== undefined && assignedTo !== '') {
            clauses.push('assigned_to = ?');
            args.push(Number(assignedTo));
        }
        if (unread) clauses.push('unread_count > 0');
        if (search) {
            clauses.push('phone LIKE ?');
            args.push(`%${search}%`);
        }
        args.push(Math.min(Number(limit) || 100, 1000));
        return this.db.prepare(
            `SELECT * FROM conversations WHERE ${clauses.join(' AND ')}
             ORDER BY COALESCE(last_message_at, created_at) DESC, id DESC LIMIT ?`)
            .all(...args).map(toConversation);
    }

    /**
     * The merged history for this conversation, oldest first.
     *
     * Rows written before channels existed carry a NULL channel_id, so they
     * match any channel rather than disappearing from the thread.
     */
    thread(id, { limit = 100 } = {}) {
        const conversation = this.#require(id);
        const cap = Math.min(Number(limit) || 100, 1000);
        const channelMatch = conversation.channelId
            ? 'AND (channel_id = ? OR channel_id IS NULL)' : '';
        const channelArgs = conversation.channelId ? [conversation.channelId] : [];

        const outbound = this.db.prepare(
            `SELECT message_id, message_type, message, status, created_at
             FROM messages WHERE tenant_id = ? AND recipient = ? ${channelMatch}
             ORDER BY created_at DESC LIMIT ?`)
            .all(this.tenantId, conversation.phone, ...channelArgs, cap);
        const inbound = this.db.prepare(
            `SELECT message_id, sender_name, body, received_at
             FROM inbound_messages WHERE tenant_id = ? AND sender = ? ${channelMatch}
             ORDER BY received_at DESC, id DESC LIMIT ?`)
            .all(this.tenantId, conversation.phone, ...channelArgs, cap);

        return [
            ...outbound.map((row) => ({
                at: row.created_at, direction: 'outbound', kind: row.message_type ?? 'campaign',
                messageId: row.message_id, body: row.message, status: row.status, from: '',
            })),
            ...inbound.map((row) => ({
                at: row.received_at, direction: 'inbound', kind: 'message',
                messageId: row.message_id, body: row.body, status: null, from: row.sender_name ?? '',
            })),
        ]
            // Take the newest `cap` across both sides, then flip: a chat pane
            // wants the latest page of history, read top to bottom.
            .sort((a, b) => String(b.at).localeCompare(String(a.at)))
            .slice(0, cap)
            .reverse();
    }

    /**
     * Is the bot muted for this number?  Other modules consult this before
     * sending anything automatic, which is the whole point of the phase.
     *
     * An unknown number is not paused: silence by default would break every
     * auto-reply to a first-time sender.
     */
    isBotPaused(phone, channelId) {
        const channel = channelId == null ? this.channelId : Number(channelId);
        const row = this.db.prepare(
            'SELECT bot_paused FROM conversations WHERE tenant_id = ? AND channel_id = ? AND phone = ?')
            .get(this.tenantId, channel, String(phone));
        return Boolean(row?.bot_paused);
    }

    stats() {
        const byStatus = Object.fromEntries(CONVERSATION_STATUSES.map((status) => [status, 0]));
        for (const row of this.db.prepare(
            'SELECT status, COUNT(*) AS n FROM conversations WHERE tenant_id = ? GROUP BY status')
            .all(this.tenantId)) {
            byStatus[row.status] = row.n;
        }
        const row = this.db.prepare(
            `SELECT COUNT(*) AS unassigned FROM conversations
             WHERE tenant_id = ? AND assigned_to IS NULL AND status != 'closed'`).get(this.tenantId);
        // Unanswered means the last thing that happened was the customer
        // talking: last_message_at is still the inbound one.
        const oldest = this.db.prepare(
            `SELECT MIN(last_inbound_at) AS at FROM conversations
             WHERE tenant_id = ? AND status != 'closed'
               AND last_inbound_at IS NOT NULL AND last_inbound_at = last_message_at`)
            .get(this.tenantId).at;

        return {
            byStatus,
            total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
            unassigned: row.unassigned,
            unread: this.db.prepare(
                'SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ? AND unread_count > 0')
                .get(this.tenantId).n,
            oldestUnansweredAt: oldest ?? null,
            oldestUnansweredSeconds: oldest
                ? Math.max(0, Math.round((Date.now() - Date.parse(oldest)) / 1000)) : null,
        };
    }

    // -------------------------------------------------------------- notes --
    /** Internal only: a note is never sent anywhere. */
    addNote(id, userId, body) {
        const conversation = this.#require(id);
        const text = String(body ?? '').trim();
        if (!text) throw new InboxError('a note needs a body');
        const info = this.db.prepare(
            `INSERT INTO conversation_notes (tenant_id, conversation_id, user_id, body, created_at)
             VALUES (?, ?, ?, ?, ?)`)
            .run(this.tenantId, conversation.id, userId == null ? null : Number(userId), text, utcNow());
        return this.db.prepare('SELECT * FROM conversation_notes WHERE id = ?')
            .get(Number(info.lastInsertRowid));
    }

    notes(id) {
        const conversation = this.#require(id);
        return this.db.prepare(
            'SELECT * FROM conversation_notes WHERE tenant_id = ? AND conversation_id = ? ORDER BY id')
            .all(this.tenantId, conversation.id)
            .map((row) => ({
                id: row.id,
                conversationId: row.conversation_id,
                userId: row.user_id,
                body: row.body,
                createdAt: row.created_at,
            }));
    }

    // ------------------------------------------------------------ private --
    #require(id) {
        const conversation = this.get(id);
        if (!conversation) throw new InboxError('conversation not found', 404);
        return conversation;
    }

    #patch(id, assignment, args) {
        const conversation = this.#require(id);
        this.db.prepare(
            `UPDATE conversations SET ${assignment}, updated_at = ? WHERE id = ? AND tenant_id = ?`)
            .run(...args, utcNow(), conversation.id, this.tenantId);
        return this.get(conversation.id);
    }
}

const normalizeTag = (tag) => String(tag ?? '').trim().toLowerCase();

function toConversation(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        channelId: row.channel_id,
        contactId: row.contact_id ?? null,
        phone: row.phone,
        status: row.status,
        assignedTo: row.assigned_to ?? null,
        unreadCount: row.unread_count,
        lastMessageAt: row.last_message_at ?? null,
        lastInboundAt: row.last_inbound_at ?? null,
        botPaused: Boolean(row.bot_paused),
        tags: parseTags(row.tags),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function parseTags(value) {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}
