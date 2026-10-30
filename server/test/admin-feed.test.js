/**
 * The super admin's live stream (GET /api/admin/events): admin screens hear about tenant changes and new audit rows
 * at once instead of polling, and nobody but a super admin can open it.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { adminTopics, createAdminFeed } from '../src/observability/adminFeed.js';
import { createTestApp, sessionFor } from './helpers.js';

/** Read SSE `data:` payloads from a stream until `done(events)` says stop, or the time runs out. */
async function collect(url, token, done, timeoutMs = 4000) {
    const controller = new AbortController();
    // The stream takes ?token= like EventSource; the header is set too so the test helper does not add the owner's.
    const res = await fetch(`${url}?token=${token}`, { signal: controller.signal, headers: { authorization: `Bearer ${token}` } });
    const events = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        while (!done(events)) {
            const { value, done: ended } = await reader.read();
            if (ended) break;
            buffer += decoder.decode(value, { stream: true });
            let cut;
            while ((cut = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, cut);
                buffer = buffer.slice(cut + 2);
                const data = block.split('\n').find((line) => line.startsWith('data: '));
                if (data && !block.startsWith('event: hello')) events.push(JSON.parse(data.slice(6)));
            }
        }
    } catch {
        // aborted on timeout: return what arrived
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
    return events;
}

describe('admin feed', () => {
    it('maps runtime events to admin topics and ignores the rest', () => {
        assert.deepEqual(adminTopics({ type: 'connection' }), ['channels']);
        assert.deepEqual(adminTopics({ type: 'campaignUpdated' }), ['campaigns']);
        assert.deepEqual(adminTopics({ type: 'changed', topic: 'campaigns' }), ['campaigns']);
        assert.deepEqual(adminTopics({ type: 'status' }), ['campaigns', 'usage']);
        assert.equal(adminTopics({ type: 'pacing' }), null);
    });

    it('publishes nothing while nobody listens, and coalesces a burst into one event per topic', async () => {
        const feed = createAdminFeed({ coalesceMs: 20 });
        feed.publish('campaigns', 1); // no client: dropped, no timer left behind
        const written = [];
        const res = { writableEnded: false, destroyed: false, writableLength: 0, write: (line) => written.push(line), writeHead() {}, end() {}, on() {} };
        const req = { socket: { setTimeout() {}, setKeepAlive() {} }, on() {} };
        feed.stream(req, res);
        for (let i = 0; i < 50; i++) feed.publish('campaigns', i % 2 ? 1 : 2);
        await new Promise((r) => setTimeout(r, 60));
        const data = written.filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
        assert.equal(data.length, 1);
        assert.equal(data[0].topic, 'campaigns');
        assert.deepEqual(data[0].tenantIds.sort(), [1, 2]);
    });

    describe('over HTTP', () => {
        let app;
        let server;
        let base;
        let adminToken;
        before(async () => {
            app = createTestApp();
            server = app.listen(0, '127.0.0.1');
            await new Promise((r) => server.once('listening', r));
            base = `http://127.0.0.1:${server.address().port}`;
            adminToken = sessionFor(app, { role: 'super_admin' });
        });
        after(async () => {
            await closeApp(app);
            server?.closeAllConnections?.();
            server?.close();
        });

        it('refuses a tenant user and an anonymous caller', async () => {
            const anonymous = await fetch(`${base}/api/admin/events?token=nope`, { headers: { authorization: 'Bearer nope' } });
            assert.equal(anonymous.status, 401);
            const owner = await fetch(`${base}/api/admin/events`);
            assert.equal(owner.status, 403);
        });

        it('a tenant write and its audit row reach the open admin stream', async () => {
            const listening = collect(`${base}/api/admin/events`, adminToken,
                (events) => events.some((e) => e.topic === 'audit'));
            await new Promise((r) => setTimeout(r, 150));
            const created = await fetch(`${base}/api/contacts`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'Feed', phone: '919812345678' }),
            });
            assert.ok(created.status < 400, `contact create answered ${created.status}`);
            const events = await listening;
            assert.ok(events.some((e) => e.topic === 'audit' && e.tenantIds.includes(1)), JSON.stringify(events));
            assert.ok(events.some((e) => e.topic === 'tenants'), 'the tenant runtime change is forwarded too');
        });
    });
});
