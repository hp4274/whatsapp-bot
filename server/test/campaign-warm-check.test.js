/**
 * `POST /campaigns/warm-check`: of a campaign's people, how many each number already chats with, so the
 * Review step can say which number reaches them as a known chat.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-warm-check-'));

describe('warm-check', () => {
    let app;
    let server;
    let base;
    let db;

    before(async () => {
        db = new Database(path.join(tmp, 'warm.db'));
        const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX };
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
            headers: body ? { 'content-type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
    };

    it('counts, per number, the people it sent to or heard from', async () => {
        const own = (await api('GET', '/api/channels')).body.channels[0].id;
        const other = (await api('POST', '/api/channels', { displayName: 'B', settings: { transport: TRANSPORT_SANDBOX } }))
            .body.channel.id;
        db.forTenant(1).forChannel(own).insertInbound({ sender: '919800000001', body: 'hi' });
        db.forTenant(1).forChannel(other).insert({ messageId: 'w1', recipient: '919800000002', message: 'x', status: 'DELIVERED' });
        // Sandbox and failed sends never reached anyone: still a new chat.
        db.forTenant(1).forChannel(other).insert({ messageId: 'w2', recipient: '919800000003', message: 'x', status: 'FAILED' });

        const res = await api('POST', '/api/campaigns/warm-check', {
            phones: ['+91 98000 00001', '919800000002', '919800000003', '919800000001'],
            channelIds: [own, other, 99999],
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body, { checked: 3, warm: { [own]: 1, [other]: 1 } });
    });
});
