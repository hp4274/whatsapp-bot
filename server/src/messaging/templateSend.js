/**
 * Meta-approved template sends (Cloud API only).
 *
 * Outside the 24-hour customer-service window Meta only accepts an approved
 * template (error 131047 otherwise). A stored template carries the Meta name,
 * language and an ordered mapping from the template's {{1}}, {{2}} ... slots
 * to contact variables; this turns that plus one contact into the transport's
 * `template` object, and renders the readable text history and previews show.
 *
 * Mapping shape (`template.paramMapping`, or per-campaign `templateParams`):
 *   {
 *     body:    [{ var: 'name', fallback: 'there' }, { var: '', fallback: 'literal' }],
 *     header:  { type: 'text', var, fallback }
 *            | { type: 'image'|'video'|'document', link?, mediaId? },
 *     buttons: [{ index: 0, subType: 'url'|'quick_reply', var, fallback }],
 *   }
 * A media header without link/mediaId is filled by the transport from the
 * campaign attachment (`media`), uploaded once per file.
 */

import { TemplateError, compatibility } from '../templates/store.js';

const SLOT = /\{\{\s*(\d+)\s*\}\}/g;
export const DEFAULT_TEMPLATE_LANGUAGE = 'en_US';
const MEDIA_HEADERS = ['image', 'video', 'document'];

/** Highest {{n}} in a body: how many body parameters Meta expects. */
export function slotCount(body) {
    let max = 0;
    for (const [, n] of String(body ?? '').matchAll(SLOT)) max = Math.max(max, Number(n));
    return max;
}

/** One slot's value: the contact's variable, else the fallback. */
function fill(slot, context) {
    if (slot == null) return '';
    if (typeof slot !== 'object') return String(slot).trim();
    const key = String(slot.var ?? '').trim();
    const value = key ? context[key] : undefined;
    const text = value === undefined || value === null || String(value).trim() === '' ? slot.fallback : value;
    return String(text ?? '').trim();
}

/**
 * @param {object} stored    a TemplateStore template
 * @param {object} context   contactContext(contact)
 * @param {object} [params]  a mapping that overrides `stored.paramMapping`
 * @returns {{ name, language, components, bodyParams: string[], missing: string[] }}
 *   `missing` names the slots (`{{2}}`, `header`, `button 0`) that came out
 *   empty - Meta rejects an empty parameter, so callers skip those recipients.
 */
export function resolveTemplate(stored, context = {}, params = null) {
    const name = String(stored?.providerTemplateName ?? '').trim();
    if (!name) throw new Error('this template has no Meta template name');
    const mapping = params ?? stored.paramMapping ?? {};
    const missing = [];
    const components = [];

    const header = mapping.header;
    if (header?.type === 'text') {
        const text = fill(header, context);
        if (!text) missing.push('header');
        components.push({ type: 'header', parameters: [{ type: 'text', text }] });
    } else if (MEDIA_HEADERS.includes(header?.type) && (header.link || header.mediaId)) {
        const ref = header.mediaId ? { id: String(header.mediaId) } : { link: String(header.link) };
        components.push({ type: 'header', parameters: [{ type: header.type, [header.type]: ref }] });
    }

    // As many body parameters as the approved body has slots; a longer
    // mapping is trimmed, a shorter one reports the gap.
    const wanted = stored.body ? slotCount(stored.body) : (mapping.body ?? []).length;
    const bodyParams = [];
    for (let i = 0; i < wanted; i += 1) {
        const text = fill(mapping.body?.[i], context);
        if (!text) missing.push(`{{${i + 1}}}`);
        bodyParams.push(text);
    }
    if (bodyParams.length) {
        components.push({ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) });
    }

    (mapping.buttons ?? []).forEach((button, i) => {
        const index = String(button.index ?? i);
        const text = fill(button, context);
        if (!text) missing.push(`button ${index}`);
        const quick = button.subType === 'quick_reply';
        components.push({
            type: 'button',
            sub_type: quick ? 'quick_reply' : 'url',
            index,
            parameters: [quick ? { type: 'payload', payload: text } : { type: 'text', text }],
        });
    });

    return {
        name,
        language: String(stored.language ?? '').trim() || DEFAULT_TEMPLATE_LANGUAGE,
        components,
        bodyParams,
        missing,
    };
}

/** The approved body with its {{n}} filled in: what history and previews show. */
export function renderTemplateText(stored, resolved) {
    const body = String(stored?.body ?? '');
    if (!body.trim()) return `[template ${resolved.name}]`;
    return body.replace(SLOT, (match, n) => resolved.bodyParams[Number(n) - 1] || match);
}

/**
 * The transport object minus bookkeeping, plus the rendered text.
 * Convenience for callers that want both in one go.
 */
export function prepareTemplateSend(stored, context = {}, params = null) {
    const resolved = resolveTemplate(stored, context, params);
    const { name, language, components, missing } = resolved;
    return { template: { name, language, components }, text: renderTemplateText(stored, resolved), missing };
}

/**
 * Look up a stored template for an approved-template send and refuse what
 * Meta would refuse: not a Cloud API channel, not approved, no Meta name.
 * Returns null for no id, else the `{ template, params }` the manager takes.
 * Throws TemplateError (with `.status`) for a route to turn into JSON.
 */
export function metaTemplateFor(templates, channel, id, params = null) {
    if (id == null || id === '') return null;
    const stored = templates?.get(id);
    if (!stored) throw new TemplateError('template not found', 404);
    const problems = compatibility({ ...stored, templateType: 'provider_template' }, channel);
    if (problems.length) {
        throw new TemplateError(`This template cannot be sent as a Meta template: ${problems.join('; ')}`, 409);
    }
    return { template: stored, params: params && typeof params === 'object' ? params : null };
}
