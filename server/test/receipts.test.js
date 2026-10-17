/**
 * Two ticks must read as two ticks, and a block must be a block: receipts that
 * land mid-send are not lost, the 12-hour "still one tick" clock starts at the
 * send (not the queueing), and a wrong block is taken back.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULTS } from '../src/config.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';
import { ackStatus } from '../src/transports/baileys.js';

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const config = { ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed', tierSystem: false, safetyEnabled: false, humanTiming: false };

describe('block detection', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-receipts-'));
    let db;
    let scoped;
    let n = 0;
    before(() => {
        db = new Database(path.join(tmp, 'receipts.db'));
        scoped = db.forTenant(1).forChannel(1);
    });
    after(() => {
        db?.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const sent = ({ phone, createdH, updatedH, status = Status.SENT, providerId = null }) => {
        n += 1;
        const messageId = `m${n}`;
        scoped.insert({
            messageId, recipient: phone, message: 'hi', status, providerId, campaignId: 'camp-1',
            createdAt: hoursAgo(createdH), updatedAt: hoursAgo(updatedH),
        });
        return messageId;
    };
    const stuck = () => scoped.stuckSent(hoursAgo(24 * 7), hoursAgo(24)).map((m) => m.messageId);

    it('counts the 24 hours from the send, not from when the campaign queued the row', () => {
        const queuedLongAgo = sent({ phone: '919800000001', createdH: 30, updatedH: 1 });   // went out an hour ago
        const reallyStuck = sent({ phone: '919800000002', createdH: 30, updatedH: 25 });
        const found = stuck();
        assert.equal(found.includes(queuedLongAgo), false);
        assert.equal(found.includes(reallyStuck), true);
    });

    it('does not flag a number that got a later message delivered, or wrote back', () => {
        const older = sent({ phone: '919800000003', createdH: 40, updatedH: 39 });
        sent({ phone: '919800000003', createdH: 20, updatedH: 19, status: Status.DELIVERED });
        const quiet = sent({ phone: '919800000004', createdH: 40, updatedH: 39 });
        scoped.insertInbound({ sender: '919800000004', body: 'ok', receivedAt: hoursAgo(5) });
        const found = stuck();
        assert.equal(found.includes(older), false);
        assert.equal(found.includes(quiet), false);
    });

    it('takes a block back when the ticks arrive late', () => {
        const id = sent({ phone: '919800000005', createdH: 20, updatedH: 14, providerId: 'late-1' });
        assert.equal(scoped.addSafetyEvent({ kind: 'block', phone: '919800000005', messageId: id }), true);
        assert.equal(scoped.safetyEventCounts(hoursAgo(24)).block >= 1, true);
        assert.equal(scoped.applyReceipt('late-1', Status.DELIVERED), true);
        const left = scoped.safetyEvents(100).filter((e) => e.phone === '919800000005');
        assert.equal(left.length, 0, 'delivered means not blocked');
    });

    it('sweeps old wrong blocks: a later delivery to the same number clears them', () => {
        const id = sent({ phone: '919800000006', createdH: 40, updatedH: 39 });
        scoped.addSafetyEvent({ kind: 'block', phone: '919800000006', messageId: id });
        assert.equal(scoped.healBlocks(), 0, 'still one tick and nothing newer: the block stays');
        sent({ phone: '919800000006', createdH: 10, updatedH: 9, status: Status.READ });
        assert.equal(scoped.healBlocks(), 1);
    });
});

describe('a receipt that beats the database', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-receipts-'));
    let db;
    let scoped;
    before(() => {
        db = new Database(path.join(tmp, 'late.db'));
        scoped = db.forTenant(1).forChannel(1);
    });
    after(() => {
        db?.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('still lands: the transport remembers it and the manager applies it after the send is recorded', async () => {
        const memory = new Map();
        const transport = {
            name: 'fake', realDelivery: true, supportsReceipts: true, isConnected: () => true,
            async sendMessage() {
                // The phone answers before the send call even returns: no row has this provider id yet.
                const manager = this.manager;
                manager.handleReceipt('p-late', Status.DELIVERED);
                memory.set('p-late', Status.DELIVERED);
                return { providerId: 'p-late', status: Status.SENT };
            },
            getStatus: (id) => memory.get(id) ?? null,
            async disconnect() {},
        };
        const manager = new CampaignManager(scoped, transport, config);
        transport.manager = manager;
        manager.enqueueContacts([{ name: 'A', phone: '919800000010' }], 'Hi {name}', { campaignId: 'camp-late' });
        manager.start();
        const end = Date.now() + 4000;
        let row;
        while (Date.now() < end) {
            row = scoped.getByProviderId('p-late');
            if (row?.status === Status.DELIVERED) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        await manager.shutdown();
        assert.equal(row?.status, Status.DELIVERED);
    });
});

describe('status mapping', () => {
    it('reads numbers and enum names alike', () => {
        assert.equal(ackStatus(3), Status.DELIVERED);
        assert.equal(ackStatus('DELIVERY_ACK'), Status.DELIVERED);
        assert.equal(ackStatus('READ'), Status.READ);
        assert.equal(ackStatus(5), Status.READ);
        assert.equal(ackStatus('PLAYED'), Status.READ);
        assert.equal(ackStatus(1), null);
    });
});
