/**
 * The runtime. One engine per tenant, built from the pieces it needs rather
 * than importing them, so it runs in a test with fakes and never imports the
 * templates module being built beside it.
 *
 * A run is a row. `advance()` executes steps until a wait, an end or an
 * error, writes where it got to, and returns. Nothing in memory holds a run,
 * so a 24-hour wait is a `resume_at` timestamp and a scheduler (Phase 7)
 * calling `due()` then `resume()` - this module never sets a timer.
 */

import crypto from 'node:crypto';

import { WorkflowError, interpolateDeep, matches, resolve } from './definition.js';
import { iso } from './store.js';

const UNITS = Object.freeze({ seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 });

export class WorkflowEngine {
    /**
     * @param {object} deps
     * @param {import('./store.js').WorkflowStore} deps.store   this tenant's definitions and runs
     * @param {{ send(job): object }} deps.messages              the message service; the only way out
     * @param {object} deps.contacts                             this tenant's ContactStore
     * @param {{ route(opts): object }} [deps.channels]          this tenant's Channels, for a run with no channel
     * @param {(opts) => object|Promise<object>} [deps.renderTemplate]
     *        `({ template, context, channelId }) => { text, media?, templateId? }`
     * @param {() => Date} [deps.now]
     * @param {typeof fetch} [deps.fetch]
     */
    constructor({
        store, messages, contacts, channels = null, renderTemplate = null,
        // Phase 9. Injected like everything else, so the engine still runs
        // without a ticket store and its own tests need no ticket tables.
        tickets = null,
        now = () => new Date(), fetch = globalThis.fetch,
    }) {
        this.store = store;
        this.tenantId = store.tenantId;
        this.messages = messages;
        this.contacts = contacts;
        this.channels = channels;
        this.renderTemplate = renderTemplate;
        this.tickets = tickets;
        this.now = now;
        this.fetch = fetch;
    }

    // ------------------------------------------------------------- events --
    /**
     * The entry point for an inbound business event: log it, start a run for
     * every active workflow it triggers, advance each. A redelivered event
     * starts nothing new - `start` dedupes on (workflow, contact, event id).
     */
    async dispatch(input) {
        const event = this.normalizeEvent(input);
        this.store.logEvent(event);
        const runs = [];
        for (const workflow of this.store.match(event)) {
            const { run, created } = this.start(workflow, event);
            runs.push(created ? await this.advance(run) : run);
        }
        return runs;
    }

    /** Fill defaults and refuse an event that belongs to another tenant. */
    normalizeEvent(event) {
        if (!event || typeof event.type !== 'string' || !event.type) throw new WorkflowError('event.type is required');
        if (event.tenantId != null && Number(event.tenantId) !== this.tenantId) {
            throw new WorkflowError(`event belongs to tenant ${event.tenantId}, not ${this.tenantId}`, 403);
        }
        return {
            id: event.id ?? crypto.randomUUID(),
            tenantId: this.tenantId,
            channelId: event.channelId ?? null,
            type: event.type,
            occurredAt: iso(event.occurredAt ?? this.now()),
            subject: event.subject ?? null,
            data: event.data ?? {},
            source: event.source ?? 'internal',
        };
    }

    // --------------------------------------------------------------- runs --
    /**
     * Create a run pinned to the workflow's current version. Returns the
     * existing run, not a second one, when this event already started it.
     */
    start(workflow, input) {
        const event = this.normalizeEvent(input);
        if (workflow.tenantId !== this.tenantId) throw new WorkflowError('workflow belongs to another tenant', 403);
        const contact = this.#findContact(event);
        const channelId = workflow.channelId ?? event.channelId ?? this.#defaultChannel();
        return this.store.createRun({
            workflowId: workflow.id,
            workflowVersion: workflow.version,
            contactId: contact?.id ?? null,
            channelId,
            currentStep: workflow.steps[0]?.id ?? null,
            context: { event, contact, vars: {} },
            idempotencyKey: `${workflow.id}:${contact?.id ?? event.subject?.id ?? '-'}:${event.id}`,
        });
    }

    /**
     * Execute from `current_step` until a wait, the end, or an error. Every
     * step attempt is logged before it runs and closed after, so a crash
     * between the two leaves a 'running' step row that says exactly where.
     */
    async advance(runOrId) {
        let run = typeof runOrId === 'string' ? this.store.getRun(runOrId) : runOrId;
        if (!run) throw new WorkflowError('run not found', 404);
        if (run.status !== 'running') return run;
        const version = this.store.getVersion(run.workflowId, run.workflowVersion);
        const steps = new Map(version.steps.map((s) => [s.id, s]));
        const ctx = run.context;

        let stepId = run.currentStep;
        while (stepId) {
            const step = steps.get(stepId);
            if (!step) return this.#fail(run, stepId, `step "${stepId}" is not in version ${run.workflowVersion}`);
            const params = interpolateDeep(step.params, ctx);
            const logId = this.store.startStep(run.runId, step, params);
            let result;
            try {
                result = await this.#execute(step, params, run, ctx);
            } catch (err) {
                this.store.finishStep(logId, { status: 'failed', error: err.message });
                if (step.onError) { stepId = step.onError; continue; }
                return this.#fail(run, stepId, err.message, ctx);
            }
            this.store.finishStep(logId, { status: 'completed', output: result.output ?? null });
            if (result.output !== undefined) ctx.vars[step.id] = result.output;
            if (result.contact !== undefined) ctx.contact = result.contact;

            if (result.wait) {
                return this.store.updateRun(run.runId, {
                    status: 'waiting', currentStep: step.next, context: ctx, resumeAt: iso(result.wait),
                });
            }
            if (result.stop) return this.store.updateRun(run.runId, { status: 'stopped', currentStep: null, context: ctx, finished: true });
            stepId = 'next' in result ? result.next : step.next;
            run = this.store.updateRun(run.runId, { currentStep: stepId, context: ctx });
        }
        return this.store.updateRun(run.runId, { status: 'completed', currentStep: null, context: ctx, finished: true });
    }

    /** Waiting runs whose timer has passed. The scheduler calls this, then `resume`. */
    due(now = this.now()) {
        return this.store.due(now);
    }

    async resume(runId) {
        return this.#restart(runId, 'waiting');
    }

    /** Try a failed run again from the step that failed. The send steps are idempotent per (run, step). */
    async retry(runId) {
        return this.#restart(runId, 'failed');
    }

    stop(runId) {
        const run = this.store.getRun(runId);
        if (!run) throw new WorkflowError('run not found', 404);
        if (['completed', 'failed', 'stopped'].includes(run.status)) return run;
        return this.store.updateRun(runId, { status: 'stopped', finished: true });
    }

    // ------------------------------------------------------------ actions --
    /** A ticket step may name the row by id or by its human reference. */
    #findTicket(params) {
        const found = params.ticketId
            ? this.tickets.get(params.ticketId)
            : this.tickets.getByReference(params.reference);
        if (!found) throw new WorkflowError(`ticket not found: ${params.ticketId ?? params.reference}`);
        return found;
    }

    async #execute(step, params, run, ctx) {
        switch (step.action) {
            case 'send_message':
                return { output: this.#send(run, step, { text: params.text ?? '', media: params.media ?? null }) };

            case 'create_ticket': {
                if (!this.tickets) throw new WorkflowError('no ticket store is configured');
                // A definition does not get to claim the ticket came from a
                // person: the source is what this path actually is.
                const ticket = this.tickets.create({
                    subject: params.subject ?? '',
                    category: params.category ?? '',
                    priority: params.priority ?? 'normal',
                    assignedTo: params.assignedTo ?? null,
                    contactId: params.contactId ?? run.contactId ?? null,
                    conversationId: params.conversationId ?? null,
                    metadata: params.metadata ?? null,
                    source: 'workflow',
                    userId: null,
                });
                return { output: { ticketId: ticket.id, reference: ticket.reference, ...ticket } };
            }

            case 'update_ticket': {
                if (!this.tickets) throw new WorkflowError('no ticket store is configured');
                const found = this.#findTicket(params);
                const { ticketId, reference, note, notify, ...patch } = params;
                void ticketId; void reference; void notify;
                return { output: this.tickets.update(found.id, patch, { userId: null, note }) };
            }

            case 'assign_agent': {
                if (!this.tickets) throw new WorkflowError('no ticket store is configured');
                const found = this.#findTicket(params);
                return { output: this.tickets.assign(found.id, params.assignedTo, { userId: null, note: params.note }) };
            }

            case 'send_template': {
                if (!this.renderTemplate) throw new WorkflowError('no template renderer is configured');
                const rendered = await this.renderTemplate({
                    template: params.template, variables: params.variables ?? {}, context: ctx, channelId: run.channelId,
                });
                return { output: this.#send(run, step, rendered) };
            }

            case 'wait': {
                const base = params.until ? new Date(resolve(params.until, ctx)) : this.now();
                if (Number.isNaN(base.getTime())) throw new WorkflowError(`wait: "${params.until}" is not a date`);
                const offset = Object.entries(UNITS).reduce((ms, [k, mult]) => ms + Number(params[k] ?? 0) * mult, 0);
                return { wait: new Date(base.getTime() + offset), output: { until: iso(new Date(base.getTime() + offset)) } };
            }

            case 'condition': {
                const ok = matches(params.conditions, ctx);
                return { next: ok ? step.next : params.else ?? null, output: { matched: ok } };
            }

            case 'branch': {
                const hit = params.branches.find((b) => matches(b.conditions, ctx));
                return { next: hit ? hit.next : params.else ?? null, output: { matched: hit ? params.branches.indexOf(hit) : null } };
            }

            case 'update_contact': {
                const { name, email, status, optInStatus, customFields, tags } = params;
                return { contact: this.#patchContact(run, { name, email, status, optInStatus, customFields, tags }) };
            }

            case 'set_field':
                return { contact: this.#patchContact(run, { customFields: { [params.key]: params.value } }) };

            case 'add_tag':
                return { contact: this.contacts.addTags(this.#requireContact(run).id, params.tags ?? [params.tag]) };

            case 'remove_tag':
                return { contact: this.contacts.removeTags(this.#requireContact(run).id, params.tags ?? [params.tag]) };

            case 'stop_workflow': {
                if (params.workflowId == null) return { stop: true };
                const stopped = this.store.stopRuns({ workflowId: params.workflowId, contactId: run.contactId, except: run.runId });
                return { output: { stopped } };
            }

            case 'start_workflow': {
                const target = this.store.get(params.workflowId);
                if (!target) throw new WorkflowError(`workflow ${params.workflowId} not found`);
                // Same event id, so re-running this step cannot start the child twice.
                const { run: child, created } = this.start(target, { ...ctx.event, channelId: run.channelId });
                if (created) await this.advance(child);
                return { output: { runId: child.runId, created } };
            }

            case 'call_webhook': {
                const res = await this.fetch(params.url, {
                    method: params.method ?? 'POST',
                    headers: { 'content-type': 'application/json', ...(params.headers ?? {}) },
                    body: params.method === 'GET' ? undefined : JSON.stringify(params.body ?? { event: ctx.event, contact: ctx.contact }),
                });
                const text = await res.text();
                if (!res.ok) throw new WorkflowError(`webhook ${params.url} answered ${res.status}`);
                let body = text;
                try { body = JSON.parse(text); } catch { /* not JSON; keep the text */ }
                return { output: { status: res.status, body } };
            }

            default:
                throw new WorkflowError(`unknown action "${step.action}"`);
        }
    }

    /**
     * One idempotency key per (run, step): a retried step after a crash gets
     * the original message id back, not a second message.
     */
    #send(run, step, { text = '', media = null, templateId = null }) {
        const contact = this.#requireContact(run);
        if (run.channelId == null) throw new WorkflowError('run has no channel to send on');
        const result = this.messages.send({
            tenantId: this.tenantId,
            channelId: run.channelId,
            messageType: 'workflow',
            recipient: contact.phone,
            name: contact.name,
            contactId: contact.id,
            text,
            media,
            templateId,
            metadata: { workflowId: run.workflowId, runId: run.runId, stepId: step.id },
            idempotencyKey: `wf.${run.runId}.${step.id}`,
        });
        if (!result.accepted && result.reason !== 'duplicate') throw new WorkflowError(`message not accepted: ${result.reason}`);
        return { messageId: result.messageId, reason: result.reason };
    }

    /** `upsert` defaults a missing name to '', so a partial patch must carry the rest. */
    #patchContact(run, patch) {
        const contact = this.#requireContact(run);
        return this.contacts.upsert({
            phone: contact.phone, normalized: true, name: contact.name, email: contact.email, source: contact.source,
            ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
        });
    }

    #requireContact(run) {
        const contact = run.contactId == null ? null : this.contacts.get(run.contactId);
        if (!contact) throw new WorkflowError('run has no contact');
        return contact;
    }

    #findContact(event) {
        if (event.subject?.kind === 'contact' && event.subject.id != null) return this.contacts.get(event.subject.id);
        if (event.data.contactId != null) return this.contacts.get(event.data.contactId);
        if (event.data.phone) return this.contacts.getByPhone(this.contacts.normalize(event.data.phone, true));
        return null;
    }

    #defaultChannel() {
        try {
            return this.channels?.route({ capability: 'workflow_messages' }).id ?? null;
        } catch {
            return null; // a run with nothing to send needs no channel; a send step will say so
        }
    }

    #fail(run, stepId, error, ctx) {
        return this.store.updateRun(run.runId, { status: 'failed', currentStep: stepId, error, context: ctx, finished: true });
    }

    #restart(runId, from) {
        const run = this.store.getRun(runId);
        if (!run) throw new WorkflowError('run not found', 404);
        if (run.status !== from) throw new WorkflowError(`run is ${run.status}, not ${from}`, 409);
        return this.advance(this.store.updateRun(runId, { status: 'running', resumeAt: null, error: null, finished: false }));
    }
}
