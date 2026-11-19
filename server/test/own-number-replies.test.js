/**
 * Several numbers: a ticket (and a conversation) belongs to the number the customer wrote to, and its reply must
 * leave from that number whatever number the page has selected (app.js campaignChannel).
 * Its own file: channels.test.js sits at the edge of the write rate limit.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { Channels } from '../src/channels.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-own-number-'));
let app;
let server;
let base;
let db;
let owner;

const call = async (method, url, body, channelId = null) => {
    const res = await fetch(base + url, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}`, ...(channelId ? { 'x-channel-id': String(channelId) } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
    db = new Database(path.join(tmp, 'o.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    owner = sessionFor(app, { tenantId: 1, role: 'owner' });
});

after(async () => {
    await closeApp(app);
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

it("a ticket's reply leaves from the ticket's own number, whatever number the page has selected", async () => {
    // the first request seeds the business's main number; the second is made after it
    const main = (await call('GET', '/api/channels')).body.channels[0];
    const second = new Channels(db.forTenant(1)).create({ displayName: 'Support desk', settings: { transport: TRANSPORT_SANDBOX } });
    assert.notEqual(second.id, main.id);
    await call('POST', '/api/connection/connect');
    await call('POST', '/api/connection/connect', null, second.id);
    const contact = (await call('POST', '/api/contacts', { phone: '+919000000077', name: 'Asha' })).body.contact;
    // the customer wrote to the second number: its ticket is that number's
    const made = await call('POST', '/api/tickets', { subject: 'Late order', contactId: contact.id }, second.id);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.ticket.channelId, second.id);
    // the page is on the main number (no number named), and the reply still goes from the second
    const reply = await call('POST', `/api/tickets/${made.body.ticket.id}/reply`, { text: 'On it' });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const sent = (channelId) => db.forTenant(1).history({ limit: 50, channelId }).filter((r) => r.recipient.endsWith('9000000077')).length;
    assert.equal(sent(second.id), 1, 'from the second number');
    assert.equal(sent(undefined), 1, 'and from no other');
});
