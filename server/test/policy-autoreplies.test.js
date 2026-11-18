/** Platform policy for auto replies: plan limits, global opt-out words, loop protection, quiet hours. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { AutoReplyEngine } from '../src/autoreply/engine.js';
import { processOptOut } from '../src/autoreply/optout.js';
import { effectiveSettings, ruleRefusal } from '../src/autoreply/policy.js';
import { tenantSentSince } from '../src/policy/campaignOps.js';
import { AutoReplyStore, DEFAULT_SETTINGS } from '../src/autoreply/store.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

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

describe('feature switches and business settings', () => {
    it('a switched-off feature stops its rules; system replies follow the plan', async () => {
        const t = setup({ 'autoReplies.allowIntents': false, 'autoReplies.allowQuestions': false, 'autoReplies.allowFallback': false });
        t.store.save({ matchType: 'INTENT', keywords: ['price'], replyBody: 'Rs 99' });
        t.store.save({ matchType: 'ANY_OF', keywords: ['book'], replyBody: 'Sure', collect: { questions: [{ key: 'name', question: 'Name?', type: 'name' }] } });
        t.store.save({ matchType: 'ANY_OF', keywords: ['price'], synonyms: true, replyBody: 'plain' });
        t.store.saveSettings({ fallback: { enabled: true, text: 'Sorry?', throttleHours: 0 } });
        assert.equal((await t.inbound('how much')).length, 0, 'no intent, no synonyms, no fallback');
        assert.equal((await t.inbound('book')).length, 0, 'questions off');
        assert.deepEqual((await t.inbound('price')).map((j) => j.text), ['plain']);
    });

    it('translations off: the main reply, whatever the language', async () => {
        const t = setup({ 'autoReplies.allowTranslations': false });
        t.store.save({ matchType: 'ANY_OF', keywords: ['price'], replyBody: 'English', translations: { hinglish: 'Hinglish' } });
        assert.deepEqual((await t.inbound('price kya hai')).map((j) => j.text), ['English']);
    });

    it('the business switch silences everything; its cap is the lower of the two', async () => {
        const t = setup({ 'autoReplies.maxPerContactHour': 5 });
        t.store.save({ matchType: 'CONTAINS', keywords: ['hi'], replyBody: 'hello' });
        t.store.saveSettings({ enabled: false });
        assert.equal((await t.inbound('hi')).length, 0);
        t.store.saveSettings({ enabled: true, maxPerContactHour: 1 });
        assert.equal((await t.inbound('hi')).length, 1);
        assert.equal((await t.inbound('hi')).length, 0, 'the business cap of 1');
    });

    it('caps the pause, the handover and the delay at the plan', () => {
        const s = effectiveSettings({ ...DEFAULT_SETTINGS, delaySec: 50, handoff: { ...DEFAULT_SETTINGS.handoff, pauseHours: 500 },
            fallback: { ...DEFAULT_SETTINGS.fallback, handoffAfter: 9 } },
        { 'autoReplies.maxPauseHours': 24, 'autoReplies.maxHandoffAfter': 3, 'autoReplies.maxDelaySec': 5, 'autoReplies.allowAway': false });
        assert.equal(s.handoff.pauseHours, 24);
        assert.equal(s.fallback.handoffAfter, 3);
        assert.equal(s.delaySec, 5);
        assert.equal(s.away.enabled, false);
    });

    it('refuses rules past the feature switches and limits', () => {
        assert.match(ruleRefusal({ matchType: 'MESSAGE_TYPE', keywords: ['image'] }, { 'autoReplies.allowMessageTypes': false }), /Message-type/);
        assert.match(ruleRefusal({ matchType: 'ANY_OF', variants: ['a', 'b', 'c'] }, { 'autoReplies.maxVariants': 2 }), /2 reply variants/);
        assert.match(ruleRefusal({ matchType: 'ANY_OF', collect: { questions: [{}, {}] } }, { 'autoReplies.maxQuestions': 1 }), /1 questions/);
        assert.match(ruleRefusal({ matchType: 'ANY_OF', translations: { hi: 'x' } }, { 'autoReplies.allowTranslations': false }), /other languages/);
        assert.equal(ruleRefusal({ matchType: 'ANY_OF', translations: { hi: 'x' } }, {}), null);
    });
});

describe('auto replies and the message quota', () => {
    it('do not count toward the cap or quota unless the platform says so', () => {
        const { db } = setup();
        const add = (id, type) => db.db.prepare(`INSERT INTO messages (tenant_id, message_id, message_type, recipient, message, status, created_at, updated_at, sent_at)
            VALUES (1, ?, ?, '919800000001', 'x', 'SENT', ?, ?, ?)`).run(id, type, MON_10AM.toISOString(), MON_10AM.toISOString(), MON_10AM.toISOString());
        add('a1', 'auto_reply');
        add('c1', 'campaign');
        const since = '2026-10-01T00:00:00Z';
        assert.equal(tenantSentSince(db.db, 1, since), 1, 'the campaign only');
        db.db.prepare(`INSERT INTO platform_policy (scope, key, value, updated_at) VALUES ('global', 'autoReplies.countTowardQuota', 'true', ?)`)
            .run(MON_10AM.toISOString());
        assert.equal(tenantSentSince(db.db, 1, since), 2, 'switched on: both');
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

    it('will not switch on a system reply the plan leaves out', async () => {
        app.locals.policy.set('global', { 'autoReplies.allowWelcome': false });
        const r = await call('PUT', '/api/auto-replies/settings', { welcome: { enabled: true } });
        assert.equal(r.status, 403);
        assert.match(r.body.errors[0], /welcome/);
        app.locals.policy.set('global', {});
    });

    it('shows a super admin each business\'s auto-reply usage, and nobody else', async () => {
        const admin = sessionFor(app, { role: 'super_admin' });
        const res = await fetch(`${base}/api/admin/auto-replies/usage`, { headers: { authorization: `Bearer ${admin}` } });
        assert.equal(res.status, 200);
        const { usage } = await res.json();
        assert.equal(typeof usage[1].rules, 'number');
        assert.equal(typeof usage[1].replies, 'number');
        const owner = await call('GET', '/api/admin/auto-replies/usage');
        assert.ok(owner.status === 401 || owner.status === 403);
    });
});
