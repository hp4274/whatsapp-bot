/**
 * A/B campaign versions.
 *
 * Claims under test: `options.variants` is validated (2-3 versions keyed A, B,
 * C; never with a Meta template); the engine splits a batch evenly, sends each
 * person their version's text and stores which one; the safety checks run on
 * every version; a retry keeps a person's version; analytics count per version.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { CampaignManager } from '../src/campaign/manager.js';
import { SafetyError } from '../src/campaign/safety.js';
import { CampaignStore, campaignKey, normalizeOptions } from '../src/campaigns/store.js';
import { DEFAULTS } from '../src/config.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';
import { TransportSendError } from '../src/transports/base.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-ab-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, timeoutMs = 6000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await predicate()) return true;
        await sleep(25);
    }
    return false;
};

const engineConfig = { ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed', retryDelay: 0.01, maxRetries: 0, tierSystem: false };
const people = (n, prefix) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, phone: `${prefix}${String(i).padStart(3, '0')}` }));

describe('variant options', () => {
    it('accepts 2-3 versions keyed in order and refuses the rest', () => {
        const two = normalizeOptions({ variants: [{ key: 'A', body: 'Hi {name}' }, { body: 'Hello {name}' }] });
        assert.deepEqual(two.variants, [{ key: 'A', body: 'Hi {name}' }, { key: 'B', body: 'Hello {name}' }]);
        assert.equal(normalizeOptions({ variants: [] }).variants, null);
        assert.throws(() => normalizeOptions({ variants: [{ key: 'A', body: 'x' }] }), /2 to 3/);
        assert.throws(() => normalizeOptions({ variants: [{ key: 'B', body: 'x' }, { key: 'A', body: 'y' }] }), /in order/);
        assert.throws(() => normalizeOptions({ variants: [{ key: 'A', body: 'x' }, { key: 'B', body: ' ' }] }), /version B needs/);
        assert.throws(() => normalizeOptions({
            templateMode: 'meta', variants: [{ key: 'A', body: 'x' }, { key: 'B', body: 'y' }],
        }), /Meta template/);
    });
});

describe('the engine', () => {
    let db;
    before(() => { db = new Database(path.join(tmp, 'engine.db')); });
    after(() => db?.close());

    it('splits the batch evenly and stores each version', async () => {
        const sent = [];
        const transport = {
            name: 'fake', realDelivery: true, isConnected: () => true, getStatus: () => null, async disconnect() {},
            sendMessage: async (to, text) => {
                sent.push({ to, text });
                return { providerId: `p${sent.length}`, status: Status.SENT };
            },
        };
        const manager = new CampaignManager(db, transport, engineConfig);
        manager.enqueueContacts(people(7, '9198000003'), 'unused', {
            campaignId: 'camp-ab-engine',
            variants: [{ key: 'A', body: 'Hi {name}' }, { key: 'B', body: 'Hello {name}' }, { key: 'C', body: 'Hey {name}' }],
        });
        manager.start();
        assert.ok(await waitFor(() => sent.length === 7));
        await manager.shutdown();

        const rows = db.db.prepare("SELECT recipient, message, variant FROM messages WHERE campaign_id = 'camp-ab-engine'").all();
        const by = (key) => rows.filter((r) => r.variant === key);
        assert.deepEqual([by('A').length, by('B').length, by('C').length], [3, 2, 2]);
        for (const row of rows) {
            const name = `P${Number(row.recipient.slice(-3))}`;
            assert.equal(row.message, `${{ A: 'Hi', B: 'Hello', C: 'Hey' }[row.variant]} ${name}`);
        }
    });

    it('runs the content checks on every version', () => {
        const manager = new CampaignManager(db, null, engineConfig);
        assert.throws(() => manager.enqueueContacts(people(2, '9198000004'), 'fine', {
            variants: [{ key: 'A', body: 'Hello {name}, a quiet note' }, { key: 'B', body: 'HUGE SALE TODAY ONLY BUY NOW {name}' }],
        }), SafetyError);
        assert.equal(manager.queue.pending, 0);
    });
});

describe('the campaign store', () => {
    let db;
    let scoped;
    let manager;
    let store;
    const failOnce = new Set(['919800000000', '919800000001']);

    before(() => {
        db = new Database(path.join(tmp, 'store.db'));
        scoped = db.forTenant(1).forChannel(1);
        const transport = {
            name: 'fake', realDelivery: false, isConnected: () => true, getStatus: () => null, async disconnect() {},
            sendMessage: async (to) => {
                if (failOnce.delete(to)) throw new TransportSendError('rejected', { retryable: false });
                return { providerId: `p-${to}-${Math.random()}`, status: Status.SENT };
            },
        };
        manager = new CampaignManager(scoped, transport, engineConfig);
        store = new CampaignStore(scoped, { contacts: new ContactStore(scoped, '91'), manager });
    });
    after(async () => {
        await manager.shutdown();
        db?.close();
    });

    it('keeps each person on their version through a retry, and reports per version', async () => {
        const c = store.create({
            name: 'AB',
            audience: people(6, '919800000'), // 919800000000 .. 919800000005
            options: { variants: [{ key: 'A', body: 'Hi {name}' }, { key: 'B', body: 'Hello {name}' }] },
        });
        assert.equal(store.messageText(c), 'Hi {name}', 'version A stands for the campaign');
        store.start(c.id);
        assert.ok(await waitFor(() => store.stats(c.id).campaign.status === 'done'));
        const before = Object.fromEntries(store.latestRows(c.id).map((r) => [r.recipient, r.variant]));
        assert.equal(Object.values(before).filter((v) => v === 'A').length, 3);

        const { queued } = store.retryFailed(c.id);
        assert.equal(queued, 2);
        assert.ok(await waitFor(() => store.stats(c.id).campaign.status === 'done'));
        const after = store.latestRows(c.id);
        assert.ok(after.every((r) => r.status === Status.SENT));
        for (const row of after) assert.equal(row.variant, before[row.recipient], row.recipient);

        scoped.insertInbound({ sender: '919800000002', body: 'yes!' });
        const report = store.analytics(c.id);
        assert.equal(report.variants.length, 2);
        for (const v of report.variants) {
            assert.equal(v.sent, 3);
            assert.equal(v.failed, 0);
            assert.deepEqual(Object.keys(v), ['key', 'sent', 'delivered', 'read', 'replied', 'failed', 'clickedLink']);
        }
        const repliedKey = before['919800000002'];
        assert.equal(report.variants.find((v) => v.key === repliedKey).replied, 1);
        assert.equal(report.recipients.find((r) => r.phone === '919800000002').variant, repliedKey);
        assert.equal(store.analytics(store.create({ name: 'plain', body: 'hi' }).id).variants, null);
        assert.ok(scoped.countsByStatus(campaignKey(c.id)).SENT >= 6);
    });
});
