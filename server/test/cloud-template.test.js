/** Meta approved-template sends: payload, variable resolution, campaign plumbing, errors. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

import { CampaignManager } from '../src/campaign/manager.js';
import { CampaignStore } from '../src/campaigns/store.js';
import { ContactStore } from '../src/contactStore.js';
import { DEFAULTS, TRANSPORT_CLOUD_API, TRANSPORT_BAILEYS } from '../src/config.js';
import { Database } from '../src/db.js';
import { ErrorCode, friendlyError, normalizeError } from '../src/messaging/errors.js';
import { metaTemplateFor, prepareTemplateSend, resolveTemplate } from '../src/messaging/templateSend.js';
import { TemplateStore } from '../src/templates/store.js';
import { TransportSendError } from '../src/transports/base.js';
import { CloudApiTransport, templatePayload } from '../src/transports/cloudApi.js';

const STORED = {
    providerTemplateName: 'order_update',
    language: 'en',
    body: 'Hi {{1}}, your order {{2}} ships today.',
    paramMapping: {
        body: [{ var: 'name', fallback: 'there' }, { var: 'order_id' }],
        header: { type: 'text', var: 'city', fallback: 'Store' },
        buttons: [{ index: 0, subType: 'url', var: 'order_id' }],
    },
};

/** A Cloud API transport whose Graph calls land in `calls`. */
function cloud(respond = () => null, config = {}) {
    const calls = [];
    const transport = new CloudApiTransport(
        { ...DEFAULTS, phoneNumberId: '1', accessToken: 't', requestTimeout: 5, ...config },
        { fetchImpl: async (url, init) => {
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
            calls.push({ url: String(url), body });
            if (String(url).endsWith('/media')) return new Response(JSON.stringify({ id: `up${calls.length}` }), { status: 200 });
            const custom = respond(body, calls.length);
            if (custom) return custom;
            return new Response(JSON.stringify({ messages: [{ id: `wamid.${calls.length}` }] }), { status: 200 });
        } });
    transport.connected = true;
    return { transport, calls };
}

it('resolves body/header/button parameters with fallbacks, in slot order', () => {
    const r = resolveTemplate(STORED, { name: '', city: 'Pune', order_id: 'A-7' });
    assert.equal(r.name, 'order_update');
    assert.equal(r.language, 'en');
    assert.deepEqual(r.components, [
        { type: 'header', parameters: [{ type: 'text', text: 'Pune' }] },
        { type: 'body', parameters: [{ type: 'text', text: 'there' }, { type: 'text', text: 'A-7' }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'A-7' }] },
    ]);
    assert.deepEqual(r.missing, []);

    const prepared = prepareTemplateSend(STORED, { name: 'Asha', order_id: 'B-1' });
    assert.equal(prepared.text, 'Hi Asha, your order B-1 ships today.');
    assert.equal(prepared.template.components[0].parameters[0].text, 'Store', 'header fallback');

    // No value and no fallback -> reported, because Meta rejects empty params.
    assert.deepEqual(resolveTemplate(STORED, { name: 'X' }).missing, ['{{2}}', 'button 0']);
    // A campaign-level mapping overrides the stored one; the language defaults.
    const override = resolveTemplate({ ...STORED, language: '' }, {}, { body: [{ fallback: 'a' }, { fallback: 'b' }] });
    assert.deepEqual(override.bodyParams, ['a', 'b']);
    assert.equal(override.language, 'en_US');
    assert.throws(() => resolveTemplate({ body: 'x' }, {}), /Meta template name/);
});

it('builds the Graph API template payload, media header replacing the mapped one', () => {
    const { template } = prepareTemplateSend(STORED, { name: 'A', order_id: '9' });
    const plain = templatePayload('919800000001', template);
    assert.equal(plain.type, 'template');
    assert.deepEqual(plain.template.language, { code: 'en' });
    assert.equal(plain.template.name, 'order_update');
    assert.equal(plain.template.components.length, 3);

    const withImage = templatePayload('919800000001', template, { id: 'img.1', mimetype: 'image/png', filename: 'a.png' });
    const headers = withImage.template.components.filter((c) => c.type === 'header');
    assert.deepEqual(headers, [{ type: 'header', parameters: [{ type: 'image', image: { id: 'img.1' } }] }]);

    const linked = resolveTemplate({ providerTemplateName: 'promo', body: '' },
        {}, { header: { type: 'image', link: 'https://x.test/a.jpg' } });
    assert.deepEqual(linked.components, [{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://x.test/a.jpg' } }] }]);
    // No parameters at all -> no components key (Meta accepts that for static templates).
    assert.equal(templatePayload('1', { name: 'hello_world', language: 'en_US', components: [] }).template.components, undefined);
});

it('transport sends a template and uploads a campaign attachment only once', async () => {
    const { transport, calls } = cloud();
    const media = { mediaId: 'med_1', filename: 'a.png', mimetype: 'image/png', buffer: Buffer.from('abc') };
    const { template } = prepareTemplateSend(STORED, { name: 'A', order_id: '1' });
    await transport.sendMessage('919800000001', 'ignored text', { template, media });
    await transport.sendMessage('919800000002', 'ignored text', { template, media });
    assert.equal(calls.filter((c) => c.url.endsWith('/media')).length, 1);
    const sends = calls.filter((c) => c.url.endsWith('/messages'));
    assert.equal(sends.length, 2);
    assert.ok(sends.every((c) => c.body.type === 'template'
        && c.body.template.components[0].parameters[0].image.id === 'up1'));
});

it('keeps the legacy config.useTemplate path working', async () => {
    const { transport, calls } = cloud(undefined, { useTemplate: true, templateName: 'hello_world', templateLanguage: 'en_US' });
    await transport.sendMessage('919800000001', 'hello');
    assert.equal(calls[0].body.type, 'template');
    assert.equal(calls[0].body.template.name, 'hello_world');
    assert.deepEqual(calls[0].body.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'hello' }] }]);
});

/** Run a manager over `contacts` until `count` Graph POSTs to /messages happened. */
async function runCampaign(transport, calls, contacts, options, count) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-tpl-'));
    const db = new Database(path.join(tmp, 't.db'));
    const manager = new CampaignManager(db, transport,
        { ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed', retryDelay: 0.01, maxRetries: 1 });
    try {
        const result = manager.enqueueContacts(contacts, options.text ?? '', options);
        manager.start();
        const deadline = Date.now() + 5000;
        const done = () => manager.stats.processed >= result.queued;
        while (Date.now() < deadline && (!done() || calls.filter((c) => c.url.endsWith('/messages')).length < count)) {
            await new Promise((r) => setTimeout(r, 20));
        }
        return { result };
    } finally {
        await manager.shutdown();
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

it('a campaign queue item carries the resolved template to the transport', async () => {
    const { transport, calls } = cloud();
    const { result } = await runCampaign(transport, calls, [
        { name: 'Asha', phone: '919855550101', extra: { order_id: 'A-1' } },
        { name: 'Ravi', phone: '919855550102', extra: {} },   // no order_id, no fallback -> skipped
    ], { metaTemplate: { template: STORED, params: null } }, 1);
    assert.equal(result.queued, 1);
    assert.equal(result.skippedTemplateVars, 1);
    const sends = calls.filter((c) => c.url.endsWith('/messages'));
    assert.equal(sends.length, 1);
    assert.equal(sends[0].body.to, '919855550101');
    assert.equal(sends[0].body.template.name, 'order_update');
    assert.deepEqual(sends[0].body.template.components[1].parameters.map((p) => p.text), ['Asha', 'A-1']);
});

it('retries once with the fallback template when free-form hits 131047', async () => {
    const { transport, calls } = cloud((body) => (body.type === 'text'
        ? new Response(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } }), { status: 400 })
        : null));
    await runCampaign(transport, calls, [{ name: 'Asha', phone: '919855550101', extra: { order_id: 'Z' } }],
        { text: 'Hi {name}', fallbackTemplate: { template: STORED, params: null } }, 2);
    const sends = calls.filter((c) => c.url.endsWith('/messages')).map((c) => c.body.type);
    assert.deepEqual(sends, ['text', 'template']);
});

it('maps 131049 / 132xxx / 131047 to friendly, non-retryable errors', () => {
    const err = (code) => new TransportSendError(`Cloud API error 400/${code}: raw`, { retryable: false, code });
    const cap = normalizeError(err(131049));
    assert.equal(cap.code, ErrorCode.PER_USER_CAP);
    assert.equal(cap.retryable, false);
    assert.match(friendlyError(err(131049)), /marketing/i);

    const params = normalizeError(err(132000));
    assert.equal(params.code, ErrorCode.TEMPLATE_PARAMS);
    assert.equal(params.retryable, false);
    assert.match(friendlyError(err(132000)), /variables don't match the approved template/);
    assert.equal(normalizeError(err(132012)).code, ErrorCode.TEMPLATE_PARAMS);
    assert.equal(normalizeError(err(132001)).code, ErrorCode.TEMPLATE_UNAVAILABLE);

    assert.equal(normalizeError(err(131047)).code, ErrorCode.TEMPLATE_REQUIRED);
    assert.match(friendlyError(err(131047)), /24 hours/);
});

it('stores language + mapping and only offers approved templates on a Cloud API channel', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-tpls-'));
    const db = new Database(path.join(tmp, 's.db'));
    try {
        const store = new TemplateStore(db);
        const t = store.create({
            name: 'Order update', templateType: 'provider_template', body: STORED.body,
            providerTemplateName: 'order_update', language: 'en', paramMapping: STORED.paramMapping,
        });
        assert.equal(t.language, 'en');
        assert.deepEqual(t.paramMapping, STORED.paramMapping);
        assert.throws(() => store.update(t.id, { language: 'english!' }), /language/);
        assert.throws(() => store.update(t.id, { paramMapping: { body: 'nope' } }), /paramMapping/);

        const cloudChannel = { id: 1, provider: TRANSPORT_CLOUD_API };
        assert.throws(() => metaTemplateFor(store, cloudChannel, t.id), /not approved|draft/);
        store.update(t.id, { approvalStatus: 'approved' });
        const picked = metaTemplateFor(store, cloudChannel, t.id, { body: [{ fallback: 'x' }] });
        assert.equal(picked.template.providerTemplateName, 'order_update');
        assert.deepEqual(picked.params, { body: [{ fallback: 'x' }] });
        assert.throws(() => metaTemplateFor(store, { id: 1, provider: TRANSPORT_BAILEYS }, t.id), /WhatsApp Web/);
        assert.equal(metaTemplateFor(store, cloudChannel, null), null);
    } finally {
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

it('a stored campaign in Meta template mode hands the template (and fallback) to the manager', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-tplc-'));
    const db = new Database(path.join(tmp, 'c.db'));
    try {
        const scoped = db.forTenant(1).forChannel(1);
        const templates = new TemplateStore(scoped);
        const t = templates.create({
            name: 'Order', templateType: 'provider_template', body: STORED.body, approvalStatus: 'approved',
            providerTemplateName: 'order_update', language: 'en', paramMapping: STORED.paramMapping,
        });
        const calls = [];
        const manager = {
            queue: { reset() {} }, resetStats() {}, start() {},
            enqueueContacts(contacts, text, options) { calls.push(options); return { queued: contacts.length }; },
        };
        const store = new CampaignStore(scoped, { contacts: new ContactStore(scoped, '91'), templates, manager });
        store.channel = () => ({ id: 1, provider: TRANSPORT_CLOUD_API });
        const params = { body: [{ var: 'name' }, { fallback: 'X' }] };
        const campaign = store.create({
            name: 'Cold', templateId: t.id, audience: [{ name: 'A', phone: '919000000001' }],
            options: { templateMode: 'meta', templateParams: params, fallbackTemplateId: t.id },
        });
        store.start(campaign.id);
        assert.equal(calls[0].metaTemplate.template.id, t.id);
        assert.deepEqual(calls[0].metaTemplate.params, params);
        assert.equal(calls[0].fallbackTemplate.template.id, t.id);

        // Not on a Cloud API channel -> refused before anything is queued.
        store.channel = () => ({ id: 1, provider: TRANSPORT_BAILEYS });
        const other = store.create({ name: 'Web', templateId: t.id, audience: [{ name: 'A', phone: '919000000001' }],
            options: { templateMode: 'meta' } });
        assert.throws(() => store.start(other.id), /WhatsApp Web/);
        assert.equal(calls.length, 1);
    } finally {
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
