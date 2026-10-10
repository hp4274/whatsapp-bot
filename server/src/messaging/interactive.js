/**
 * Interactive messages (reply buttons, call-to-action buttons, list menus): one
 * shape for every transport. The Cloud API sends them natively; WhatsApp Web
 * (whatsapp-web.js, Baileys) cannot reliably send buttons any more, so those
 * transports render `fallbackText` - a numbered menu the recipient answers by
 * typing the number or the button title - and `matchReply` turns that typed
 * answer back into the button the recipient meant.
 *
 * Shape (all strings may contain {placeholders}, personalised per recipient
 * before the message is queued):
 *   {
 *     type: 'buttons' | 'cta' | 'list',
 *     header?: string, footer?: string,
 *     buttons?: [{ id, title, payload? }]            // type 'buttons': 1-3, title <= 20 chars
 *     cta?: [{ kind: 'url'|'call'|'copy', title, value }]  // type 'cta': 1-2 url/call, or 1 copy
 *     list?: { button: string, sections: [{ title, rows: [{ id, title, description?, payload? }] }] }  // <= 10 rows total
 *   }
 * `payload` defaults to `id`; it is what reply rules match on (e.g. CONFIRM_ORDER_{order_id}).
 */

import { personalize } from '../protocol.js';

export class InteractiveError extends Error {
    constructor(message) {
        super(message);
        this.status = 400;
    }
}

const NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const clip = (value, max) => String(value ?? '').trim().slice(0, max);
const slug = (value, i) => clip(value, 40).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || `OPTION_${i + 1}`;

/** Validate and clean an interactive block. Returns null for "none". */
export function normalizeInteractive(input) {
    if (!input || typeof input !== 'object' || !input.type || input.type === 'none') return null;
    const type = String(input.type);
    const base = { type, header: clip(input.header, 60) || undefined, footer: clip(input.footer, 60) || undefined };
    if (type === 'buttons') {
        const buttons = (Array.isArray(input.buttons) ? input.buttons : [])
            .map((b, i) => ({ id: clip(b?.id, 40) || slug(b?.title, i), title: clip(b?.title, 20), payload: clip(b?.payload, 200) || undefined }))
            .filter((b) => b.title);
        if (!buttons.length || buttons.length > 3) throw new InteractiveError('Reply buttons need 1 to 3 buttons, each with a title.');
        return { ...base, buttons };
    }
    if (type === 'cta') {
        const cta = (Array.isArray(input.cta) ? input.cta : [])
            .map((c) => ({ kind: ['url', 'call', 'copy'].includes(c?.kind) ? c.kind : 'url', title: clip(c?.title, 20), value: clip(c?.value, 500) }))
            .filter((c) => c.title && c.value);
        if (!cta.length || cta.length > 2) throw new InteractiveError('Call-to-action needs 1 or 2 buttons, each with a title and a link, number or code.');
        return { ...base, cta };
    }
    if (type === 'list') {
        const sections = (Array.isArray(input.list?.sections) ? input.list.sections : [])
            .map((s) => ({
                title: clip(s?.title, 24),
                rows: (Array.isArray(s?.rows) ? s.rows : [])
                    .map((r, i) => ({ id: clip(r?.id, 200) || slug(r?.title, i), title: clip(r?.title, 24), description: clip(r?.description, 72) || undefined, payload: clip(r?.payload, 200) || undefined }))
                    .filter((r) => r.title),
            }))
            .filter((s) => s.rows.length);
        const rows = sections.flatMap((s) => s.rows);
        if (!rows.length || rows.length > 10) throw new InteractiveError('A list menu needs 1 to 10 options.');
        return { ...base, list: { button: clip(input.list?.button, 20) || 'Choose', sections } };
    }
    throw new InteractiveError(`Unknown interactive type "${type}".`);
}

/** Every option a recipient can pick, in display order. */
export function interactiveOptions(interactive) {
    if (!interactive) return [];
    if (interactive.type === 'buttons') return interactive.buttons;
    if (interactive.type === 'list') return interactive.list.sections.flatMap((s) => s.rows);
    return [];
}

/** Personalise every text field of the block for one recipient. */
export function personalizeInteractive(interactive, context) {
    if (!interactive) return null;
    const p = (v) => (v === undefined ? undefined : personalize(String(v), context));
    const out = { ...interactive, header: p(interactive.header), footer: p(interactive.footer) };
    if (interactive.buttons) out.buttons = interactive.buttons.map((b) => ({ ...b, title: p(b.title), payload: p(b.payload ?? b.id) }));
    if (interactive.cta) out.cta = interactive.cta.map((c) => ({ ...c, title: p(c.title), value: p(c.value) }));
    if (interactive.list) {
        out.list = {
            ...interactive.list,
            sections: interactive.list.sections.map((s) => ({
                ...s,
                rows: s.rows.map((r) => ({ ...r, title: p(r.title), description: p(r.description), payload: p(r.payload ?? r.id) })),
            })),
        };
    }
    return out;
}

/**
 * The plain-text rendering for transports without native buttons:
 *
 *   Hello Rahul, your order is ready.
 *
 *   Reply with:
 *   1. Yes, confirm
 *   2. No, reschedule
 */
export function renderFallbackText(text, interactive) {
    const parts = [];
    if (interactive?.header) parts.push(`*${interactive.header}*`);
    parts.push(String(text ?? '').trim());
    const options = interactiveOptions(interactive);
    if (options.length) {
        parts.push(['Reply with:', ...options.map((o, i) => `${NUMBERS[i]}. ${o.title}${o.description ? ` - ${o.description}` : ''}`)].join('\n'));
    }
    if (interactive?.type === 'cta') {
        parts.push(interactive.cta.map((c) => {
            if (c.kind === 'call') return `${c.title}: ${c.value}`;
            if (c.kind === 'copy') return `${c.title}: ${c.value}`;
            return `${c.title}: ${c.value}`;
        }).join('\n'));
    }
    if (interactive?.footer) parts.push(`_${interactive.footer}_`);
    return parts.filter(Boolean).join('\n\n');
}

/**
 * Which option an inbound reply picks: a native button/list reply id, the
 * option number ("1", "1."), or the option title (case-insensitive). Null when
 * the message is not an answer to this menu.
 *
 * @returns {{ id: string, title: string, payload: string, index: number } | null}
 */
export function matchReply(interactive, { body = '', replyId = null } = {}) {
    const options = interactiveOptions(interactive);
    if (!options.length) return null;
    const pick = (o, index) => ({ id: o.id, title: o.title, payload: o.payload ?? o.id, index });
    if (replyId) {
        const index = options.findIndex((o) => o.id === replyId || o.payload === replyId);
        if (index >= 0) return pick(options[index], index);
    }
    const text = String(body).trim().toLowerCase().replace(/[.)\s]+$/, '');
    if (!text) return null;
    const n = Number(text.replace(/^#/, ''));
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return pick(options[n - 1], n - 1);
    const index = options.findIndex((o) => o.title.toLowerCase() === text);
    return index >= 0 ? pick(options[index], index) : null;
}
