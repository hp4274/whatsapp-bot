/** Platform policy for templates: caps, content rules, spam score, media/buttons, review queue, starter library, Meta status. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_BAILEYS, TRANSPORT_CLOUD_API, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { reviewBlock, spamScore, stricterCap } from '../src/templates/policy.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-policy-tpl-'));
let app;
let server;
let base;
let superToken;
let dataDb;
let n = 0;
const uniq = (p) => `${p}-${(n += 1)}`;

before(async () => {
    const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX };
    delete config.misc;
    dataDb = new Database(path.join(tmp, 'p.db'));
    app = createTestApp({ db: dataDb, config });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    superToken = sessionFor(app, { role: 'super_admin' });
});

after(async () => {
    await closeApp(app);
    server?.close();
    dataDb?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const policy = () => app.locals.policy;
beforeEach(() => {
    const reset = Object.fromEntries(['templates.maxTemplates', 'templates.requireApproval', 'templates.blockedWords',
        'templates.blockedDomains', 'templates.maxSpamScore', 'templates.buttonTypes', 'templates.maxButtons']
        .map((k) => [k, null]));
    policy().set('tenant:1', reset);
    app.locals.tenancy.setLimits(1, { maxTemplates: 0, blockedWords: '' });
});

async function call(method, url, body, token) {
    const res = await fetch(base + url, {
        method,
        headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}
const asAdmin = (method, url, body) => call(method, `/api/admin${url}`, body, superToken);
const create = (draft) => call('POST', '/api/templates', { name: uniq('t'), body: 'Hello', ...draft });

describe('helpers', () => {
    it('stricterCap takes the lower non-zero cap', () => {
        assert.equal(stricterCap(0, 0), 0);
        assert.equal(stricterCap(5, 0), 5);
        assert.equal(stricterCap(0, 3), 3);
        assert.equal(stricterCap(5, 3), 3);
    });

    it('spam score is transparent and bounded', () => {
        assert.equal(spamScore({ body: 'Hi Asha, your order has shipped.' }).score, 0);
        const spam = spamScore({ body: 'URGENT!!! WIN FREE CASH NOW!!! CLICK HERE bit.ly/x 🎉🎉🎉🎉🎉🎉' });
        assert.ok(spam.score >= 70, `score ${spam.score}`);
        assert.ok(spam.score <= 100);
        assert.ok(spam.reasons.some((r) => r.reason === 'shortened link'));
    });

    it('baileys mode gates only Baileys numbers; provider templates are left to Meta', () => {
        const t = { name: 'x', templateType: 'text', reviewStatus: 'pending' };
        const p = { 'templates.requireApproval': 'baileys' };
        assert.match(reviewBlock(t, p, { provider: TRANSPORT_BAILEYS }), /waiting for platform admin approval/);
        assert.equal(reviewBlock(t, p, { provider: TRANSPORT_CLOUD_API }), null);
        assert.ok(reviewBlock(t, { 'templates.requireApproval': 'all' }, { provider: TRANSPORT_CLOUD_API }));
        assert.equal(reviewBlock({ ...t, templateType: 'provider_template' }, { 'templates.requireApproval': 'all' }, {}), null);
        assert.equal(reviewBlock({ ...t, reviewStatus: 'approved' }, p, { provider: TRANSPORT_BAILEYS }), null);
        assert.equal(reviewBlock(t, { 'templates.requireApproval': 'off' }, { provider: TRANSPORT_BAILEYS }), null);
    });
});

describe('save rules', () => {
    it('refuses past the stricter of policy and legacy maxTemplates', async () => {
        const have = (await call('GET', '/api/templates')).body.templates.length;
        policy().set('tenant:1', { 'templates.maxTemplates': have + 2 });
        app.locals.tenancy.setLimits(1, { maxTemplates: have + 1 });
        assert.equal((await create()).status, 201);
        const refused = await create();
        assert.equal(refused.status, 403);
        assert.equal(refused.body.rule, 'maxTemplates');
        assert.match(refused.body.errors[0], new RegExp(`allows ${have + 1} templates`));
        const copy = await call('POST', '/api/templates/library/1/copy', { name: uniq('starter') });
        assert.equal(copy.status, 403, 'copying a starter counts too');
    });

    it('merges policy and legacy blocked words', async () => {
        policy().set('tenant:1', { 'templates.blockedWords': ['casino'] });
        app.locals.tenancy.setLimits(1, { blockedWords: 'loan' });
        const a = await create({ body: 'Visit our casino' });
        assert.equal(a.status, 400);
        assert.equal(a.body.rule, 'blockedWords');
        assert.equal((await create({ body: 'Quick loan today' })).body.rule, 'blockedWords');
    });

    it('blocks a domain and its subdomains in the body and buttons', async () => {
        policy().set('tenant:1', { 'templates.blockedDomains': ['evil.com'] });
        assert.equal((await create({ body: 'See https://www.evil.com/x' })).body.rule, 'blockedDomains');
        const cta = { type: 'cta', cta: [{ kind: 'url', title: 'Open', value: 'https://shop.evil.com' }] };
        assert.equal((await create({ interactive: cta })).body.rule, 'blockedDomains');
        assert.equal((await create({ body: 'See https://notevil.com' })).status, 201, 'only the domain itself and subdomains');
    });

    it('refuses above maxSpamScore and exposes the score', async () => {
        policy().set('tenant:1', { 'templates.maxSpamScore': 40 });
        const spam = await create({ body: 'URGENT!!! WIN FREE CASH NOW!!! CLICK HERE bit.ly/x' });
        assert.equal(spam.status, 400);
        assert.equal(spam.body.rule, 'maxSpamScore');
        const ok = await create({ body: 'Your order has shipped.' });
        assert.equal(ok.status, 201);
        assert.equal(ok.body.template.spam.score, 0);
        const live = await call('POST', '/api/templates/spam-score', { body: 'FREE CASH!!!' });
        assert.equal(live.body.limit, 40);
        assert.ok(live.body.score > 0);
        policy().set('tenant:1', { 'templates.maxSpamScore': 100 });
        assert.equal((await create({ body: 'URGENT!!! WIN FREE CASH NOW!!! CLICK HERE bit.ly/x' })).status, 201, '100 = off');
    });

    it('enforces button types and count', async () => {
        policy().set('tenant:1', { 'templates.buttonTypes': ['quick_reply'] });
        const call2 = { type: 'cta', cta: [{ kind: 'call', title: 'Call us', value: '+15550001' }] };
        assert.equal((await create({ interactive: call2 })).body.rule, 'buttonTypes');
        policy().set('tenant:1', { 'templates.buttonTypes': null, 'templates.maxButtons': 1 });
        const two = { type: 'buttons', buttons: [{ title: 'Yes' }, { title: 'No' }] };
        assert.equal((await create({ interactive: two })).body.rule, 'maxButtons');
    });

    it('enforces media type and size on the header attachment', async () => {
        const form = new FormData();
        form.append('file', new Blob(['%PDF-1.4 ', Buffer.alloc(1.2 * 1024 * 1024)], { type: 'application/pdf' }), 'doc.pdf');
        const upload = await (await fetch(`${base}/api/media/upload`, { method: 'POST', body: form })).json();
        assert.ok(upload.mediaId, JSON.stringify(upload));
        policy().set('tenant:1', { 'templates.mediaTypes': ['image'] });
        const refused = await create({ templateType: 'media', headerMediaId: upload.mediaId });
        assert.equal(refused.body.rule, 'mediaTypes');
        policy().set('tenant:1', { 'templates.mediaTypes': null, 'templates.maxMediaMb': 1 });
        assert.equal((await create({ templateType: 'media', headerMediaId: upload.mediaId })).body.rule, 'maxMediaMb');
        policy().set('tenant:1', { 'templates.maxMediaMb': null });
        assert.equal((await create({ templateType: 'media', headerMediaId: upload.mediaId })).status, 201);
    });
});

describe('review queue', () => {
    it('queues new and reworded templates and blocks sending until approved', async () => {
        policy().set('tenant:1', { 'templates.requireApproval': 'all' });
        const made = await create({ body: 'Hi {name}' });
        assert.equal(made.body.template.reviewStatus, 'pending');
        const id = made.body.template.id;

        const queue = await asAdmin('GET', '/template-review');
        assert.ok(queue.body.templates.some((t) => t.id === id && t.tenantName));

        await call('POST', '/api/connection/connect');
        const campaign = (await call('POST', '/api/campaigns', { name: uniq('c'), templateId: id })).body.campaign;
        const blocked = await call('POST', `/api/campaigns/${campaign.id}/start`);
        assert.equal(blocked.status, 409);
        assert.match(blocked.body.errors[0], /waiting for platform admin approval/);

        assert.equal((await asAdmin('POST', `/template-review/1/${id}/reject`, {})).status, 400, 'reject needs a note');
        const rejected = await asAdmin('POST', `/template-review/1/${id}/reject`, { note: 'too pushy' });
        assert.equal(rejected.body.template.reviewStatus, 'rejected');
        assert.match((await call('POST', `/api/campaigns/${campaign.id}/start`)).body.errors[0], /rejected.*too pushy/);

        const approved = await asAdmin('POST', `/template-review/1/${id}/approve`, { note: '' });
        assert.equal(approved.body.template.reviewStatus, 'approved');
        const after = await call('POST', `/api/campaigns/${campaign.id}/start`);
        assert.doesNotMatch(after.body.errors?.[0] ?? '', /approval|rejected/);

        const audits = app.locals.tenancy.db.prepare("SELECT action FROM audit_logs WHERE action LIKE 'template.%'").all();
        assert.ok(audits.some((a) => a.action === 'template.approve'));

        const renamed = await call('PUT', `/api/templates/${id}`, { name: uniq('renamed') });
        assert.equal(renamed.body.template.reviewStatus, 'approved', 'a rename changes nothing a recipient reads');
        const reworded = await call('PUT', `/api/templates/${id}`, { body: 'Hello {name}' });
        assert.equal(reworded.body.template.reviewStatus, 'pending', 'a reworded template goes back to the queue');
    });

    it('baileys mode does not gate a sandbox number; off ignores review', async () => {
        policy().set('tenant:1', { 'templates.requireApproval': 'baileys' });
        const id = (await create({ body: 'Hi' })).body.template.id;
        const campaign = (await call('POST', '/api/campaigns', { name: uniq('c'), templateId: id })).body.campaign;
        const res = await call('POST', `/api/campaigns/${campaign.id}/start`);
        assert.doesNotMatch(res.body.errors?.[0] ?? '', /approval/);
    });

    it('tenants cannot reach the admin endpoints', async () => {
        assert.equal((await call('GET', '/api/admin/template-review')).status, 403);
    });
});

describe('starter library', () => {
    it('is seeded, admin-managed and copyable by tenants', async () => {
        const seeded = (await call('GET', '/api/templates/library')).body.starters.map((s) => s.name);
        for (const name of ['Fee reminder', 'PTM invitation', 'Order update']) assert.ok(seeded.includes(name), name);

        const made = await asAdmin('POST', '/template-library', { name: 'Welcome', body: 'Welcome {name}!', category: 'marketing' });
        assert.equal(made.status, 201);
        const sid = made.body.starter.id;
        assert.equal((await asAdmin('PUT', `/template-library/${sid}`, { name: 'Welcome', body: 'Welcome aboard {name}!' })).body.starter.body, 'Welcome aboard {name}!');

        const copied = await call('POST', `/api/templates/library/${sid}/copy`, { name: uniq('welcome') });
        assert.equal(copied.status, 201);
        assert.equal(copied.body.template.body, 'Welcome aboard {name}!');
        assert.deepEqual(copied.body.template.variables, ['name']);

        assert.equal((await asAdmin('DELETE', `/template-library/${sid}`)).status, 200);
        assert.equal((await call('POST', `/api/templates/library/${sid}/copy`, {})).status, 404);
        assert.equal((await call('POST', '/api/admin/template-library', { name: 'x', body: 'y' })).status, 403);
    });
});

describe('meta sync status', () => {
    it('counts Cloud API templates per tenant by Meta status', async () => {
        await create({ templateType: 'provider_template', providerTemplateName: 'order_update', approvalStatus: 'approved' });
        await create({ templateType: 'provider_template', providerTemplateName: 'promo', approvalStatus: 'pending' });
        const row = (await asAdmin('GET', '/template-meta')).body.tenants.find((t) => t.tenantId === 1);
        assert.ok(row.approved >= 1 && row.pending >= 1);
        assert.ok(row.lastSynced);
    });
});
