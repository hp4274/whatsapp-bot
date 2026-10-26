/**
 * Outside the sending limits themselves: a reply is never stuck behind a
 * campaign paused at its daily cap.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-tier-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let file = 0;
const freshDb = () => new Database(path.join(tmp, `t${(file += 1)}.db`));

describe('replies under an exhausted daily cap', () => {
    class FakeLive {
        name = 'fake live';
        realDelivery = true;
        supportsReceipts = false;
        sent = [];
        isConnected() { return true; }
        async sendMessage(recipient) {
            this.sent.push(recipient);
            return { providerId: `p${this.sent.length}`, status: Status.SENT };
        }
        getStatus() { return null; }
        async disconnect() {}
    }

    const until = async (check) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !check()) await new Promise((resolve) => setTimeout(resolve, 20));
    };

    it('go out, while the campaign behind them still pauses', async () => {
        const db = freshDb();
        const transport = new FakeLive();
        const manager = new CampaignManager(db, transport, {
            ...DEFAULTS, transport: TRANSPORT_SANDBOX, dailyLimit: 1, rateLimitPerSecond: 1000, pacingMode: 'fixed', humanTiming: false,
        });
        try {
            const now = new Date().toISOString();
            db.insert({ messageId: 'spent', recipient: '919800000000', message: 'hi', status: Status.SENT, messageType: 'campaign', createdAt: now, sentAt: now });
            assert.equal(manager.quota.exhausted(), true);
            manager.enqueueContacts([{ name: 'A', phone: '919811111111' }, { name: 'B', phone: '919822222222' }], 'Hi {name}');
            manager.enqueueJob({ recipient: '919833333333', text: 'Thanks, we got it', messageType: 'auto_reply', priority: 0 });
            manager.start();

            await until(() => manager.pausedByQuota);
            assert.deepEqual(transport.sent, ['919833333333'], 'the reply at the head went; no campaign row did');
            assert.equal(manager.queue.isPaused, true);
            assert.equal(manager.queue.pending, 2, 'the campaign rows wait for tomorrow');

            // A reply that comes in after the pause still goes.
            manager.enqueueJob({ recipient: '919844444444', text: 'Got it', messageType: 'transactional', priority: 1 });
            await until(() => transport.sent.length === 2);
            assert.deepEqual(transport.sent, ['919833333333', '919844444444']);
            assert.equal(manager.queue.isPaused, true);
            assert.equal(manager.queue.pending, 2);
        } finally {
            await manager.shutdown();
            db.close();
        }
    });
});
