/**
 * The workflow definition: what a trigger and a step may look like, and the
 * checks that reject a broken one at save time rather than at 3am.
 *
 * Conditions are declarative - `{ field, op, value }` - and `field` is a
 * dotted path into a plain object. There is deliberately no expression
 * language: everything Phase 6 needs is a comparison, and anything beyond that
 * is a `call_webhook` to code that lives somewhere else.
 */

export const WORKFLOW_STATUSES = Object.freeze(['draft', 'active', 'paused']);

/** Every action the engine executes. Anything else is rejected on save. */
export const ACTIONS = Object.freeze([
    'send_message',
    'send_template',
    'wait',
    'condition',
    'branch',
    'update_contact',
    'set_field',
    'add_tag',
    'remove_tag',
    'stop_workflow',
    'start_workflow',
    'call_webhook',
]);

const OPS = Object.freeze({
    eq: (a, b) => a == b, // eslint-disable-line eqeqeq -- '5' from a form equals 5 from an API
    ne: (a, b) => a != b, // eslint-disable-line eqeqeq
    gt: (a, b) => Number(a) > Number(b),
    gte: (a, b) => Number(a) >= Number(b),
    lt: (a, b) => Number(a) < Number(b),
    lte: (a, b) => Number(a) <= Number(b),
    in: (a, b) => Array.isArray(b) && b.some((v) => v == a), // eslint-disable-line eqeqeq
    contains: (a, b) => (Array.isArray(a) ? a.some((v) => v == b) // eslint-disable-line eqeqeq
        : typeof a === 'string' && a.includes(String(b))),
    exists: (a) => a !== undefined && a !== null && a !== '',
    not_exists: (a) => a === undefined || a === null || a === '',
});

export class WorkflowError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** Read `a.b.c` out of an object; undefined when any hop is missing. */
export function resolve(path, root) {
    return String(path).split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), root);
}

/** Every condition must hold. An empty list holds. */
export function matches(conditions, root) {
    return (conditions ?? []).every((c) => OPS[c.op](resolve(c.field, root), c.value));
}

/**
 * Replace `{path}` with the value at that path. Short names fall back to the
 * contact, then its custom fields, then the event data, so `{name}` and
 * `{order_id}` work the way Phase 5's variable list promises.
 */
export function interpolate(text, ctx) {
    return String(text).replace(/\{([\w.]+)\}/g, (whole, path) => {
        const value = resolve(path, ctx)
            ?? resolve(path, ctx.contact)
            ?? resolve(path, ctx.contact?.customFields)
            ?? resolve(path, ctx.event?.data);
        return value === undefined || value === null ? whole : String(value);
    });
}

/** Interpolate every string in a params object, however nested. */
export function interpolateDeep(value, ctx) {
    if (typeof value === 'string') return interpolate(value, ctx);
    if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, ctx));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, ctx)]));
    }
    return value;
}

/** Everywhere a step can jump to. */
export function targetsOf(step) {
    const params = step.params ?? {};
    return [
        step.next,
        step.onError,
        params.else,
        ...(Array.isArray(params.branches) ? params.branches.map((b) => b.next) : []),
    ].filter((id) => id != null);
}

/**
 * Validate and normalise a definition. Returns `{ trigger, steps }` ready to
 * store, or throws a WorkflowError naming the first problem.
 */
export function validateDefinition({ trigger, steps }) {
    if (!trigger || typeof trigger.type !== 'string' || !trigger.type.trim()) {
        throw new WorkflowError('trigger.type is required');
    }
    const conditions = validateConditions(trigger.conditions, 'trigger');

    if (!Array.isArray(steps) || !steps.length) throw new WorkflowError('a workflow needs at least one step');
    const ids = new Set();
    const clean = steps.map((step, i) => {
        const id = String(step?.id ?? '').trim();
        if (!id) throw new WorkflowError(`step ${i + 1} has no id`);
        if (ids.has(id)) throw new WorkflowError(`step id "${id}" is used twice`);
        ids.add(id);
        if (!ACTIONS.includes(step.action)) throw new WorkflowError(`step "${id}": unknown action "${step.action}"`);
        const params = validateParams(step.action, step.params ?? {}, id);
        return {
            id,
            action: step.action,
            params,
            next: step.next == null ? null : String(step.next),
            onError: step.onError == null ? null : String(step.onError),
        };
    });

    for (const step of clean) {
        for (const target of targetsOf(step)) {
            if (!ids.has(target)) throw new WorkflowError(`step "${step.id}" jumps to unknown step "${target}"`);
        }
    }
    const loop = waitFreeCycle(clean);
    if (loop) throw new WorkflowError(`steps ${loop.join(' -> ')} form a loop with no wait in it`);

    return { trigger: { type: trigger.type.trim(), conditions }, steps: clean };
}

function validateConditions(list, where) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw new WorkflowError(`${where}: conditions must be an array`);
    return list.map((c, i) => {
        if (!c || typeof c.field !== 'string' || !c.field) throw new WorkflowError(`${where}: condition ${i + 1} needs a field`);
        if (!OPS[c.op]) throw new WorkflowError(`${where}: condition ${i + 1} has unknown op "${c.op}"`);
        return { field: c.field, op: c.op, value: c.value ?? null };
    });
}

function validateParams(action, params, id) {
    const need = (ok, what) => { if (!ok) throw new WorkflowError(`step "${id}" (${action}) needs ${what}`); };
    switch (action) {
        case 'send_message': need(params.text || params.media, 'text or media'); break;
        case 'send_template': need(params.template, 'a template'); break;
        case 'wait':
            need(params.until || ['seconds', 'minutes', 'hours', 'days'].some((k) => params[k] != null),
                'a duration or an until field');
            break;
        case 'condition':
            return { ...params, conditions: validateConditions(params.conditions, `step "${id}"`) };
        case 'branch':
            need(Array.isArray(params.branches) && params.branches.length, 'branches');
            return {
                ...params,
                branches: params.branches.map((b, i) => ({
                    conditions: validateConditions(b?.conditions, `step "${id}" branch ${i + 1}`),
                    next: b?.next == null ? null : String(b.next),
                })),
            };
        case 'set_field': need(params.key, 'a key'); break;
        case 'add_tag':
        case 'remove_tag': need(params.tag || (Array.isArray(params.tags) && params.tags.length), 'a tag'); break;
        case 'call_webhook': need(params.url, 'a url'); break;
        case 'start_workflow': need(params.workflowId, 'a workflowId'); break;
        default: break;
    }
    return params;
}

/**
 * A loop is fine if a wait sits on it; it is a spin otherwise. Drop the edges
 * out of every wait and any cycle left is one with no wait in it.
 */
function waitFreeCycle(steps) {
    const edges = new Map(steps.map((s) => [s.id, s.action === 'wait' ? [] : targetsOf(s)]));
    const state = new Map();
    const stack = [];
    const visit = (id) => {
        state.set(id, 'open');
        stack.push(id);
        for (const next of edges.get(id)) {
            if (state.get(next) === 'open') return [...stack.slice(stack.indexOf(next)), next];
            if (!state.has(next)) {
                const found = visit(next);
                if (found) return found;
            }
        }
        stack.pop();
        state.set(id, 'done');
        return null;
    };
    for (const id of edges.keys()) {
        if (!state.has(id)) {
            const found = visit(id);
            if (found) return found;
        }
    }
    return null;
}
