/**
 * Link click tracking.
 *
 * Claims under test: URLs are rewritten only when the campaign asks
 * (`trackLinks`) AND the server has a public base URL; the stored row keeps the
 * rewritten text; `GET /l/:code` redirects to the stored URL only and counts
 * the tap; an unknown code is a plain 404; analytics, CSV and the
 * `clickedLink` retarget read the taps of their own tenant only.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { CampaignManager } from '../src/campaign/manager.js';
import { CampaignStore, campaignKey } from '../src/campaigns/store.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { LinkStore, followLink, rewriteLinks } from '../src/links/store.js';
import { Status } from '../src/protocol.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-links-'));
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

describe('rewriteLinks', () => {
    let n = 0;
    const makeCode = () => `code${String(++n).padStart(4, '0')}`;

    it('leaves text alone without a base URL', () => {
        const text = 'See https://shop.example/sale today';
        assert.deepEqual(rewriteLinks(text, { baseUrl: '' }), { text, links: [] });
    });

    it('swaps each URL for a short link, keeping sentence punctuation and sharing a code per URL', () => {
        const { text, links } = rewriteLinks(
            'Sale: https://shop.example/a?x=1. Again https://shop.example/a?x=1, and (http://b.example/wiki_(x)) ok',
            { baseUrl: 'https://go.example/', makeCode });
        assert.equal(links.length, 2);
        assert.equal(links[0].url, 'https://shop.example/a?x=1');
        assert.equal(links[1].url, 'http://b.example/wiki_(x)');
        assert.equal(text, `Sale: https://go.example/l/${links[0].code}. Again https://go.example/l/${links[0].code},`
            + ` and (https://go.example/l/${links[1].code}) ok`);
    });

    it('does not wrap a link that is already ours', () => {
        const text = 'Tap https://go.example/l/abcdefgh';
        assert.equal(rewriteLinks(text, { baseUrl: 'https://go.example', makeCode }).text, text);
    });
});

function fakeTransport(sent) {
    return {
        name: 'fake', realDelivery: true, supportsReceipts: false,
        isConnected: () => true,
        sendMessage: async (to, text) => {
            sent.push({ to, text });
            return { providerId: `p${sent.length}`, status: Status.SENT };
        },
        getStatus: () => null,
        async disconnect() {},
    };
}

const engineConfig = { ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed', retryDelay: 0.01, transport: TRANSPORT_SANDBOX };

describe('the engine', () => {
    let db;
    before(() => { db = new Database(path.join(tmp, 'engine.db')); });
    after(() => db?.close());

    const run = async ({ trackLinks, links, phone }) => {
        const sent = [];
        const manager = new CampaignManager(db.forTenant(1).forChannel(1), fakeTransport(sent), engineConfig);
        manager.links = links;
        manager.enqueueContacts([{ name: 'Ann', phone }], 'Hi {name}, shop at https://shop.example/sale!', {
            campaignId: `camp-links-${phone}`, trackLinks,
        });
        manager.start();
        assert.ok(await waitFor(() => sent.length === 1));
        await manager.shutdown();
        return sent[0].text;
    };

    it('rewrites only when the campaign opts in and a base URL is configured', async () => {
        const links = new LinkStore(db.forTenant(1), 'https://go.example');
        assert.equal(await run({ trackLinks: false, links, phone: '919800000101' }), 'Hi Ann, shop at https://shop.example/sale!');
        assert.equal(await run({ trackLinks: true, links: null, phone: '919800000102' }), 'Hi Ann, shop at https://shop.example/sale!');

        const text = await run({ trackLinks: true, links, phone: '919800000103' });
        const code = text.match(/https:\/\/go\.example\/l\/([\w-]+)!$/)?.[1];
        assert.ok(code, text);
        // The stored row is the rewritten text, so a retry or a restart resends the same codes.
        const row = db.db.prepare("SELECT * FROM messages WHERE campaign_id = 'camp-links-919800000103'").get();
        assert.equal(row.message, text);
        const link = db.db.prepare('SELECT * FROM link_codes WHERE code = ?').get(code);
        assert.equal(link.url, 'https://shop.example/sale');
        assert.equal(link.message_id, row.message_id);
        assert.equal(link.recipient, '919800000103');
        assert.equal(link.tenant_id, 1);
    });

    it('follows only stored codes, counting each tap', () => {
        assert.equal(followLink(db.db, 'not a code'), null);
        assert.equal(followLink(db.db, 'abcdefghijkl'), null);
        new LinkStore(db.forTenant(1), 'https://go.example').save([{ code: 'zzzzzzzzzzzz', url: 'https://x.example/' }]);
        assert.equal(followLink(db.db, 'zzzzzzzzzzzz'), 'https://x.example/');
        assert.equal(followLink(db.db, 'zzzzzzzzzzzz', { count: false }), 'https://x.example/');
        assert.equal(db.db.prepare("SELECT clicks FROM link_codes WHERE code = 'zzzzzzzzzzzz'").get().clicks, 1);
    });
});

describe('tracked links over HTTP', () => {
    let app;
    let server;
    let base;
    let db;

    before(async () => {
        db = new Database(path.join(tmp, 'http.db'));
        const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, retryDelay: 0.01, maxRetries: 1 };
        delete config.misc;
        app = createTestApp({ db, config, publicBaseUrl: 'https://go.example/' });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        await closeApp(app);
        server?.close();
        db?.close();
    });

    const api = async (method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* csv */ }
        return { status: res.status, body: parsed };
    };

    it('says link tracking is available, sends short links, redirects and counts taps', async () => {
        assert.equal((await api('GET', '/api/policy')).body.linkTracking, true);
        assert.equal((await api('POST', '/api/connection/connect')).status, 200);
        const created = await api('POST', '/api/campaigns', {
            name: 'Links',
            body: 'Hi {name}, the sale: https://shop.example/sale',
            audience: [{ name: 'Sam', phone: '919855500101' }, { name: 'Tia', phone: '919855500102' }],
            options: { trackLinks: true, pacing: 'fast' },
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.campaign.options.trackLinks, true);
        const { id } = created.body.campaign;
        assert.equal((await api('POST', `/api/campaigns/${id}/start`)).status, 200);
        assert.ok(await waitFor(() => db.history({ campaignId: campaignKey(id) })
            .filter((r) => r.status === Status.SANDBOX).length === 2));

        const sam = db.history({ campaignId: campaignKey(id) }).find((r) => r.recipient === '919855500101');
        const code = sam.message.match(/https:\/\/go\.example\/l\/([\w-]+)$/)?.[1];
        assert.ok(code, sam.message);

        const tap = await fetch(`${base}/l/${code}`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0' } });
        assert.equal(tap.status, 302);
        assert.equal(tap.headers.get('location'), 'https://shop.example/sale');
        // WhatsApp fetching a link preview is not a tap.
        const preview = await fetch(`${base}/l/${code}`, { redirect: 'manual', headers: { 'user-agent': 'WhatsApp/2.23.20 A' } });
        assert.equal(preview.status, 302);
        assert.equal(db.db.prepare('SELECT clicks FROM link_codes WHERE code = ?').get(code).clicks, 1);

        const missing = await fetch(`${base}/l/unknowncode1`, { redirect: 'manual' });
        assert.equal(missing.status, 404);
        assert.match(missing.headers.get('content-type'), /text\/plain/);
        assert.equal((await fetch(`${base}/l/..%2Fapi`, { redirect: 'manual' })).status, 404);

        const report = await api('GET', `/api/campaigns/${id}/analytics`);
        assert.equal(report.body.funnel.clickedLink, 1);
        assert.equal(report.body.recipients.find((r) => r.phone === '919855500101').clickedLink, true);
        assert.equal(report.body.recipients.find((r) => r.phone === '919855500102').clickedLink, false);
        const csv = (await api('GET', `/api/campaigns/${id}/export.csv`)).body.split('\r\n');
        assert.match(csv[0], /,link_clicked,variant$/);
        assert.ok(csv.some((line) => line.includes('919855500101') && line.includes(',yes,')));

        // Retarget the people who tapped.
        const follow = await api('POST', '/api/campaigns', {
            name: 'Tapped', body: 'Thanks {name}', audience: { retarget: { campaignId: id, filter: 'clickedLink' } },
        });
        assert.equal(follow.status, 201);
        const preview2 = await api('POST', `/api/campaigns/${follow.body.campaign.id}/preview`, {});
        assert.equal(preview2.body.audience, 1);
        assert.equal(preview2.body.previews[0].phone, '919855500101');
    });

    it("never counts another tenant's taps", async () => {
        const { id } = (await api('POST', '/api/campaigns', { name: 'Mine', body: 'hi https://a.example' })).body.campaign;
        // Another tenant's link under the same campaign key: its taps are not ours.
        db.db.prepare(`INSERT INTO link_codes (code, tenant_id, campaign_id, message_id, recipient, url, clicks, created_at)
                       VALUES ('othertenant1', 2, ?, 'm', '919855500101', 'https://evil.example', 5, '2026-01-01')`)
            .run(campaignKey(id));
        const store = new CampaignStore(db.forTenant(1).forChannel(1), { contacts: new ContactStore(db.forTenant(1), '91') });
        assert.equal(store.analytics(id).funnel.clickedLink, 0);
        // The code still only redirects; the response carries nothing about whose it is.
        const tap = await fetch(`${base}/l/othertenant1`, { redirect: 'manual' });
        assert.equal(tap.status, 302);
        assert.doesNotMatch(await tap.text(), /tenant|919855|camp-/);
    });
});

describe('without a public base URL', () => {
    it('reports link tracking as unavailable', async () => {
        const db = new Database(path.join(tmp, 'nobase.db'));
        const app = createTestApp({ db });
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        try {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/api/policy`);
            assert.equal((await res.json()).linkTracking, false);
        } finally {
            await closeApp(app);
            server.close();
            db.close();
        }
    });
});
