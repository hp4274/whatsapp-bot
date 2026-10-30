/**
 * A restart empties the engine's in-memory queue. The campaign still reads
 * `running` and its rows are still QUEUED, so without recovery nothing would
 * ever send them and the detail page would sit at 0.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { CampaignManager } from '../src/campaign/manager.js';
import { CampaignStore, campaignKey, openCampaigns } from '../src/campaigns/store.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, timeoutMs = 6000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await predicate()) return true;
        await sleep(25);
    }
    return false;
};

const config = { ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed', transport: TRANSPORT_SANDBOX, safetyEnabled: false, humanTiming: false };
const phones = Array.from({ length: 5 }, (_, i) => `9198111${String(i).padStart(5, '0')}`);

describe('a campaign across a restart', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-recover-'));
    let db;
    let scoped;
    const sent = [];
    const transport = {
        name: 'fake', realDelivery: true, supportsReceipts: false, isConnected: () => true,
        async sendMessage(to) {
            sent.push(to);
            return { providerId: `p${sent.length}`, status: Status.SENT };
        },
        getStatus: () => null,
        async disconnect() {},
    };
    const boot = (via = transport) => {
        const manager = new CampaignManager(scoped, via, config);
        const store = new CampaignStore(scoped, { contacts: new ContactStore(scoped, '91'), manager, canSend: () => true });
        return { manager, store };
    };

    before(() => {
        db = new Database(path.join(tmp, 'recover.db'));
        scoped = db.forTenant(1).forChannel(1);
    });
    after(() => {
        db?.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('queues the unsent rows again, under their own ids, and finishes', async () => {
        // The first process: its first send never returns, like a process killed mid-send.
        const first = boot({ ...transport, sendMessage: () => new Promise(() => {}) });
        const campaign = first.store.create({
            name: 'Restart', body: 'Hi {name}', status: 'draft',
            audience: phones.map((phone, i) => ({ name: `P${i}`, phone })),
        });
        first.store.start(campaign.id);
        await sleep(100);

        const key = campaignKey(campaign.id);
        const rows = scoped.db.prepare('SELECT message_id, recipient, status FROM messages WHERE campaign_id = ? ORDER BY rowid').all(key);
        assert.equal(rows.length, 5);
        assert.equal(rows[0].status, Status.SENDING, 'caught mid-send');
        scoped.updateStatus(rows[1].message_id, Status.SENT); // one went out before the restart

        const second = boot(); // the restart: a new manager, nothing in memory
        assert.deepEqual(openCampaigns(scoped).map((c) => c.id), [campaign.id]);
        assert.equal(second.store.recover(campaign.id), true);
        assert.equal(second.store.recover(campaign.id), false, 'a live run is not queued twice');
        assert.equal(second.manager.stats.total, 5);
        assert.equal(second.manager.stats.successful, 1);

        assert.equal(await waitFor(() => sent.length === 4), true);
        assert.equal(sent.includes(rows[1].recipient), false, 'the one already sent is not sent again');
        assert.equal(await waitFor(() => second.store.stats(campaign.id).campaign.status === 'done'), true);
        assert.equal(scoped.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE campaign_id = ?').get(key).n, 5, 'no row was added');
        assert.deepEqual(openCampaigns(scoped), []);
        await second.manager.shutdown();
    });

    it('keeps a contact\'s own timezone field on the queued item, across a restart too', async () => {
        const audience = [
            { name: 'NY', phone: '12125550101', extra: { timezone: 'America/New_York' } },
            { name: 'Typo', phone: '12125550102', extra: { timezone: 'Mars/Olympus' } },
            { name: 'None', phone: '12125550103' },
        ];
        // Queued, plus the one in flight.
        const zones = (manager) => Object.fromEntries([...manager.queue.snapshot(), manager.current].filter(Boolean)
            .map((i) => [i.recipient, i.timezone]));
        const expected = { 12125550101: 'America/New_York', 12125550102: null, 12125550103: null };

        // Its send never returns, so all three rows stay unsent for the restart.
        const first = boot({ ...transport, sendMessage: () => new Promise(() => {}) });
        const campaign = first.store.create({ name: 'Zones', body: 'Hi {name}', status: 'draft', audience });
        first.store.start(campaign.id);
        first.store.pause(campaign.id);
        assert.deepEqual(zones(first.manager), expected);
        first.manager.shutdown(); // not awaited: a send in flight never returns; the rows stay as they are

        const second = boot(); // the restart: rebuilt from the rows and the campaign's audience, still paused
        try {
            assert.equal(second.store.recover(campaign.id), true);
            assert.deepEqual(zones(second.manager), expected);
        } finally {
            await second.manager.shutdown();
        }
    });
});
