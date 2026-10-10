/**
 * Inbox page upgrades: attachments on replies (resolved from an issued
 * mediaId, never a client-supplied object), the bot-paused filter, the
 * filter-chip counts, the context the thread carries for each bubble, and
 * agents being allowed to upload the file they attach.
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
import { ConversationStore } from '../src/inbox/store.js';
import { createInboxRouter } from '../src/inbox/routes.js';
import { closeApp } from '../src/app.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-inbox-page-'));
const CHANNEL = 3;
const MEDIA = { mediaId: 'med_0123456789ab', filename: 'menu.pdf', mimetype: 'application/pdf', filePath: '/safe/menu.pdf' };
let db;
let server;
let base;
let sent;

before(async () => {
    db = new Database(path.join(tmp, 't.db'));
    db.db.exec(INBOX_SCHEMA);
    sent = [];
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
            media: new Map([[MEDIA.mediaId, MEDIA]]),
            messages: {
                send(job) {
                    sent.push(job);
                    const messageId = `pg.${sent.length}`;
                    // The real service writes the outbound row; do the same so the thread can see it.
                    scoped.insert({
                        messageId, recipient: job.recipient, message: job.text,
                        status: 'SENT', messageType: job.messageType,
                    });
                    return { accepted: true, messageId, reason: null };
                },
            },
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

const store = () => new ConversationStore(db.forTenant(1).forChannel(CHANNEL));
let n = 0;
const uniquePhone = () => `+9198800${String((n += 1)).padStart(4, '0')}`;
const call = async (method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};

describe('reply attachments', () => {
    it('resolves mediaId to the stored file and shows it in the thread', async () => {
        const conversation = store().upsertForInbound({ phone: uniquePhone() });
        const res = await call('POST', `/conversations/${conversation.id}/reply`, { mediaId: MEDIA.mediaId, text: ' Our menu ' });
        assert.equal(res.status, 200);
        const job = sent.at(-1);
        assert.equal(job.media, MEDIA, 'the server-side record, not anything from the body');
        assert.equal(job.text, 'Our menu');

        const { body } = await call('GET', `/conversations/${conversation.id}/thread`);
        const out = body.thread.find((row) => row.messageId === res.body.messageId);
        assert.deepEqual(out.media, {
            mediaId: MEDIA.mediaId, mimetype: 'application/pdf', filename: 'menu.pdf', url: `/api/media/${MEDIA.mediaId}`,
        });
        assert.equal('filePath' in out.media, false, 'never leak the disk path');
    });

    it('sends media without a caption', async () => {
        const conversation = store().upsertForInbound({ phone: uniquePhone() });
        const res = await call('POST', `/conversations/${conversation.id}/reply`, { mediaId: MEDIA.mediaId });
        assert.equal(res.status, 200);
        assert.equal(sent.at(-1).text, '');
    });

    it('404s an unknown mediaId and sends nothing', async () => {
        const conversation = store().upsertForInbound({ phone: uniquePhone() });
        const before = sent.length;
        const res = await call('POST', `/conversations/${conversation.id}/reply`, { mediaId: 'med_ffffffffffff', text: 'x' });
        assert.equal(res.status, 404);
        assert.deepEqual(res.body.errors, ['media not found']);
        assert.equal(sent.length, before);
    });

    it('ignores a raw media object in the body', async () => {
        const conversation = store().upsertForInbound({ phone: uniquePhone() });
        const evil = { filePath: '/etc/passwd', mimetype: 'application/pdf', filename: 'x.pdf' };
        const bare = await call('POST', `/conversations/${conversation.id}/reply`, { media: evil });
        assert.equal(bare.status, 400, 'no text and no issued media is not a reply');
        const withText = await call('POST', `/conversations/${conversation.id}/reply`, { media: evil, text: 'hi' });
        assert.equal(withText.status, 200);
        assert.equal(sent.at(-1).media, null);
    });
});

describe('filters and counts', () => {
    it('filters to bot-paused conversations', async () => {
        const inbox = store();
        const paused = inbox.upsertForInbound({ phone: uniquePhone() });
        const talking = inbox.upsertForInbound({ phone: uniquePhone() });
        inbox.pauseBot(paused.id);
        const { body } = await call('GET', '/conversations?botPaused=true');
        const ids = body.conversations.map((row) => row.id);
        assert.ok(ids.includes(paused.id));
        assert.ok(!ids.includes(talking.id));
        assert.ok(body.conversations.every((row) => row.botPaused));
    });

    it('counts mine and bot-paused for the signed-in user, skipping closed', async () => {
        const inbox = store();
        const before = (await call('GET', '/inbox/stats')).body.stats;
        const a = inbox.upsertForInbound({ phone: uniquePhone() });
        const b = inbox.upsertForInbound({ phone: uniquePhone() });
        inbox.assign(a.id, 42);
        inbox.assign(b.id, 42);
        inbox.pauseBot(a.id);
        inbox.setStatus(b.id, 'closed');
        const { stats } = (await call('GET', '/inbox/stats')).body;
        assert.equal(stats.mine, before.mine + 1);
        assert.equal(stats.botPaused, before.botPaused + 1);
        assert.equal(inbox.stats().mine, 0, 'no user, no "mine"');
    });
});

describe('thread context', () => {
    it('carries the campaign of an outbound and the rule that answered an inbound', () => {
        const inbox = store();
        const scoped = db.forTenant(1).forChannel(CHANNEL);
        const phone = uniquePhone();
        scoped.insert({
            messageId: `cmp.${phone}`, recipient: phone, message: 'Sale today', status: 'DELIVERED',
            messageType: 'campaign', campaignId: 'diwali', createdAt: '2026-03-01T10:00:00Z',
        });
        scoped.insertInbound({ messageId: `in.${phone}`, sender: phone, body: 'price?', receivedAt: '2026-03-01T10:05:00Z' });
        scoped.markInboundReplied(`in.${phone}`, 'price');
        const conversation = inbox.upsertForInbound({ phone });
        const [out, inbound] = inbox.thread(conversation.id);
        assert.equal(out.campaignId, 'diwali');
        assert.equal(out.media, null);
        assert.equal(inbound.repliedRule, 'price');
    });
});

describe('button clicks', () => {
    it('tags an inbound with the campaign button it was a tap on', () => {
        const inbox = store();
        const scoped = db.forTenant(1).forChannel(CHANNEL);
        const phone = uniquePhone();
        scoped.insertInbound({ messageId: `tap.${phone}`, sender: phone, body: 'Yes', receivedAt: '2026-03-02T10:00:00Z' });
        scoped.insertInbound({ messageId: `txt.${phone}`, sender: phone, body: 'hello', receivedAt: '2026-03-02T10:01:00Z' });
        db.db.prepare(`INSERT INTO button_clicks (tenant_id, channel_id, campaign_id, recipient, option_id, option_title,
                       payload, inbound_message_id, at) VALUES (1, ?, 'promo', ?, 'yes', 'Yes please', 'YES', ?, '2026-03-02T10:00:00Z')`)
            .run(CHANNEL, phone, `tap.${phone}`);
        // Another tenant's click on the same message id must not leak in.
        db.db.prepare(`INSERT INTO button_clicks (tenant_id, recipient, inbound_message_id, option_title, at)
                       VALUES (999, ?, ?, 'theirs', '2026-03-02T10:00:00Z')`).run(phone, `txt.${phone}`);
        const conversation = inbox.upsertForInbound({ phone });
        const [tap, text] = inbox.thread(conversation.id);
        assert.deepEqual(tap.button, { campaignId: 'promo', optionId: 'yes', title: 'Yes please', payload: 'YES' });
        assert.equal(text.button, null);
    });
});

describe('agents and attachments', () => {
    let app;
    let appDb;
    let listener;
    let url;

    before(async () => {
        appDb = new Database(path.join(tmp, 'app.db'));
        app = createTestApp({ db: appDb, dataDir: tmp });
        listener = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => listener.once('listening', resolve));
        url = `http://127.0.0.1:${listener.address().port}`;
    });
    after(async () => {
        await closeApp(app);
        listener?.close();
        appDb?.close();
    });

    it('lets an agent upload the file they attach to a reply', async () => {
        const token = sessionFor(app, { tenantId: 1, role: 'agent' });
        const form = new FormData();
        form.set('file', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'Quote.pdf');
        const res = await fetch(`${url}/api/media/upload`, {
            method: 'POST', body: form, headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(res.status, 201);
        assert.match((await res.json()).mediaId, /^med_/);
    });
});
