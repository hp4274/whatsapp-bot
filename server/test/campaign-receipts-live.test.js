/**
 * The Delivery funnel is only as live as the chain behind it: a Baileys ACK has
 * to reach the message row, the analytics the page reloads, and the SSE stream
 * the page listens on - long after the campaign itself is `done`. Each hop is
 * asserted here over a real HTTP listener with a fake socket.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { CampaignStore, campaignKey } from '../src/campaigns/store.js';
import { DEFAULTS, TRANSPORT_BAILEYS } from '../src/config.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-live-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 6000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await predicate()) return true;
        await sleep(25);
    }
    return false;
};

class FakeSock {
    ev = new EventEmitter();
    user = { id: '15550000001:7@s.whatsapp.net' };
    sends = 0;
    async sendMessage(jid) {
        this.sends += 1;
        return { key: { id: `LIVE${this.sends}`, remoteJid: jid, fromMe: true } };
    }
    async onWhatsApp(...jids) { return jids.map((jid) => ({ jid, exists: true })); }
    async logout() {}
    async end() {}
}

describe('receipts reach a finished campaign\'s funnel', () => {
    let app;
    let server;
    let base;
    let db;
    let sock;
    let stream;
    let seen = '';
    const phones = ['919866600001', '919866600002', '919866600003'];

    const api = async (method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const ack = (id, status) => sock.ev.emit('messages.update', [
        { key: { id, remoteJid: `${phones[0]}@s.whatsapp.net`, fromMe: true }, update: { status } },
    ]);
    const funnel = async (id) => (await api('GET', `/api/campaigns/${id}/analytics`)).body.funnel;
    // `done` is written by the first stats read after the last send (the analytics call the page makes), not by a timer.
    const finished = (id) => waitFor(async () => {
        await sleep(100); // the API's own rate limit is 20 requests a second
        return (await api('GET', `/api/campaigns/${id}/analytics`)).body.campaign.status === 'done';
    }, 40_000);
    const receiptEvents = () => (seen.match(/"type":"receipt"/g) ?? []).length;

    before(async () => {
        db = new Database(path.join(tmp, 'live.db'));
        const config = {
            ...DEFAULTS, transport: TRANSPORT_BAILEYS, rateLimitPerSecond: 1000, pacingMode: 'fixed',
            safetyEnabled: false, humanTiming: false, defaultCountryCode: '91',
        };
        delete config.misc;
        app = createTestApp({
            db, config,
            deps: {
                sessionDir: tmp,
                setTimeoutFn: (fn) => setTimeout(fn, 0),
                createSocket: async () => {
                    sock = new FakeSock();
                    setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
                    return sock;
                },
            },
        });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        assert.equal((await api('POST', '/api/connection/connect')).status, 200);

        // The browser's stream, opened once and left open - as it is for the life of the tab.
        stream = new AbortController();
        const res = await fetch(`${base}/api/events`, { signal: stream.signal });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        void (async () => {
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    seen += decoder.decode(value, { stream: true });
                }
            } catch { /* aborted */ }
        })();
    });

    after(async () => {
        stream?.abort();
        await closeApp(app);
        server?.close();
        db?.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('delivered then read ACKs, minutes after `done`, change the funnel and the stream', async () => {
        const created = await api('POST', '/api/campaigns', {
            name: 'Live funnel', body: 'Hi {name}',
            audience: phones.map((phone, i) => ({ name: `P${i}`, phone })), options: { pacing: 'fast' },
        });
        const { id } = created.body.campaign;
        assert.equal((await api('POST', `/api/campaigns/${id}/start`)).status, 200);
        assert.equal(await finished(id), true);

        let f = await funnel(id);
        assert.deepEqual([f.sent, f.delivered, f.read], [3, 0, 0], 'finished and all one tick');

        const before = receiptEvents();
        ack('LIVE1', 3);
        ack('LIVE2', 3);
        assert.equal(await waitFor(async () => (await funnel(id)).delivered === 2), true, 'delivered lands on the funnel');
        assert.equal(await waitFor(() => receiptEvents() >= before + 2), true, 'and on the SSE stream');

        ack('LIVE1', 4);
        f = await funnel(id);
        assert.deepEqual([f.sent, f.delivered, f.read], [3, 2, 1], 'read counts as delivered too');
        assert.equal(await waitFor(() => receiptEvents() >= before + 3), true);

        ack('LIVE1', 3); // a late "delivered" must not take the read back
        assert.equal((await funnel(id)).read, 1);
        assert.equal(receiptEvents(), before + 3, 'a downgrade is not an event');
    });

    it('a read that beats its delivered still counts both', async () => {
        const created = await api('POST', '/api/campaigns', {
            name: 'Read first', body: 'Hi {name}', audience: [{ name: 'Z', phone: '919866600099' }], options: { pacing: 'fast' },
        });
        const { id } = created.body.campaign;
        const key = campaignKey(id);
        await api('POST', `/api/campaigns/${id}/start`);
        assert.equal(await finished(id), true);
        const row = db.history({ campaignId: key })[0];
        ack(row.providerId, 4);
        ack(row.providerId, 3);
        const f = await funnel(id);
        assert.deepEqual([f.delivered, f.read], [1, 1]);
    });

    it('counts the newest row per recipient, so a retried number is not counted twice', () => {
        const scoped = db.forTenant(1).forChannel(1);
        const store = new CampaignStore(scoped, { contacts: new ContactStore(scoped, '91') });
        const { id } = store.create({ name: 'Retried', body: 'hi' });
        const row = (messageId, status) => scoped.insert({
            messageId, recipient: '919866600077', message: 'hi', status, campaignId: campaignKey(id), providerId: `p-${messageId}`,
        });
        row('old', Status.FAILED);
        row('new', Status.SENT);
        assert.equal(scoped.applyReceipt('p-new', Status.READ), true);
        const { funnel: f } = store.analytics(id);
        assert.deepEqual([f.queued, f.sent, f.delivered, f.read, f.failed], [1, 1, 1, 1, 0]);
    });
});
