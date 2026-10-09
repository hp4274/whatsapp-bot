/** A `message` column in the contact sheet gives that number its own text. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULTS } from '../src/config.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';

it('sends a number its own message, and everyone else the shared one', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-bulk-'));
    const db = new Database(path.join(tmp, 'b.db'));
    const sent = [];
    const transport = {
        name: 'fake', realDelivery: true, supportsReceipts: false,
        isConnected: () => true,
        async sendMessage(to, text) { sent.push([to, text]); return { providerId: `p${sent.length}`, status: Status.SENT }; },
        getStatus: () => null,
        async disconnect() {},
    };
    const manager = new CampaignManager(db, transport, { ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed' });
    manager.enqueueContacts(
        [{ name: 'A', phone: '919855550001', extra: { message: 'Special offer for {name}' } },
         { name: 'B', phone: '919855550002' }],
        'Hi {name}');
    manager.start();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && sent.length < 2) await new Promise((r) => setTimeout(r, 25));
    await manager.shutdown();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.deepEqual(Object.fromEntries(sent), { '919855550001': 'Special offer for A', '919855550002': 'Hi B' });
});
