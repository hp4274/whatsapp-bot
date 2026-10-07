/**
 * Phase 6: the workflow engine.
 *
 * The claims under test: a broken definition is rejected on save; a run pins
 * the version it started on; a wait is a row with a timestamp, not a timer;
 * the same event never starts two runs; a failed step leaves a run that can be
 * retried without sending twice; every step is logged; and none of it leaks
 * across tenants.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Channels } from '../src/channels.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { validateDefinition, matches, interpolate } from '../src/workflows/definition.js';
import { WorkflowEngine } from '../src/workflows/engine.js';
import { WORKFLOWS_SCHEMA } from '../src/workflows/schema.js';
import { WorkflowStore, dueRuns } from '../src/workflows/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-workflows-'));
let db;
let clock = new Date('2026-10-07T10:00:00Z');
const now = () => clock;
const tick = (ms) => { clock = new Date(clock.getTime() + ms); };

/** A fake message service: records jobs, honours idempotency keys, can be told to fail. */
function fakeMessages() {
    const sent = [];
    const seen = new Map();
    const svc = {
        sent,
        failNext: null,
        send(job) {
            if (svc.failNext) { const err = new Error(svc.failNext); svc.failNext = null; throw err; }
            if (seen.has(job.idempotencyKey)) {
                return { accepted: false, messageId: seen.get(job.idempotencyKey), reason: 'duplicate', duplicateOf: seen.get(job.idempotencyKey) };
            }
            const messageId = `m${sent.length + 1}`;
            seen.set(job.idempotencyKey, messageId);
            sent.push(job);
            return { accepted: true, messageId, reason: null, duplicateOf: null };
        },
    };
    return svc;
}

function tenantSetup(tenantId) {
    const scoped = db.forTenant(tenantId);
    const channels = new Channels(scoped);
    const channel = channels.create({ displayName: `T${tenantId}`, phoneNumber: `9100000000${tenantId}`, isDefault: true });
    const contacts = new ContactStore(scoped, '91');
    const store = new WorkflowStore(scoped, { now });
    const messages = fakeMessages();
    const webhooks = [];
    const engine = new WorkflowEngine({
        store, messages, contacts, channels, now,
        renderTemplate: ({ template, context }) => ({ text: `[${template}] hi ${context.contact?.name}`, templateId: `tpl-${template}` }),
        fetch: async (url, opts) => {
            webhooks.push({ url, opts });
            return url.includes('fail') ? { ok: false, status: 500, text: async () => 'nope' } : { ok: true, status: 200, text: async () => '{"ok":true}' };
        },
    });
    return { scoped, channels, channel, contacts, store, messages, engine, webhooks };
}

const send = (id, text, next = null) => ({ id, action: 'send_message', params: { text }, next });

let A;
let B;

before(() => {
    db = new Database(path.join(tmp, 'w.db'));
    db.db.exec(WORKFLOWS_SCHEMA);
    db.db.prepare(`INSERT INTO tenants (id, name, slug, status, created_at) VALUES (2, 'B', 'b', 'active', ?)`).run('2026-01-01T00:00:00+00:00');
    A = tenantSetup(1);
    B = tenantSetup(2);
});

after(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the validator', () => {
    const base = { trigger: { type: 'order.created' } };
    const bad = (steps, pattern) => assert.throws(() => validateDefinition({ ...base, steps }), pattern);

    it('rejects a jump to a step that does not exist', () => {
        bad([send('a', 'hi', 'nowhere')], /unknown step "nowhere"/);
        bad([{ id: 'a', action: 'condition', params: { conditions: [], else: 'ghost' } }], /unknown step "ghost"/);
    });

    it('rejects an action it does not implement', () => {
        bad([{ id: 'a', action: 'send_media', params: {} }], /unknown action "send_media"/);
        bad([{ id: 'a', action: 'notify_team', params: {} }], /unknown action/);
    });

    it('rejects a loop with no wait in it, and allows one with', () => {
        bad([send('a', 'x', 'b'), send('b', 'y', 'a')], /loop with no wait/);
        bad([{ id: 'a', action: 'condition', params: { conditions: [], else: 'a' }, next: null }], /loop/);
        const ok = validateDefinition({ ...base, steps: [send('a', 'x', 'w'), { id: 'w', action: 'wait', params: { hours: 1 }, next: 'a' }] });
        assert.equal(ok.steps.length, 2);
    });

    it('rejects a bad trigger, a duplicate id and a bad condition op', () => {
        assert.throws(() => validateDefinition({ trigger: {}, steps: [send('a', 'x')] }), /trigger.type/);
        bad([send('a', 'x'), send('a', 'y')], /used twice/);
        assert.throws(() => validateDefinition({ trigger: { type: 't', conditions: [{ field: 'x', op: 'like' }] }, steps: [send('a', 'x')] }), /unknown op/);
        bad([{ id: 'a', action: 'wait', params: {} }], /duration/);
    });

    it('evaluates declarative conditions and interpolates paths', () => {
        const root = { event: { data: { total: 120, tags: ['vip'] } }, contact: { name: 'Asha', customFields: { city: 'Pune' } } };
        assert.ok(matches([{ field: 'event.data.total', op: 'gte', value: 100 }, { field: 'event.data.tags', op: 'contains', value: 'vip' }], root));
        assert.ok(!matches([{ field: 'event.data.total', op: 'lt', value: 100 }], root));
        assert.ok(matches([{ field: 'contact.email', op: 'not_exists' }], root));
        assert.equal(interpolate('Hi {name} from {city}, total {total} {missing}', root), 'Hi Asha from Pune, total 120 {missing}');
    });
});

describe('the store', () => {
    it('versions a definition when steps change, not when the name does', () => {
        const wf = A.store.create({ name: 'v', trigger: { type: 'x' }, steps: [send('a', 'one')] });
        assert.equal(wf.version, 1);
        assert.equal(A.store.update(wf.id, { name: 'renamed' }).version, 1);
        const edited = A.store.update(wf.id, { steps: [send('a', 'two')] });
        assert.equal(edited.version, 2);
        assert.equal(A.store.getVersion(wf.id, 1).steps[0].params.text, 'one');
        assert.equal(A.store.getVersion(wf.id, 2).steps[0].params.text, 'two');
        assert.deepEqual(A.store.versions(wf.id).map((v) => v.version), [1, 2]);
    });

    it('matches triggers on type, channel and conditions over data, never on source', () => {
        const wf = A.store.create({
            name: 'big orders', status: 'active',
            trigger: { type: 'order.created', conditions: [{ field: 'total', op: 'gt', value: 100 }] },
            steps: [send('a', 'thanks')],
        });
        const other = A.store.create({ name: 'other channel', status: 'active', channelId: 999, trigger: { type: 'order.created' }, steps: [send('a', 'x')] });
        A.store.create({ name: 'draft', trigger: { type: 'order.created' }, steps: [send('a', 'x')] });
        const ids = (event) => A.store.match(event).map((w) => w.id);
        assert.deepEqual(ids({ type: 'order.created', data: { total: 150 }, source: 'api' }), [wf.id]);
        assert.deepEqual(ids({ type: 'order.created', data: { total: 150 }, source: 'webhook' }), [wf.id]);
        assert.deepEqual(ids({ type: 'order.created', data: { total: 50 } }), []);
        assert.deepEqual(ids({ type: 'order.created', data: { total: 150 }, channelId: 999 }), [wf.id, other.id]);
        assert.deepEqual(B.store.match({ type: 'order.created', data: { total: 150 } }), []);
    });

    it('does not show one tenant the other tenant\'s workflows', () => {
        const wf = B.store.create({ name: 'b only', trigger: { type: 'x' }, steps: [send('a', 'x')] });
        assert.equal(A.store.get(wf.id), null);
        assert.equal(A.store.getVersion(wf.id, 1), null);
        assert.throws(() => A.store.update(wf.id, { name: 'stolen' }), /not found/);
        assert.ok(B.store.get(wf.id));
    });
});

describe('the engine', () => {
    let contact;
    beforeEach(() => {
        contact = A.contacts.upsert({ phone: '9876543210', name: 'Asha', customFields: { city: 'Pune' } });
    });

    const event = (overrides = {}) => ({
        id: `evt-${Math.random().toString(36).slice(2)}`, type: 'order.created', source: 'api',
        subject: { kind: 'contact', id: contact.id }, data: { total: 150, order_id: 'o-1' }, ...overrides,
    });

    it('runs a straight line: send, update contact, tag, template, webhook; and logs every step', async () => {
        const wf = A.store.create({
            name: 'welcome', status: 'active', trigger: { type: 'order.welcome' },
            steps: [
                { id: 's1', action: 'send_message', params: { text: 'Hi {name}, order {order_id} received' }, next: 's2' },
                { id: 's2', action: 'set_field', params: { key: 'last_order', value: '{event.data.order_id}' }, next: 's3' },
                { id: 's3', action: 'add_tag', params: { tag: 'buyer' }, next: 's4' },
                { id: 's4', action: 'send_template', params: { template: 'order_confirm' }, next: 's5' },
                { id: 's5', action: 'call_webhook', params: { url: 'https://hook.test/x', body: { id: '{order_id}' } }, next: 's6' },
                { id: 's6', action: 'remove_tag', params: { tag: 'buyer' }, next: null },
            ],
        });
        const [run] = await A.engine.dispatch(event({ type: 'order.welcome' }));
        assert.equal(run.status, 'completed');
        assert.equal(run.workflowId, wf.id);
        assert.equal(run.channelId, A.channel.id);

        const jobs = A.messages.sent.slice(-2);
        assert.equal(jobs[0].text, 'Hi Asha, order o-1 received');
        assert.equal(jobs[0].messageType, 'workflow');
        assert.equal(jobs[0].tenantId, 1);
        assert.equal(jobs[0].recipient, contact.phone);
        assert.equal(jobs[1].text, '[order_confirm] hi Asha');
        assert.equal(jobs[1].templateId, 'tpl-order_confirm');
        assert.deepEqual(A.webhooks.at(-1).opts.body, JSON.stringify({ id: 'o-1' }));

        const after1 = A.contacts.get(contact.id);
        assert.equal(after1.customFields.last_order, 'o-1');
        assert.ok(!after1.tags.includes('buyer'));

        const steps = A.store.runSteps(run.runId);
        assert.deepEqual(steps.map((s) => s.stepId), ['s1', 's2', 's3', 's4', 's5', 's6']);
        assert.ok(steps.every((s) => s.status === 'completed' && s.finishedAt));
        assert.ok(steps[0].output.messageId);
        assert.equal(steps[4].output.status, 200);
        assert.deepEqual(run.context.vars.s5.body, { ok: true });
    });

    it('branches and conditions pick the right path', async () => {
        A.store.create({
            name: 'router', status: 'active', trigger: { type: 'tier.check' },
            steps: [
                { id: 'c', action: 'condition', params: { conditions: [{ field: 'contact.customFields.city', op: 'eq', value: 'Pune' }], else: 'far' }, next: 'b' },
                { id: 'b', action: 'branch', params: { branches: [
                    { conditions: [{ field: 'event.data.total', op: 'gte', value: 1000 }], next: 'gold' },
                    { conditions: [{ field: 'event.data.total', op: 'gte', value: 100 }], next: 'silver' },
                ], else: 'bronze' } },
                send('gold', 'gold'), send('silver', 'silver'), send('bronze', 'bronze'), send('far', 'far'),
            ],
        });
        const text = async (data) => {
            const [run] = await A.engine.dispatch(event({ type: 'tier.check', data }));
            assert.equal(run.status, 'completed');
            return A.messages.sent.at(-1).text;
        };
        assert.equal(await text({ total: 5000 }), 'gold');
        assert.equal(await text({ total: 150 }), 'silver');
        assert.equal(await text({ total: 1 }), 'bronze');
        A.contacts.upsert({ phone: contact.phone, normalized: true, customFields: { city: 'Goa' } });
        assert.equal(await text({ total: 5000 }), 'far');
        A.contacts.upsert({ phone: contact.phone, normalized: true, customFields: { city: 'Pune' } });
    });

    it('waits as a row with resume_at, survives an edit, and resumes on the pinned version', async () => {
        const wf = A.store.create({
            name: 'follow up', status: 'active', trigger: { type: 'lead.created' },
            steps: [send('a', 'welcome', 'w'), { id: 'w', action: 'wait', params: { hours: 24 }, next: 'b' }, send('b', 'still there?')],
        });
        const [run] = await A.engine.dispatch(event({ type: 'lead.created' }));
        assert.equal(run.status, 'waiting');
        assert.equal(run.currentStep, 'b');
        assert.equal(run.resumeAt, '2026-10-08T10:00:00+00:00');
        assert.equal(run.workflowVersion, 1);

        A.store.update(wf.id, { steps: [send('a', 'welcome', 'w'), { id: 'w', action: 'wait', params: { hours: 24 }, next: 'b' }, send('b', 'EDITED')] });
        assert.equal(A.store.get(wf.id).version, 2);

        assert.deepEqual(A.engine.due(), []);
        tick(23 * 3_600_000);
        assert.deepEqual(A.engine.due(), []);
        tick(3_600_000);
        assert.deepEqual(A.engine.due().map((r) => r.runId), [run.runId]);
        assert.deepEqual(dueRuns(db, now()), [{ runId: run.runId, tenantId: 1 }]);
        assert.deepEqual(B.engine.due(), [], 'another tenant does not see the due run');

        const resumed = await A.engine.resume(run.runId);
        assert.equal(resumed.status, 'completed');
        assert.equal(resumed.resumeAt, null);
        assert.equal(A.messages.sent.at(-1).text, 'still there?', 'the pinned version, not the edit');
        assert.deepEqual(A.engine.due(), []);
        await assert.rejects(() => A.engine.resume(run.runId), /not waiting/);
    });

    it('waits until a field with an offset', async () => {
        A.store.create({
            name: 'reminder', status: 'active', trigger: { type: 'appointment.created' },
            steps: [{ id: 'w', action: 'wait', params: { until: 'event.data.at', hours: -2 }, next: 'r' }, send('r', 'see you at {at}')],
        });
        const [run] = await A.engine.dispatch(event({ type: 'appointment.created', data: { at: '2026-12-01T09:00:00Z' } }));
        assert.equal(run.status, 'waiting');
        assert.equal(run.resumeAt, '2026-12-01T07:00:00+00:00');
    });

    it('starts one run per event, however many times the event is delivered', async () => {
        const wf = A.store.create({ name: 'idem', status: 'active', trigger: { type: 'ping' }, steps: [send('a', 'pong')] });
        const evt = event({ type: 'ping' });
        const [r1] = await A.engine.dispatch(evt);
        const [r2] = await A.engine.dispatch(evt);
        assert.equal(r1.runId, r2.runId);
        assert.equal(A.store.listRuns({ workflowId: wf.id }).length, 1);
        assert.equal(A.messages.sent.filter((j) => j.text === 'pong').length, 1);
        const direct = A.engine.start(A.store.get(wf.id), evt);
        assert.equal(direct.created, false);
        const [r3] = await A.engine.dispatch(event({ type: 'ping' }));
        assert.notEqual(r3.runId, r1.runId, 'a different event is a different run');
    });

    it('records a failed step, keeps the run, and retries without sending twice', async () => {
        A.store.create({ name: 'fragile', status: 'active', trigger: { type: 'boom' }, steps: [send('a', 'first', 'b'), send('b', 'second')] });
        const failing = fakeMessages();
        let calls = 0;
        const origSend = failing.send;
        failing.send = (job) => { calls += 1; if (calls === 2) throw new Error('provider down'); return origSend(job); };
        const engine = new WorkflowEngine({ store: A.store, messages: failing, contacts: A.contacts, channels: A.channels, now });

        const [failed] = await engine.dispatch(event({ type: 'boom', data: {} }));
        assert.equal(failed.status, 'failed');
        assert.equal(failed.currentStep, 'b');
        assert.match(failed.error, /provider down/);
        assert.ok(failed.finishedAt);
        assert.deepEqual(A.store.runSteps(failed.runId).map((s) => [s.stepId, s.status, s.attempt]),
            [['a', 'completed', 1], ['b', 'failed', 1]]);
        await assert.rejects(() => engine.resume(failed.runId), /not waiting/);

        const retried = await engine.retry(failed.runId);
        assert.equal(retried.status, 'completed');
        assert.equal(retried.error, null);
        assert.deepEqual(A.store.runSteps(failed.runId).map((s) => [s.stepId, s.status, s.attempt]),
            [['a', 'completed', 1], ['b', 'failed', 1], ['b', 'completed', 2]]);
        assert.deepEqual(failing.sent.map((j) => j.text), ['first', 'second'], 'step a was not sent again');
    });

    it('takes the onError path when a step declares one', async () => {
        A.store.create({
            name: 'hooked', status: 'active', trigger: { type: 'hook' },
            steps: [{ id: 'h', action: 'call_webhook', params: { url: 'https://hook.test/fail' }, next: 'ok', onError: 'sorry' }, send('ok', 'ok'), send('sorry', 'sorry')],
        });
        const [run] = await A.engine.dispatch(event({ type: 'hook' }));
        assert.equal(run.status, 'completed');
        assert.equal(A.messages.sent.at(-1).text, 'sorry');
        assert.equal(A.store.runSteps(run.runId)[0].status, 'failed');
    });

    it('stops itself, stops another workflow, and starts one', async () => {
        const target = A.store.create({ name: 'child', status: 'active', trigger: { type: 'never' }, steps: [send('a', 'child says hi')] });
        const long = A.store.create({ name: 'long', status: 'active', trigger: { type: 'long' }, steps: [{ id: 'w', action: 'wait', params: { days: 7 }, next: null }] });
        const [waiting] = await A.engine.dispatch(event({ type: 'long' }));
        assert.equal(waiting.status, 'waiting');

        A.store.create({
            name: 'parent', status: 'active', trigger: { type: 'parent' },
            steps: [
                { id: 'k', action: 'stop_workflow', params: { workflowId: long.id }, next: 's' },
                { id: 's', action: 'start_workflow', params: { workflowId: target.id }, next: 'x' },
                { id: 'x', action: 'stop_workflow', params: {}, next: 'never' },
                send('never', 'unreachable'),
            ],
        });
        const [run] = await A.engine.dispatch(event({ type: 'parent' }));
        assert.equal(run.status, 'stopped');
        assert.equal(A.store.getRun(waiting.runId).status, 'stopped');
        assert.equal(run.context.vars.k.stopped, 1);
        const child = A.store.getRun(run.context.vars.s.runId);
        assert.equal(child.status, 'completed');
        assert.equal(child.workflowId, target.id);
        assert.equal(A.messages.sent.at(-1).text, 'child says hi');
        assert.equal(A.engine.stop(run.runId).status, 'stopped');
    });

    it('fails cleanly when there is nothing to send to', async () => {
        A.store.create({ name: 'nobody', status: 'active', trigger: { type: 'nobody' }, steps: [send('a', 'hi')] });
        const [run] = await A.engine.dispatch({ type: 'nobody', data: {} });
        assert.equal(run.status, 'failed');
        assert.equal(run.contactId, null);
        assert.match(run.error, /no contact/);
    });

    it('finds the contact by phone in the data when there is no subject', async () => {
        A.store.create({ name: 'byphone', status: 'active', trigger: { type: 'byphone' }, steps: [send('a', 'hi {name}')] });
        const [run] = await A.engine.dispatch({ type: 'byphone', data: { phone: contact.phone } });
        assert.equal(run.status, 'completed');
        assert.equal(run.contactId, contact.id);
    });

    it('is tenant-isolated: events, runs and contacts never cross', async () => {
        const bContact = B.contacts.upsert({ phone: '9876543210', name: 'Bob' });
        A.store.create({ name: 'A hello', status: 'active', trigger: { type: 'hello' }, steps: [send('a', 'from A')] });
        B.store.create({ name: 'B hello', status: 'active', trigger: { type: 'hello' }, steps: [send('a', 'from B')] });

        const [bRun] = await B.engine.dispatch({ type: 'hello', tenantId: 2, subject: { kind: 'contact', id: bContact.id }, data: {} });
        assert.equal(bRun.status, 'completed');
        assert.equal(bRun.tenantId, 2);
        assert.equal(bRun.channelId, B.channel.id);
        assert.equal(B.messages.sent.at(-1).text, 'from B');
        assert.equal(B.messages.sent.at(-1).tenantId, 2);

        assert.equal(A.store.getRun(bRun.runId), null);
        assert.deepEqual(A.store.runSteps(bRun.runId), []);
        await assert.rejects(() => A.engine.resume(bRun.runId), /not found/);
        await assert.rejects(() => A.engine.dispatch({ type: 'hello', tenantId: 2, data: {} }), /belongs to tenant 2/);
        assert.throws(() => A.engine.start(B.store.list()[0], { type: 'hello' }), /another tenant/);

        // Tenant A's contact id handed to tenant B resolves to nothing, not to A's contact.
        const [aRun] = await A.engine.dispatch({ type: 'hello', subject: { kind: 'contact', id: contact.id }, data: {} });
        assert.equal(aRun.status, 'completed');
        const [cross] = await B.engine.dispatch({ type: 'hello', subject: { kind: 'contact', id: contact.id }, data: {} });
        assert.equal(cross.contactId, null);
        assert.equal(cross.status, 'failed');
    });
});
