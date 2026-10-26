/** The progress card lists who goes out next, in the worker's own order. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';

const config = { ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed', transport: TRANSPORT_SANDBOX, safetyEnabled: false, humanTiming: false };

describe('upNext', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-upnext-'));
    let db;
    before(() => {
        db = new Database(path.join(tmp, 'up.db'));
    });
    after(() => {
        db?.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('puts the message in flight first, then the queue in send order', async () => {
        const scoped = db.forTenant(1).forChannel(1);
        const transport = {
            name: 'fake', realDelivery: false, supportsReceipts: false, isConnected: () => true,
            sendMessage: () => new Promise(() => {}), // the first send never returns: it stays "in flight"
            getStatus: () => null,
            async disconnect() {},
        };
        const manager = new CampaignManager(scoped, transport, config);
        const people = ['Asha', 'Bela', 'Chirag', 'Dev', 'Esha'].map((name, i) => ({ name, phone: `9198000000${i}0` }));
        manager.enqueueContacts(people, 'Hi {name}', { campaignId: 'camp-up' });
        manager.start();
        const end = Date.now() + 3000;
        while (!manager.current && Date.now() < end) await new Promise((r) => setTimeout(r, 10));

        const list = manager.upNext(3);
        assert.equal(list.length, 3);
        assert.equal(list[0].sending, true);
        assert.match(list[0].message, /^Hi /);
        // The rest is exactly the queue's head, same order, none of them flagged "later".
        const head = manager.queue.snapshot().slice(0, 2).map((i) => i.messageId);
        assert.deepEqual(list.slice(1).map((m) => m.messageId), head);
        assert.equal(list.every((m) => m.later === false), true);
        assert.equal(manager.upNext(10).length, 5);
    });
});
