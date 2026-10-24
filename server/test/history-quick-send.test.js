/**
 * Two regressions over HTTP:
 *  - History's 204 signature missed writes made in the same second as the
 *    page it answered, so a campaign's sends stayed "QUEUED" in the browser.
 *  - The composer's "Quick single message" refused the same text to the same
 *    number forever ("already queued"), long after the first one was sent.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-history-'));

describe('history and quick send over HTTP', () => {
    let app;
    let server;
    let base;
    let db;

    before(async () => {
        db = new Database(path.join(tmp, 'history.db'));
        const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 50, rateLimitBurst: 50, tierSystem: false };
        delete config.misc;
        app = createTestApp({ db, config });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        await closeApp(app);
        server?.close();
        db?.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const api = async (method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const settled = async (ids) => {
        for (let i = 0; i < 100; i += 1) {
            const rows = (await api('GET', '/api/history')).body.records.filter((r) => ids.includes(r.messageId));
            if (rows.length === ids.length && rows.every((r) => r.status === 'SANDBOX')) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.fail('messages never left the queue');
    };

    it('sends the same quick message to the same number again', async () => {
        assert.equal((await api('POST', '/api/connection/connect')).status, 200);
        const body = { recipient: '919855500001', message: 'Hello {name}, your order has been confirmed.', name: 'A' };
        const first = await api('POST', '/api/messages', body);
        assert.equal(first.status, 200, JSON.stringify(first.body));
        await settled([first.body.messageId]);

        const again = await api('POST', '/api/messages', body);
        assert.equal(again.status, 200, JSON.stringify(again.body));
        assert.notEqual(again.body.messageId, first.body.messageId);
        await settled([again.body.messageId]);

        // A caller's own Idempotency-Key still dedupes a retried POST.
        const keyed = async () => (await fetch(`${base}/api/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': 'retry-1' },
            body: JSON.stringify({ ...body, message: 'Keyed' }),
        })).json();
        const one = await keyed();
        const two = await keyed();
        assert.equal(two.messageId, one.messageId);
    });

    it('shows a campaign\'s sends made in the same second as the page the browser holds', async () => {
        const audience = Array.from({ length: 3 }, (_, i) => ({ name: `P${i}`, phone: `91985550010${i}` }));
        const { id } = (await api('POST', '/api/campaigns', { name: 'Hist', body: 'Hi {name}', audience })).body.campaign;
        assert.equal((await api('POST', `/api/campaigns/${id}/start`)).status, 200);
        // The page the browser holds: rows just queued.
        const held = await api('GET', '/api/history');
        const ids = held.body.records.filter((r) => r.campaignId === `camp-${id}`).map((r) => r.messageId);
        assert.equal(ids.length, 3);
        await settled(ids);

        const fresh = await api('GET', `/api/history?signature=${encodeURIComponent(held.body.signature)}`);
        const heldStatuses = held.body.records.filter((r) => ids.includes(r.messageId)).map((r) => r.status);
        if (heldStatuses.every((s) => s === 'SANDBOX')) return; // the sends beat the first read: nothing to miss
        assert.equal(fresh.status, 200, 'the sends changed the rows, so the signature must change');
        assert.ok(fresh.body.records.filter((r) => ids.includes(r.messageId)).every((r) => r.status === 'SANDBOX'));
    });

    it('changes the history signature on a status change inside the same second', () => {
        const scratch = new Database(path.join(tmp, 'signature.db'));
        try {
            scratch.insert({ messageId: 'sig-1', recipient: '919855500200', message: 'hi', status: 'QUEUED' });
            const queued = scratch.historySignature();
            scratch.updateStatus('sig-1', 'SENDING', { attempt: 1 });
            const sending = scratch.historySignature();
            scratch.updateStatus('sig-1', 'SENT', { attempt: 1 });
            const sent = scratch.historySignature();
            // Same row count; updated_at may well be the same second for all three.
            assert.equal(sent.count, queued.count);
            assert.notDeepEqual(sending, queued);
            assert.notDeepEqual(sent, sending);
        } finally {
            scratch.close();
        }
    });
});
