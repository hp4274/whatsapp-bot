/** Platform policy for auto replies: plan limits, global opt-out words, loop protection, quiet hours. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { AutoReplyEngine } from '../src/autoreply/engine.js';
import { processOptOut } from '../src/autoreply/optout.js';
import { AutoReplyStore } from '../src/autoreply/store.js';
import { Database } from '../src/db.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-policy-ar-'));
let seq = 0;
const MON_10AM = new Date('2026-10-12T10:00:00Z');

function setup(policy = {}, timezone = 'UTC') {
    const db = new Database(path.join(tmp, `p${++seq}.db`));
    db.db.exec('DELETE FROM auto_replies');
    const jobs = [];
    const service = { send: (job) => { jobs.push(job); return { accepted: true, messageId: `m${jobs.length}`, reason: null }; } };
    const engine = new AutoReplyEngine(db, { isConnected: () => true }, { delayRangeMs: [0, 0], service });
    engine.attach({ channel: () => ({ id: 0, timezone }), platformPolicy: () => policy });
    const store = new AutoReplyStore(db);
    let n = 0;
    const inbound = async (body, { now = MON_10AM, sender = '919800000001' } = {}) => {
        const saved = db.insertInbound({ messageId: `in.${seq}.${++n}`, sender, senderName: 'A', body, receivedAt: now.toISOString() });
        const before = jobs.length;
        await engine.handleInbound(saved, { now });
        return jobs.slice(before);
    };
    return { db, store, inbound, jobs, engine };
}

const menu = { type: 'buttons', buttons: [{ id: 'a', title: 'A' }] };
const menuRule = { matchType: 'EXACT', keywords: ['menu'], replyBody: 'pick', interactive: menu, menu: { a: { replyBody: 'chose a' } } };

describe('kinds skipped at match time', () => {
    it('keyword rules stop firing when allowKeywords is off; menus when allowMenus is off', async () => {
        const kw = setup({ 'autoReplies.allowKeywords': false });
        kw.store.save({ matchType: 'EXACT', keywords: ['hi'], replyBody: 'hello' });
        assert.equal((await kw.inbound('hi')).length, 0);
        const mn = setup({ 'autoReplies.allowMenus': false });
        mn.store.save(menuRule);
        assert.equal((await mn.inbound('menu')).length, 0);
        const ok = setup({});
        ok.store.save(menuRule);
        assert.equal((await ok.inbound('menu')).length, 1);
    });
});

describe('loop protection', () => {
    it('stops after maxPerContactHour per contact and resumes an hour later', async () => {
        const t = setup({ 'autoReplies.maxPerContactHour': 2 });
        t.store.save({ matchType: 'CONTAINS', keywords: ['hi'], replyBody: 'hello' });
        assert.equal((await t.inbound('hi')).length, 1);
        assert.equal((await t.inbound('hi')).length, 1);
        assert.equal((await t.inbound('hi')).length, 0);
        assert.equal((await t.inbound('hi', { sender: '919800000002' })).length, 1);
        assert.equal((await t.inbound('hi', { now: new Date(MON_10AM.getTime() + 61 * 60_000) })).length, 1);
    });
    it('0 means no limit', async () => {
        const t = setup({ 'autoReplies.maxPerContactHour': 0 });
        t.store.save({ matchType: 'CONTAINS', keywords: ['hi'], replyBody: 'hello' });
        for (let i = 0; i < 8; i += 1) assert.equal((await t.inbound('hi')).length, 1);
    });
});

describe('quiet hours', () => {
    const quiet = { 'autoReplies.quietHoursEnabled': true, 'autoReplies.quietStart': '22:00', 'autoReplies.quietEnd': '07:00' };
    it('is silent across midnight in the channel time zone', async () => {
        const t = setup(quiet, 'Asia/Kolkata');
        t.store.save({ matchType: 'CONTAINS', keywords: ['hi'], replyBody: 'hello' });
        // 10:00 UTC = 15:30 IST open; 18:00 UTC = 23:30 IST quiet; 23:00 UTC = 04:30 IST quiet.
        assert.equal((await t.inbound('hi')).length, 1);
        assert.equal((await t.inbound('hi', { now: new Date('2026-10-12T18:00:00Z') })).length, 0);
        assert.equal((await t.inbound('hi', { now: new Date('2026-10-12T23:00:00Z') })).length, 0);
    });
    it('opt-out still works during quiet hours', async () => {
        const t = setup(quiet);
        const out = await processOptOut(t.db, null, { sender: '919800000003', body: 'STOP' }, []);
        assert.equal(out.action, 'opted_out');
    });
});

describe('platform opt-out words', () => {
    it('opt the contact out even though the tenant never defined them', async () => {
        const t = setup();
        const out = await processOptOut(t.db, null, { sender: '919800000004', body: 'abmelden!' }, ['STOP', 'Abmelden']);
        assert.equal(out.action, 'opted_out');
        assert.ok(t.db.isOptedOut('919800000004'));
        assert.equal((await processOptOut(t.db, null, { sender: '919800000005', body: 'abmelden' })).handled, false);
    });
});

describe('policy HTTP', () => {
    let app;
    let server;
    let base;
    before(async () => {
        app = createTestApp();
        server = app.listen(0);
        await new Promise((r) => server.once('listening', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(async () => {
        server.close();
        await closeApp(app);
    });
    const call = async (method, url, body) => {
        const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
    };

    it('refuses rules past the cap and disallowed kinds, lists platform opt-out words', async () => {
        const existing = (await call('GET', '/api/auto-replies')).body.rules.length;
        app.locals.policy.set('global', { 'autoReplies.maxRules': existing + 1, 'autoReplies.allowMenus': false, 'autoReplies.optOutWords': ['STOP', 'Basta'] });
        const m = await call('POST', '/api/auto-replies', menuRule);
        assert.equal(m.status, 403);
        assert.match(m.body.errors[0], /Menus/);
        const ok = await call('POST', '/api/auto-replies', { matchType: 'EXACT', keywords: ['zzz'], replyBody: 'ok' });
        assert.equal(ok.status, 201);
        const over = await call('POST', '/api/auto-replies', { matchType: 'EXACT', keywords: ['yyy'], replyBody: 'ok' });
        assert.equal(over.status, 403);
        assert.match(over.body.errors[0], /allows \d+ auto-reply/);
        const list = (await call('GET', '/api/auto-replies')).body;
        assert.deepEqual(list.platformOptOutWords, ['STOP', 'Basta']);
        app.locals.policy.set('global', { 'autoReplies.allowKeywords': false, 'autoReplies.maxRules': null });
        const kw = await call('POST', '/api/auto-replies', { matchType: 'EXACT', keywords: ['xxx'], replyBody: 'ok' });
        assert.match(kw.body.errors[0], /Keyword/);
    });
});
