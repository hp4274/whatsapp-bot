/**
 * Phase 12: the ready-made automation modules.
 *
 * The one claim that matters: a recipe is data the existing engine already
 * understands. So the test that counts is that every `build()` in the
 * catalogue passes `validateDefinition` unmodified, and that installing one
 * produces a real workflow and real templates through the normal stores -
 * no new action type, no second engine.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { createCampaignRouter } from '../src/campaigns/routes.js';
import { CAMPAIGNS_SCHEMA } from '../src/campaigns/schema.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { eventTypes } from '../src/objects/types.js';
import { RECIPES, getRecipe, installRecipe } from '../src/recipes/index.js';
import { TemplateStore } from '../src/templates/store.js';
import { ACTIONS, validateDefinition } from '../src/workflows/definition.js';
import { WorkflowStore } from '../src/workflows/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-recipes-'));
/** The two triggers that are not business-object events. */
const INBOUND_TRIGGER = 'message.received';
let db;
let scoped;
let workflows;
let templates;

before(() => {
    db = new Database(path.join(tmp, 'r.db'));
    db.db.exec(CAMPAIGNS_SCHEMA);
    scoped = db.forTenant(1).forChannel(1);
    workflows = new WorkflowStore(scoped);
    templates = new TemplateStore(scoped);
});

after(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the catalogue', () => {
    it('covers every module the roadmap lists, with unique keys', () => {
        const keys = RECIPES.map((r) => r.key);
        assert.equal(new Set(keys).size, keys.length);
        for (const expected of ['appointment_reminder', 'order_confirmation', 'order_status_updates',
            'lead_welcome', 'lead_stop_on_reply', 'payment_due_reminder', 'payment_received',
            'subscription_renewal', 'event_registration', 'school_fee_reminder', 'daily_absent_alert',
            'homework_broadcast', 'ptm_slot_booking', 'leave_request_to_ticket', 'timetable_lookup',
            'complaint_to_ticket']) {
            assert.ok(keys.includes(expected), expected);
        }
    });

    it('builds a definition the existing validator accepts, unmodified', () => {
        for (const recipe of RECIPES) {
            const built = recipe.build();
            assert.doesNotThrow(() => validateDefinition(built), recipe.key);
            // Validation normalises rather than rewrites: the steps survive.
            const clean = validateDefinition(built);
            assert.equal(clean.steps.length, built.steps.length, recipe.key);
            assert.equal(clean.trigger.type, built.trigger.type, recipe.key);
            assert.ok(recipe.name && recipe.description && recipe.industry, recipe.key);
        }
    });

    it('uses only action types that already exist', () => {
        for (const recipe of RECIPES) {
            for (const step of recipe.build().steps) {
                assert.ok(ACTIONS.includes(step.action), `${recipe.key}: ${step.action}`);
            }
        }
    });

    it('triggers only on a real object event, or on the inbound message event', () => {
        const known = new Set([...eventTypes(), INBOUND_TRIGGER]);
        for (const recipe of RECIPES) {
            assert.ok(known.has(recipe.build().trigger.type), `${recipe.key}: ${recipe.build().trigger.type}`);
        }
    });

    it('still validates with the options a caller might pass', () => {
        const options = { remindHoursBefore: 48, overdueAfterDays: 7, nurtureWorkflowId: 4, assignTo: 'asha', assignedTo: 'asha' };
        for (const recipe of RECIPES) {
            assert.doesNotThrow(() => validateDefinition(recipe.build(options)), recipe.key);
        }
    });

    it('names the templates its steps reference', () => {
        for (const recipe of RECIPES) {
            const used = new Set(recipe.build().steps
                .filter((s) => s.action === 'send_template').map((s) => s.params.template));
            const declared = new Set((recipe.requires.templates ?? []).map((t) => t.name));
            for (const name of used) assert.ok(declared.has(name), `${recipe.key}: ${name} is not declared`);
            for (const t of recipe.requires.templates ?? []) assert.ok(t.body, `${recipe.key}: ${t.name} has no body`);
        }
    });

    it('wires each new school recipe to its trigger', () => {
        const expected = {
            fee_payment_receipt: 'fee.status_changed',
            fee_due_reminder: 'fee.created',
            late_arrival_alert: 'attendance.created',
            homework_due_reminder: 'homework.created',
            exam_result_published: 'exam_result.status_changed',
        };
        for (const [key, type] of Object.entries(expected)) {
            assert.equal(getRecipe(key).build().trigger.type, type, key);
        }
        assert.equal(getRecipe('fee_payment_receipt').build().trigger.conditions[0].value, 'paid');
        assert.equal(getRecipe('late_arrival_alert').build().trigger.conditions[0].value, 'late');
        assert.equal(getRecipe('exam_result_published').build().trigger.conditions[0].value, 'published');
    });

    it('answers for an unknown key with null, not a throw', () => {
        assert.equal(getRecipe('no_such_recipe'), null);
        assert.equal(getRecipe('lead_welcome').key, 'lead_welcome');
    });
});

describe('installing', () => {
    it('creates the workflow and only the templates that are missing', () => {
        const recipe = getRecipe('order_status_updates');
        const first = installRecipe(recipe, { workflows, templates, channelId: 1 });
        assert.deepEqual(first.templates, ['order_shipped', 'order_delivered', 'order_feedback']);
        assert.equal(first.workflow.trigger.type, 'order.status_changed');
        assert.equal(first.workflow.status, 'draft');
        assert.equal(first.workflow.version, 1);
        assert.ok(templates.getByName('order_shipped'));

        // Second install: the templates are already there, so nothing is remade.
        const second = installRecipe(recipe, { workflows, templates, channelId: 1, name: 'Order updates v2', status: 'active' });
        assert.deepEqual(second.templates, []);
        assert.equal(second.workflow.name, 'Order updates v2');
        assert.equal(second.workflow.status, 'active');
    });

    it('passes options through to the definition', () => {
        const { workflow } = installRecipe(getRecipe('lead_stop_on_reply'), {
            workflows, templates, channelId: 1, options: { nurtureWorkflowId: 42 },
        });
        assert.equal(workflow.steps.find((s) => s.action === 'stop_workflow').params.workflowId, 42);
    });

    it('matches a real event once installed and active', () => {
        const { workflow } = installRecipe(getRecipe('payment_received'), {
            workflows, templates, channelId: 1, status: 'active', options: { reminderWorkflowId: 7 },
        });
        const matched = workflows.match({ type: 'payment.status_changed', channelId: 1, data: { status: 'paid' } });
        assert.ok(matched.some((w) => w.id === workflow.id));
        // The trigger condition is what keeps it off every other status move.
        const other = workflows.match({ type: 'payment.status_changed', channelId: 1, data: { status: 'failed' } });
        assert.ok(!other.some((w) => w.id === workflow.id));
    });
});

describe('the routes', () => {
    let server;
    let base;

    before(async () => {
        const T = db.forTenant(2).forChannel(2);
        db.db.prepare("INSERT INTO tenants (id, name, slug, status, created_at) VALUES (2, 'B', 'b', 'active', ?)")
            .run('2026-01-01T00:00:00+00:00');
        const state = {
            channel: { id: 2 },
            contacts: new ContactStore(T, '91'),
            templates: new TemplateStore(T),
            workflows: new WorkflowStore(T),
            manager: null,
            media: new Map(),
            transport: null,
            broadcast: () => {},
        };
        const app = express();
        app.use(express.json());
        app.use(createCampaignRouter({ db: T, state }));
        server = app.listen(0);
        await new Promise((done) => server.once('listening', done));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => server?.close());

    it('lists the catalogue with each trigger', async () => {
        const res = await fetch(`${base}/recipes`);
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.recipes.length, RECIPES.length);
        const lead = body.recipes.find((r) => r.key === 'lead_welcome');
        assert.equal(lead.trigger, 'lead.created');
        assert.deepEqual(lead.requires.templates, ['lead_welcome', 'lead_followup_1', 'lead_followup_2']);
        assert.equal(lead.requires.objectType, 'lead');
    });

    it('installs one and hands back the workflow', async () => {
        const res = await fetch(`${base}/recipes/appointment_reminder/install`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'active', options: { remindHoursBefore: 6 } }),
        });
        const body = await res.json();
        assert.equal(res.status, 201);
        assert.equal(body.recipe, 'appointment_reminder');
        assert.equal(body.workflow.trigger.type, 'appointment.created');
        assert.equal(body.workflow.steps[0].params.hours, -6);
        assert.deepEqual(body.templates, ['appointment_reminder', 'appointment_feedback']);
        // Installed for tenant 2, so tenant 1's store cannot see it.
        assert.equal(workflows.get(body.workflow.id), null);
    });

    it('404s an unknown recipe', async () => {
        const res = await fetch(`${base}/recipes/nope/install`, { method: 'POST' });
        assert.equal(res.status, 404);
    });
});
