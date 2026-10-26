/**
 * Ops alerts (todo.md section 5): the signed webhook, the two signatures while the secret changes, the
 * per-number and platform limits with the held-back summary, and what raises an alert.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { CampaignManager, DEAD_MAN_MS } from '../src/campaign/manager.js';
import { DEFAULTS, TRANSPORT_BAILEYS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { alertSignature, createOpsAlerts } from '../src/observability/alerts.js';
import { verifySignature } from '../src/publicapi/webhooks.js';
import { queueItem } from '../src/campaign/queue.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-alerts-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const HOUR = 3_600_000;
const quiet = { error() {}, warn() {}, info() {} };

/** An alert channel whose webhook is a stub, on a clock the test moves. */
function harness(opts = {}) {
    const posts = [];
    const audits = [];
    const clock = { t: Date.parse('2026-10-26T10:00:00Z') };
    const alerts = createOpsAlerts({
        url: 'https://ops.example/hook', secret: 'current', previousSecret: '', log: quiet,
        audit: (entry) => audits.push(entry), now: () => clock.t,
        fetch: async (url, init) => {
            posts.push({ url, headers: init.headers, body: init.body, json: JSON.parse(init.body) });
            return { ok: true, status: 200 };
        },
        ...opts,
    });
    return { alerts, posts, audits, clock };
}

describe('ops alerts: signing', () => {
    it('signs the body and timestamp with HMAC-SHA256 in X-Signature', async () => {
        const { alerts, posts, clock } = harness();
        assert.equal(await alerts.raise({ kind: 'logout', tenantId: 1, channelId: 2, number: '919876543210' }), true);
        const [post] = posts;
        assert.equal(post.headers['content-type'], 'application/json');
        assert.equal(post.json.kind, 'logout');
        assert.equal(post.json.number, '…3210', 'only the last 4 digits leave the server');
        const header = post.headers['x-signature'];
        assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
        assert.equal(verifySignature(post.body, header, 'current', { now: () => clock.t }), true);
        assert.equal(verifySignature(post.body, header, 'wrong', { now: () => clock.t }), false);
        assert.equal(verifySignature(`${post.body} `, header, 'current', { now: () => clock.t }), false, 'body is signed');
        assert.equal(verifySignature(post.body, header, 'current', { now: () => clock.t + 10 * 60_000 }), false, 'too old: no replay');
    });

    it('carries v1 (current) and v0 (previous) while the secret is being changed', async () => {
        const { alerts, posts, clock } = harness({ previousSecret: 'old' });
        await alerts.raise({ kind: 'ban', channelId: 1 });
        const header = posts[0].headers['x-signature'];
        assert.match(header, /^t=\d+,v1=[0-9a-f]{64},v0=[0-9a-f]{64}$/);
        assert.equal(verifySignature(posts[0].body, header, 'current', { now: () => clock.t }), true);
        // A receiver still on the old secret checks v0 the same way.
        const v0 = header.replace(/,v1=[0-9a-f]+/, '').replace('v0=', 'v1=');
        assert.equal(verifySignature(posts[0].body, v0, 'old', { now: () => clock.t }), true);
        assert.equal(alertSignature('x', 'a', '', 0), 't=0,v1=' + alertSignature('x', 'a', 'b', 0).split(',')[1].slice(3));
    });

    it('logs and audits without a webhook, and never throws when the webhook fails', async () => {
        const audits = [];
        const errors = [];
        const off = createOpsAlerts({ url: '', audit: (e) => audits.push(e), log: { ...quiet, error: (m) => errors.push(m) } });
        assert.equal(await off.raise({ kind: 'dead_man', channelId: 3 }), false);
        assert.equal(audits[0].action, 'ops.alert');
        assert.equal(errors.length, 1);
        const broken = createOpsAlerts({ url: 'https://x', log: quiet, fetch: async () => { throw new Error('down'); } });
        assert.equal(await broken.raise({ kind: 'ban' }), false);
    });
});

describe('ops alerts: limits', () => {
    it('sends at most 1 per kind per number per hour', async () => {
        const { alerts, posts, audits, clock } = harness();
        await alerts.raise({ kind: 'stuck', tenantId: 1, channelId: 1 });
        await alerts.raise({ kind: 'stuck', tenantId: 1, channelId: 1 });
        await alerts.raise({ kind: 'delivery', tenantId: 1, channelId: 1 }); // another kind
        await alerts.raise({ kind: 'stuck', tenantId: 1, channelId: 2 }); // another number
        assert.equal(posts.length, 3);
        assert.equal(audits.length, 4, 'the audit log records every alert');
        assert.equal(JSON.parse(JSON.stringify(audits[1].detail)).outcome, 'held_back');
        assert.deepEqual(alerts.heldBack(), { stuck: 1 });
        clock.t += HOUR;
        await alerts.raise({ kind: 'stuck', tenantId: 1, channelId: 1 });
        assert.equal(posts.filter((p) => p.json.kind === 'stuck').length, 3, 'an hour later it sends again');
    });

    it('sends at most 30 an hour platform-wide, then one held-back summary by kind', async () => {
        const { alerts, posts, audits, clock } = harness();
        for (let i = 0; i < 33; i += 1) await alerts.raise({ kind: i % 2 ? 'delivery' : 'stuck', tenantId: 1, channelId: i });
        assert.equal(posts.length, 30);
        assert.equal(audits.length, 33);
        assert.equal(await alerts.tick(), false, 'no summary before the hour is up');
        clock.t += HOUR;
        assert.equal(await alerts.tick(), true);
        const summary = posts.at(-1).json;
        assert.equal(summary.kind, 'held_back');
        assert.equal(summary.total, 3);
        assert.deepEqual(summary.byKind, { stuck: 2, delivery: 1 });
        assert.equal(await alerts.tick(), false, 'one summary, then counting starts again');
        assert.deepEqual(alerts.heldBack(), {});
        assert.equal(audits.at(-1).target, 'held_back');
    });
});

describe('ops alerts: what raises one', () => {
    const qr = () => {
        const config = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, rateLimitPerSecond: 1000, humanTiming: false };
        delete config.misc;
        return config;
    };
    let file = 0;
    const freshDb = () => new Database(path.join(tmp, `a${(file += 1)}.db`));

    it('a brake raises one, labelled shadow when it only logged', () => {
        const db = freshDb();
        const manager = new CampaignManager(db, { realDelivery: true, isConnected: () => true }, qr());
        const raised = [];
        manager.opsAlert = (a) => raised.push(a);
        manager.recordBrake('stuck', 'stuck text');
        manager.recordBrake('stuck', 'stuck text'); // already running: no new alert
        assert.equal(raised.length, 1);
        assert.equal(raised[0].kind, 'stuck');
        assert.equal(raised[0].shadow, true);
        assert.match(raised[0].text, /^Shadow/);
        db.close();
    });

    it('the dead-man check: waiting in sending hours with nothing sent for 6h', () => {
        const db = freshDb();
        const manager = new CampaignManager(db, { realDelivery: true, isConnected: () => true }, qr());
        const budgets = { bulk: { left: 50 }, hour: { left: 10 }, newChats: { left: 5 } };
        manager.quota.allowance = () => ({ lastSentAt: null, budgets });
        let open = true;
        manager.bulkWindowOpen = () => open;
        const t0 = Date.now();
        assert.equal(manager.deadManIdleMs(t0), 0, 'nothing waiting');
        manager.queue.put(queueItem({ recipient: '911', message: 'hi' }));
        assert.equal(manager.deadManIdleMs(t0), 0);
        assert.equal(manager.deadManIdleMs(t0 + DEAD_MAN_MS - 1), 0);
        assert.ok(manager.deadManIdleMs(t0 + DEAD_MAN_MS) >= DEAD_MAN_MS);
        // The window closing (night) restarts the wait, so the morning does not alert at once.
        open = false;
        assert.equal(manager.deadManIdleMs(t0 + DEAD_MAN_MS + 1), 0);
        open = true;
        assert.equal(manager.deadManIdleMs(t0 + 2 * DEAD_MAN_MS), 0);
        // A recent send resets it; a paused queue (operator or daily cap) never alerts.
        manager.quota.allowance = () => ({ lastSentAt: new Date(t0 + 3 * DEAD_MAN_MS - HOUR).toISOString(), budgets });
        assert.equal(manager.deadManIdleMs(t0 + 3 * DEAD_MAN_MS), 0);
        manager.queue.pause();
        assert.equal(manager.deadManIdleMs(t0 + 10 * DEAD_MAN_MS), 0);
        db.close();
    });

    it('the dead-man check: one report per stall per hour, and deliberate holds never count', () => {
        const db = freshDb();
        const manager = new CampaignManager(db, { realDelivery: true, isConnected: () => true }, qr());
        const budgets = { bulk: { left: 50 }, hour: { left: 10 }, newChats: { left: 5 } };
        manager.quota.allowance = () => ({ lastSentAt: null, budgets });
        const t0 = Date.now();
        const item = queueItem({ recipient: '911', message: 'hi' });
        item.cold = true;
        manager.queue.put(item);
        manager.deadManIdleMs(t0);
        // The watchdog runs every 30s while stalled: one report, then again after an hour.
        const reports = [0, 1, 2, 3].map((i) => manager.deadManIdleMs(t0 + DEAD_MAN_MS + i * 30_000)).filter(Boolean);
        assert.equal(reports.length, 1);
        assert.ok(manager.deadManIdleMs(t0 + DEAD_MAN_MS + HOUR) > 0);
        // The platform's sending hours closed: bulk is held, not stalled.
        manager.policyWindowOpen = () => false;
        assert.equal(manager.deadManIdleMs(t0 + 3 * DEAD_MAN_MS), 0);
        assert.equal(manager.deadManIdleMs(t0 + 5 * DEAD_MAN_MS), 0);
        manager.policyWindowOpen = null;
        // New chats used up (or closed by a restriction) and only strangers queued: held till tomorrow.
        budgets.newChats.left = 0;
        manager.deadManIdleMs(t0 + 6 * DEAD_MAN_MS);
        assert.equal(manager.deadManIdleMs(t0 + 8 * DEAD_MAN_MS), 0);
        db.close();
    });
});

describe('ops alerts: app wiring', () => {
    it('a number\'s alert reaches the platform webhook and the audit log, tagged with the number', async () => {
        const { createTestApp } = await import('./helpers.js');
        const { closeApp } = await import('../src/app.js');
        const db = new Database(path.join(tmp, 'app.db'));
        const posts = [];
        const app = createTestApp({
            db, dataDir: tmp,
            config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 },
            opsAlertOptions: {
                url: 'https://ops.example/hook', secret: 's', log: quiet,
                fetch: async (url, init) => { posts.push(JSON.parse(init.body)); return { ok: true, status: 200 }; },
            },
        });
        const runtime = app.locals.runtimeFor(1);
        const { state } = runtime.runtimeFor(runtime.channels.getDefault());
        state.manager.opsAlert({ kind: 'dead_man', text: 'stalled' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(posts.length, 1);
        assert.equal(posts[0].kind, 'dead_man');
        assert.equal(posts[0].tenantId, 1);
        assert.equal(posts[0].channelId, state.channel.id);
        const audit = app.locals.tenancy.listAudit({ tenantId: 1 }).find((r) => r.action === 'ops.alert');
        assert.equal(audit.target, `dead_man:channel-${state.channel.id}`);
        assert.equal(typeof app.locals.opsAlert, 'function', 'section 4 hooks raise backup / re-encryption alerts here');
        await closeApp(app);
        db.close();
    });
});
