/** The super admin's speed reaches a number's engine at once: a wait under way follows it, not only the next one. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';

import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULTS, TRANSPORT_BAILEYS } from '../src/config.js';
import { Database } from '../src/db.js';
import { applySendingPolicy } from '../src/policy/levels.js';
import { Status } from '../src/protocol.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-speed-live-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !check()) await sleep(20);
    return check();
};

class FakeLive {
    realDelivery = true;
    supportsReceipts = false;
    supportsRegistrationCheck = false;
    sent = [];
    isConnected() { return true; }
    async sendMessage(to) {
        this.sent.push({ to, at: Date.now() });
        return { providerId: `p${this.sent.length}`, status: Status.SENT };
    }
    getStatus() { return null; }
    async disconnect() {}
}

it('a wait under way follows a new speed from the super admin, and the countdown says so', { timeout: 60_000 }, async () => {
    const db = new Database(path.join(tmp, 'live.db'));
    const transport = new FakeLive();
    const config = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, rateLimitPerSecond: 1000, retryDelay: 0.01 };
    delete config.misc;
    const manager = new CampaignManager(db, transport, config);
    // The business's speed as the runtime reads it (limits.sendSpeed -> sending.speed), on a number at the top level.
    const values = { 'sending.speed': 300 };
    applySendingPolicy(manager.quota, () => values, () => ({ level: 11, at: new Date().toISOString() }));
    const waits = [];
    manager.on('event', (e) => { if (e.type === 'pacing') waits.push(e.seconds); });
    try {
        manager.enqueueContacts([{ name: 'A', phone: '919811110001' }, { name: 'B', phone: '919811110002' }], 'Hi {name}', { campaignId: 'speed' });
        manager.start();
        assert.ok(await until(() => transport.sent.length === 1 && manager.waitingUntil), 'the first goes, the second waits');
        const before = Math.round((manager.waitingUntil - Date.now()) / 1000);
        assert.ok(before > 60, `300 a day waits minutes (${before}s)`);

        values['sending.speed'] = 200_000; // the super admin sets the fastest speed: what a save does (touchTenants)
        manager.quota.refreshTables();
        manager.quota.invalidate();
        assert.ok(await until(() => transport.sent.length === 2, 20_000), 'the wait shrank to the new speed');
        assert.ok(waits.length >= 2 && waits.at(-1) < 15, `and the countdown followed: ${waits.join(', ')}s`);
    } finally {
        await manager.shutdown();
        db.close();
    }
});
