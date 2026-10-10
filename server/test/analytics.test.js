/**
 * Analytics overview: the figures behind the Analytics page.
 *
 * The claims worth testing are the definitions (attempted / delivered / read
 * and the two rates), the per-campaign breakdown and its names, the response
 * time math (median, nearest-rank p90, "within" shares over all
 * conversations), that broadcasts and failed sends are not "responses", that
 * the date range really filters, and that another tenant or another number
 * never leaks into the answer.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { closeApp } from '../src/app.js';
import { createAnalyticsRouter } from '../src/analytics/routes.js';
import { AnalyticsStore, median, parseDays, percentile } from '../src/analytics/store.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-analytics-'));
const CHANNEL = 7;
const OTHER_CHANNEL = 8;
const NOW = new Date();
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const at = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString().replace(/\.\d{3}Z$/, '+00:00');

let db;
let tenantB;
let server;
let base;
let seq = 0;

function send(handle, { status, type = 'campaign', campaignId = '', recipient = '910000', ago = MIN }) {
    seq += 1;
    handle.insert({
        messageId: `m${seq}`, messageType: type, recipient, message: 'hi', status,
        campaignId, createdAt: at(ago), updatedAt: at(ago),
    });
}
function inbound(handle, { sender, ago, rule = null }) {
    seq += 1;
    handle.insertInbound({ messageId: `in${seq}`, sender, body: 'hello', repliedRule: rule, receivedAt: at(ago) });
}
const many = (handle, n, fields) => { for (let i = 0; i < n; i += 1) send(handle, fields); };

before(async () => {
    db = new Database(path.join(tmp, 'a.db'));
    db.db.prepare("INSERT INTO tenants (name, slug, status, created_at) VALUES ('B', 'analytics-b', 'active', '2026-01-01T00:00:00+00:00')").run();
    tenantB = db.db.prepare("SELECT id FROM tenants WHERE slug = 'analytics-b'").get().id;

    // Campaign records: #1 is ours; #2 belongs to tenant B and must not name our camp-2 rows.
    const campaign = db.db.prepare(
        `INSERT INTO campaigns (id, tenant_id, channel_id, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'completed', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')`);
    campaign.run(1, 1, CHANNEL, 'Diwali Sale');
    campaign.run(2, tenantB, CHANNEL, 'Secret B campaign');

    const a = db.forTenant(1).forChannel(CHANNEL);

    // camp-1, an hour ago: 4 READ, 3 DELIVERED, 1 SENT, 1 FAILED, 1 QUEUED.
    many(a, 4, { status: 'READ', campaignId: 'camp-1', ago: 60 * MIN });
    many(a, 3, { status: 'DELIVERED', campaignId: 'camp-1', ago: 60 * MIN });
    send(a, { status: 'SENT', campaignId: 'camp-1', ago: 60 * MIN });
    send(a, { status: 'FAILED', campaignId: 'camp-1', ago: 60 * MIN });
    send(a, { status: 'QUEUED', campaignId: 'camp-1', ago: 30 * MIN });
    // camp-1, 40 days ago: only inside the 90-day window.
    many(a, 2, { status: 'READ', campaignId: 'camp-1', ago: 40 * DAY });
    // A legacy run id, two days ago.
    many(a, 2, { status: 'READ', campaignId: 'abc123def456', ago: 2 * DAY });
    many(a, 2, { status: 'DELIVERED', campaignId: 'abc123def456', ago: 2 * DAY });
    // camp-2 has no record of ours (tenant B owns #2).
    send(a, { status: 'SENT', campaignId: 'camp-2', ago: 90 * MIN });

    // Conversations.
    // A: first in 60m ago (rule price), auto-reply 30 s later; a second inbound later.
    inbound(a, { sender: '911111', ago: 60 * MIN, rule: 'price' });
    send(a, { status: 'SENT', type: 'auto_reply', recipient: '911111', ago: 60 * MIN - 30 * 1000, campaignId: 'camp-1' });
    inbound(a, { sender: '911111', ago: 30 * MIN, rule: 'price' });
    // B: first in 120m ago; a reminder at +1m and a failed reply at +2m are not
    // responses; the agent reply at +10m is.
    inbound(a, { sender: '912222', ago: 120 * MIN });
    send(a, { status: 'SENT', type: 'reminder', recipient: '912222', ago: 119 * MIN });
    send(a, { status: 'FAILED', type: 'transactional', recipient: '912222', ago: 118 * MIN });
    send(a, { status: 'DELIVERED', type: 'transactional', recipient: '912222', ago: 110 * MIN });
    // C: first in 300m ago (rule hours), auto-reply 2 h later.
    inbound(a, { sender: '913333', ago: 300 * MIN, rule: 'hours' });
    send(a, { status: 'READ', type: 'auto_reply', recipient: '913333', ago: 180 * MIN });
    // D: a message sent BEFORE they wrote does not answer them.
    send(a, { status: 'SENT', type: 'transactional', recipient: '914444', ago: 20 * MIN });
    inbound(a, { sender: '914444', ago: 10 * MIN });
    // E: wrote 50 days ago, never answered (90-day window only).
    inbound(a, { sender: '915555', ago: 50 * DAY });

    // Noise that must never show up: another number of ours, and tenant B on
    // the same channel id.
    const otherNumber = db.forTenant(1).forChannel(OTHER_CHANNEL);
    many(otherNumber, 3, { status: 'READ', campaignId: 'camp-1', ago: 60 * MIN });
    inbound(otherNumber, { sender: '916666', ago: 60 * MIN, rule: 'price' });
    const b = db.forTenant(tenantB).forChannel(CHANNEL);
    many(b, 5, { status: 'READ', campaignId: 'camp-2', ago: 60 * MIN });
    send(b, { status: 'SENT', type: 'auto_reply', recipient: '911111', ago: 59 * MIN });
    inbound(b, { sender: '911111', ago: 61 * MIN, rule: 'secret' });

    const app = express();
    app.use(createAnalyticsRouter({ db: a }));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const overview = (days = 30, tenantId = 1, channelId = CHANNEL) =>
    new AnalyticsStore(db.forTenant(tenantId).forChannel(channelId)).overview({ days, now: NOW });

describe('analytics helpers', () => {
    it('validates the range: 7, 30 or 90, defaulting to 30', () => {
        assert.equal(parseDays(undefined), 30);
        assert.equal(parseDays(''), 30);
        assert.equal(parseDays('7'), 7);
        assert.equal(parseDays(90), 90);
        for (const bad of ['14', 'abc', '-7', '30.5', '0']) assert.throws(() => parseDays(bad), /days must be one of/);
    });

    it('takes the median and a nearest-rank p90', () => {
        assert.equal(median([]), null);
        assert.equal(median([5]), 5);
        assert.equal(median([1, 3]), 2);
        assert.equal(median([1, 2, 9]), 2);
        assert.equal(percentile([], 0.9), null);
        assert.equal(percentile([10, 20, 30], 0.9), 30);
        assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
    });
});

describe('analytics overview', () => {
    it('totals outbound messages with clear definitions and rates', () => {
        const { totals, range } = overview(30);
        assert.equal(range.days, 30);
        // camp-1 10, legacy 4, camp-2 1, auto-replies 2, B 3, D 1.
        assert.equal(totals.total, 21);
        assert.equal(totals.pending, 1);
        assert.equal(totals.attempted, 20);
        assert.equal(totals.failed, 2);
        assert.equal(totals.sent, 18);
        assert.equal(totals.delivered, 13, 'DELIVERED + READ');
        assert.equal(totals.read, 7);
        assert.equal(totals.deliveryRate, 65, '13 / 20');
        assert.equal(totals.readRate, 53.8, '7 / 13');
        assert.equal(totals.failureRate, 10);
        assert.equal(totals.byStatus.READ, 7);
        assert.equal(totals.byType.auto_reply, 2);
        assert.equal(totals.byType.reminder, 1);
    });

    it('returns one zero-filled point per UTC day in the range', () => {
        const { daily, totals } = overview(30);
        assert.equal(daily.length, 30);
        assert.equal(daily.at(-1).date, NOW.toISOString().slice(0, 10));
        assert.equal(daily.reduce((a, d) => a + d.total, 0), totals.total);
        const twoDaysAgo = daily.find((d) => d.date === new Date(NOW.getTime() - 2 * DAY).toISOString().slice(0, 10));
        assert.deepEqual(
            { total: twoDaysAgo.total, sent: twoDaysAgo.sent, delivered: twoDaysAgo.delivered, read: twoDaysAgo.read, failed: twoDaysAgo.failed },
            { total: 4, sent: 4, delivered: 4, read: 2, failed: 0 });
        assert.equal(overview(7).daily.length, 7);
    });

    it('breaks campaigns down with names, rates and send window', () => {
        const { campaigns } = overview(30);
        assert.deepEqual(campaigns.map((c) => c.campaignId).sort(), ['abc123def456', 'camp-1', 'camp-2']);
        const diwali = campaigns.find((c) => c.campaignId === 'camp-1');
        assert.equal(diwali.name, 'Diwali Sale');
        assert.equal(diwali.recordId, 1);
        assert.equal(diwali.total, 10, 'the auto-reply carrying camp-1 is not a campaign message');
        assert.equal(diwali.attempted, 9);
        assert.equal(diwali.sent, 8);
        assert.equal(diwali.delivered, 7);
        assert.equal(diwali.read, 4);
        assert.equal(diwali.failed, 1);
        assert.equal(diwali.pending, 1);
        assert.equal(diwali.deliveryRate, 77.8);
        assert.equal(diwali.readRate, 57.1);
        assert.equal(diwali.firstSentAt, at(60 * MIN));
        assert.equal(diwali.lastSentAt, at(60 * MIN), 'the queued row is not a send');

        const legacy = campaigns.find((c) => c.campaignId === 'abc123def456');
        assert.equal(legacy.name, 'Run abc123def456');
        assert.equal(legacy.recordId, null);
        assert.equal(legacy.readRate, 50);
        assert.equal(legacy.deliveryRate, 100);

        const foreign = campaigns.find((c) => c.campaignId === 'camp-2');
        assert.equal(foreign.name, 'Campaign #2', "tenant B's campaign name never leaks");
        assert.equal(foreign.recordId, null);
        assert.equal(foreign.readRate, null, 'nothing delivered means no read rate');

        assert.equal(campaigns[0].campaignId, 'camp-1', 'most recent activity first');
        assert.equal(overview(90).campaigns.find((c) => c.campaignId === 'camp-1').total, 12);
    });

    it('counts auto-reply hits and the top rules', () => {
        const { autoReplies } = overview(30);
        assert.equal(autoReplies.messages, 2);
        assert.equal(autoReplies.inbound, 5);
        assert.equal(autoReplies.matched, 3);
        assert.equal(autoReplies.matchRate, 60);
        assert.deepEqual(autoReplies.topRules, [{ rule: 'price', count: 2 }, { rule: 'hours', count: 1 }]);
    });

    it('measures first response time per conversation', () => {
        const r = overview(30).responseTimes;
        // A 30 s, B 600 s (reminder and failed send ignored), C 7200 s, D unanswered.
        assert.equal(r.conversations, 4);
        assert.equal(r.answered, 3);
        assert.equal(r.unanswered, 1);
        assert.equal(r.medianSeconds, 600);
        assert.equal(r.p90Seconds, 7200);
        assert.equal(r.averageSeconds, 2610);
        assert.equal(r.within5m, 1);
        assert.equal(r.within1h, 2);
        assert.equal(r.within5mPct, 25, 'shares are of all conversations, unanswered included');
        assert.equal(r.within1hPct, 50);
        const buckets = Object.fromEntries(r.buckets.map((b) => [b.key, b.count]));
        assert.deepEqual(buckets, { lt1m: 1, '1to5m': 0, '5to15m': 1, '15to60m': 0, '1to4h': 1, '4to24h': 0, gt24h: 0 });

        const wide = overview(90).responseTimes;
        assert.equal(wide.conversations, 5, 'E only falls inside 90 days');
        assert.equal(wide.unanswered, 2);
    });

    it('keeps tenants and numbers apart', () => {
        const b = overview(30, tenantB, CHANNEL);
        assert.equal(b.totals.total, 6);
        assert.deepEqual(b.campaigns.map((c) => [c.campaignId, c.name, c.total]), [['camp-2', 'Secret B campaign', 5]]);
        assert.deepEqual(b.autoReplies.topRules, [{ rule: 'secret', count: 1 }]);
        assert.equal(b.responseTimes.answered, 1);
        assert.equal(b.responseTimes.medianSeconds, 120);

        const other = overview(30, 1, OTHER_CHANNEL);
        assert.equal(other.totals.total, 3);
        assert.equal(other.responseTimes.conversations, 1);
        assert.equal(other.responseTimes.unanswered, 1);

        const empty = overview(30, 1, 99);
        assert.equal(empty.totals.total, 0);
        assert.equal(empty.totals.deliveryRate, null);
        assert.equal(empty.responseTimes.medianSeconds, null);
        assert.equal(empty.responseTimes.within5mPct, null);
        assert.deepEqual(empty.campaigns, []);
    });
});

describe('GET /analytics/overview', () => {
    it('defaults to 30 days', async () => {
        const res = await fetch(`${base}/analytics/overview`);
        assert.equal(res.status, 200);
        const { overview: body } = await res.json();
        assert.equal(body.range.days, 30);
        assert.equal(body.daily.length, 30);
        assert.equal(body.totals.total, 21);
        assert.equal(body.responseTimes.medianSeconds, 600);
    });

    it('accepts 7 and 90 and rejects anything else', async () => {
        assert.equal((await (await fetch(`${base}/analytics/overview?days=7`)).json()).overview.daily.length, 7);
        const wide = await (await fetch(`${base}/analytics/overview?days=90`)).json();
        assert.equal(wide.overview.daily.length, 90);
        for (const bad of ['14', 'all', '']) {
            const res = await fetch(`${base}/analytics/overview?days=${bad}`);
            if (bad === '') { assert.equal(res.status, 200); continue; }
            assert.equal(res.status, 400);
            assert.match((await res.json()).errors[0], /days must be one of 7, 30, 90/);
        }
    });
});

describe('analytics in the full app', () => {
    let app;
    let appServer;
    let appDb;
    after(async () => {
        await closeApp(app);
        appServer?.close();
        appDb?.close();
    });

    it('is mounted under /api for the selected number', async () => {
        appDb = new Database(path.join(tmp, 'app.db'));
        app = createTestApp({ db: appDb, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX } });
        appServer = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => appServer.once('listening', resolve));
        const url = `http://127.0.0.1:${appServer.address().port}/api/analytics/overview?days=7`;
        const res = await fetch(url);
        assert.equal(res.status, 200);
        const { overview: body } = await res.json();
        assert.equal(body.range.days, 7);
        assert.equal(body.totals.total, 0);
        assert.equal((await fetch(url.replace('days=7', 'days=8'))).status, 400);
    });
});
