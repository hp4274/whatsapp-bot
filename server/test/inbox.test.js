/**
 * Phase 8: the unified inbox and human handoff.
 *
 * The claims worth testing are that a conversation is one row per number per
 * channel (so a redelivered inbound bumps rather than duplicates), that the
 * thread is the real merged history and not a third copy of it, that
 * `bot_paused` actually reads back as "do not let the bot talk" for other
 * modules to consult, that a reply leaves through the message service, and
 * that a conversation id guessed by another tenant is a 404 rather than their
 * customer's chat.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { Database } from '../src/db.js';
import { INBOX_SCHEMA } from '../src/inbox/schema.js';
import { ConversationStore, InboxError } from '../src/inbox/store.js';
import { createInboxRouter } from '../src/inbox/routes.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-inbox-'));
let db;
let tenantB;
let server;
let base;
let sent;
let events;

const CHANNEL = 7;

before(async () => {
    db = new Database(path.join(tmp, 't.db'));
    // The main thread wires this into MODULE_SCHEMAS; standalone we apply it.
    db.db.exec(INBOX_SCHEMA);
    db.db.prepare("INSERT INTO tenants (name, slug, status, created_at) VALUES ('B', 'inbox-b', 'active', '2026-01-01T00:00:00+00:00')").run();
    tenantB = db.db.prepare("SELECT id FROM tenants WHERE slug = 'inbox-b'").get().id;

    // A channel runtime in miniature: a channel-scoped handle plus the bits of
    // `state` the router actually touches.
    sent = [];
    events = [];
    const scoped = db.forTenant(1).forChannel(CHANNEL);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { id: 42 };
        next();
    });
    app.use(createInboxRouter({
        db: scoped,
        state: {
            messages: {
                send(job) {
                    sent.push(job);
                    if (job.text === 'boom') return { accepted: false, messageId: null, reason: 'opted_out' };
                    return { accepted: true, messageId: `m.${sent.length}`, reason: null };
                },
            },
            broadcast: (event) => events.push(event),
        },
    }));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const store = (tenantId = 1, channelId = CHANNEL) =>
    new ConversationStore(db.forTenant(tenantId).forChannel(channelId));

let n = 0;
const uniquePhone = () => `+9199000${String((n += 1)).padStart(4, '0')}`;

const call = async (method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};

describe('conversations', () => {
    it('opens one conversation per number and bumps unread on each inbound', () => {
        const inbox = store();
        const phone = uniquePhone();
        const first = inbox.upsertForInbound({ phone });
        assert.equal(first.unreadCount, 1);
        assert.equal(first.status, 'open');
        assert.equal(first.channelId, CHANNEL);
        assert.equal(first.botPaused, false);

        const second = inbox.upsertForInbound({ phone, contactId: 5 });
        assert.equal(second.id, first.id, 'the number is the identity');
        assert.equal(second.unreadCount, 2);
        assert.equal(second.contactId, 5, 'a later inbound can fill in the contact');
        assert.deepEqual(inbox.getByPhone(phone), second);
    });

    it('reopens a closed conversation when the customer comes back', () => {
        const inbox = store();
        const phone = uniquePhone();
        const opened = inbox.upsertForInbound({ phone });
        assert.equal(inbox.setStatus(opened.id, 'closed').status, 'closed');
        assert.equal(inbox.upsertForInbound({ phone }).status, 'open');
    });

    it('refuses an unknown status and a nameless tag', () => {
        const inbox = store();
        const conversation = inbox.upsertForInbound({ phone: uniquePhone() });
        assert.throws(() => inbox.setStatus(conversation.id, 'archived'), InboxError);
        assert.throws(() => inbox.addTag(conversation.id, '  '), InboxError);
    });

    it('filters by status, assignment, unread and number', () => {
        const inbox = store();
        const mine = inbox.upsertForInbound({ phone: uniquePhone() });
        const theirs = inbox.upsertForInbound({ phone: uniquePhone() });
        inbox.assign(mine.id, 42);
        inbox.markRead(theirs.id);
        inbox.setStatus(theirs.id, 'pending');

        const ids = (options) => inbox.list(options).map((row) => row.id);
        assert.ok(ids({ assignedTo: 42 }).includes(mine.id));
        assert.ok(!ids({ assignedTo: 42 }).includes(theirs.id));
        assert.ok(ids({ assignedTo: null }).includes(theirs.id), 'the unassigned queue');
        assert.ok(ids({ unread: true }).includes(mine.id));
        assert.ok(!ids({ unread: true }).includes(theirs.id));
        assert.deepEqual(ids({ status: 'pending', search: theirs.phone.slice(-6) }), [theirs.id]);
        assert.equal(inbox.unassign(mine.id).assignedTo, null);
    });

    it('adds and removes tags without duplicating them', () => {
        const inbox = store();
        const conversation = inbox.upsertForInbound({ phone: uniquePhone() });
        inbox.addTag(conversation.id, 'VIP');
        assert.deepEqual(inbox.addTag(conversation.id, 'vip').tags, ['vip']);
        assert.deepEqual(inbox.removeTag(conversation.id, 'vip').tags, []);
    });

    it('reads the merged history oldest first and clears unread on markRead', () => {
        const inbox = store();
        const scoped = db.forTenant(1).forChannel(CHANNEL);
        const phone = uniquePhone();
        scoped.insertInbound({ messageId: `in.${phone}.1`, sender: phone, body: 'hello?', receivedAt: '2026-02-01T10:00:00Z' });
        scoped.insert({
            messageId: `out.${phone}.1`, recipient: phone, message: 'hi there',
            status: 'SENT', messageType: 'transactional', createdAt: '2026-02-01T10:01:00Z',
        });
        scoped.insertInbound({ messageId: `in.${phone}.2`, sender: phone, body: 'thanks', receivedAt: '2026-02-01T10:02:00Z' });

        const conversation = inbox.upsertForInbound({ phone });
        const thread = inbox.thread(conversation.id);
        assert.deepEqual(thread.map((row) => row.body), ['hello?', 'hi there', 'thanks']);
        assert.deepEqual(thread.map((row) => row.direction), ['inbound', 'outbound', 'inbound']);
        assert.equal(inbox.thread(conversation.id, { limit: 1 }).length, 1);

        assert.equal(inbox.markRead(conversation.id).unreadCount, 0);
        // markRead is also the authority for the per-message flag, so the two
        // cannot disagree about whether an agent has seen the message.
        assert.equal(
            db.db.prepare('SELECT COUNT(*) AS n FROM inbound_messages WHERE sender = ? AND is_read = 0').get(phone).n,
            0,
        );
    });
});

describe('human takeover', () => {
    it('pauses and resumes the bot for one number only', () => {
        const inbox = store();
        const paused = uniquePhone();
        const talking = uniquePhone();
        const conversation = inbox.upsertForInbound({ phone: paused });
        inbox.upsertForInbound({ phone: talking });

        assert.equal(inbox.isBotPaused(paused), false);
        assert.equal(inbox.pauseBot(conversation.id).botPaused, true);
        assert.equal(inbox.isBotPaused(paused), true);
        assert.equal(inbox.isBotPaused(talking), false, 'the mute is per conversation');
        // A number nobody has written to is not muted: silence by default would
        // break every auto-reply to a first-time sender.
        assert.equal(inbox.isBotPaused('+919900099999'), false);
        assert.equal(inbox.resumeBot(conversation.id).botPaused, false);
    });

    it('scopes the mute to the channel the message arrived on', () => {
        const phone = uniquePhone();
        const seven = store(1, CHANNEL);
        const eight = store(1, 8);
        seven.pauseBot(seven.upsertForInbound({ phone }).id);
        eight.upsertForInbound({ phone });
        assert.equal(seven.isBotPaused(phone), true);
        assert.equal(eight.isBotPaused(phone), false);
    });
});

describe('notes', () => {
    it('keeps internal notes against the conversation', () => {
        const inbox = store();
        const conversation = inbox.upsertForInbound({ phone: uniquePhone() });
        inbox.addNote(conversation.id, 42, 'refund promised');
        assert.throws(() => inbox.addNote(conversation.id, 42, '   '), InboxError);
        const notes = inbox.notes(conversation.id);
        assert.equal(notes.length, 1);
        assert.equal(notes[0].body, 'refund promised');
        assert.equal(notes[0].userId, 42);
    });
});

describe('stats', () => {
    it('counts by status, the unassigned queue and the oldest unanswered', () => {
        const inbox = store();
        const phone = uniquePhone();
        inbox.upsertForInbound({ phone, at: '2026-01-01T00:00:00Z' });
        const stats = inbox.stats();
        assert.ok(stats.byStatus.open >= 1);
        assert.equal(stats.total, inbox.list({ limit: 1000 }).length);
        assert.ok(stats.unassigned >= 1);
        assert.equal(stats.oldestUnansweredAt, '2026-01-01T00:00:00Z');
        assert.ok(stats.oldestUnansweredSeconds > 0);
    });
});

describe('tenant isolation', () => {
    it('hides another tenant\'s conversation behind a 404', async () => {
        const mine = store().upsertForInbound({ phone: uniquePhone() });
        const other = store(tenantB);
        assert.equal(other.get(mine.id), null);
        assert.throws(() => other.thread(mine.id), (err) => err instanceof InboxError && err.status === 404);
        assert.throws(() => other.setStatus(mine.id, 'closed'), (err) => err.status === 404);
        assert.throws(() => other.addNote(mine.id, 1, 'nosey'), (err) => err.status === 404);
        assert.equal(other.list().length, 0);

        // And a guessed id over HTTP is absent, not forbidden-but-described.
        const theirs = other.upsertForInbound({ phone: uniquePhone() });
        assert.equal((await call('GET', `/conversations/${theirs.id}`)).status, 404);
        assert.equal((await call('GET', `/conversations/${theirs.id}/thread`)).status, 404);
        assert.equal((await call('POST', `/conversations/${theirs.id}/reply`, { text: 'hi' })).status, 404);
    });
});

describe('inbox routes', () => {
    it('lists, reads and filters conversations', async () => {
        const inbox = store();
        const conversation = inbox.upsertForInbound({ phone: uniquePhone() });
        const listed = await call('GET', '/conversations?limit=1000');
        assert.equal(listed.status, 200);
        assert.ok(listed.body.conversations.some((row) => row.id === conversation.id));

        const one = await call('GET', `/conversations/${conversation.id}`);
        assert.equal(one.body.conversation.id, conversation.id);
        assert.deepEqual(one.body.notes, []);

        const unread = await call('GET', '/conversations?unread=true&limit=1000');
        assert.ok(unread.body.conversations.every((row) => row.unreadCount > 0));
    });

    it('sends a reply through the message service and broadcasts it', async () => {
        const inbox = store();
        const conversation = inbox.upsertForInbound({ phone: uniquePhone() });
        events.length = 0;
        const res = await call('POST', `/conversations/${conversation.id}/reply`, { text: 'on it' });
        assert.equal(res.status, 200);
        assert.equal(res.body.messageId, `m.${sent.length}`);

        const job = sent.at(-1);
        assert.equal(job.messageType, 'transactional', 'a human reply is transactional traffic');
        assert.equal(job.recipient, conversation.phone);
        assert.ok(job.idempotencyKey.startsWith('inbox.'), 'two identical replies are two messages');
        // Answering is reading, and the list has to reorder for the UI.
        assert.equal(res.body.conversation.unreadCount, 0);
        assert.ok(res.body.conversation.lastMessageAt);
        assert.deepEqual(events.map((event) => [event.type, event.action]), [['conversation', 'reply']]);
    });

    it('refuses an empty reply and reports a suppressed one', async () => {
        const conversation = store().upsertForInbound({ phone: uniquePhone() });
        assert.equal((await call('POST', `/conversations/${conversation.id}/reply`, { text: '  ' })).status, 400);
        const blocked = await call('POST', `/conversations/${conversation.id}/reply`, { text: 'boom' });
        assert.equal(blocked.status, 409);
        assert.deepEqual(blocked.body.errors, ['opted_out']);
    });

    it('assigns, changes status, reads and tags over HTTP', async () => {
        const conversation = store().upsertForInbound({ phone: uniquePhone() });
        events.length = 0;
        assert.equal((await call('POST', `/conversations/${conversation.id}/assign`, { userId: 42 }))
            .body.conversation.assignedTo, 42);
        assert.equal((await call('POST', `/conversations/${conversation.id}/assign`, {}))
            .body.conversation.assignedTo, null);
        assert.equal((await call('POST', `/conversations/${conversation.id}/status`, { status: 'pending' }))
            .body.conversation.status, 'pending');
        assert.equal((await call('POST', `/conversations/${conversation.id}/status`, { status: 'nope' })).status, 400);
        assert.equal((await call('POST', `/conversations/${conversation.id}/read`))
            .body.conversation.unreadCount, 0);
        assert.deepEqual((await call('POST', `/conversations/${conversation.id}/tags`, { add: ['Urgent'] }))
            .body.conversation.tags, ['urgent']);
        assert.deepEqual(events.map((event) => event.action), ['assign', 'assign', 'status']);
    });

    it('takes over, hands back and keeps notes', async () => {
        const conversation = store().upsertForInbound({ phone: uniquePhone() });
        const taken = await call('POST', `/conversations/${conversation.id}/takeover`);
        assert.equal(taken.body.conversation.botPaused, true);
        assert.equal(taken.body.conversation.assignedTo, 42, 'taking over claims it');
        assert.equal(store().isBotPaused(conversation.phone), true);

        const back = await call('POST', `/conversations/${conversation.id}/handback`);
        assert.equal(back.body.conversation.botPaused, false);

        const created = await call('POST', `/conversations/${conversation.id}/notes`, { body: 'called them' });
        assert.equal(created.status, 201);
        assert.equal(created.body.note.user_id, 42);
        assert.equal((await call('POST', `/conversations/${conversation.id}/notes`, { body: '' })).status, 400);
        const notes = await call('GET', `/conversations/${conversation.id}/notes`);
        assert.deepEqual(notes.body.notes.map((note) => note.body), ['called them']);
    });

    it('reports inbox stats', async () => {
        const res = await call('GET', '/inbox/stats');
        assert.equal(res.status, 200);
        assert.ok(res.body.stats.total >= 1);
        assert.ok('unassigned' in res.body.stats);
    });
});
