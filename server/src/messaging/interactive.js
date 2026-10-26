/**
 * Interactive messages (reply buttons, call-to-action buttons, list menus): one
 * shape for every transport. Baileys (QR numbers) and the fallback paths render `renderFallbackText` - a menu the
 * recipient answers by typing the number or the button title, which shows on
 * every device - and `matchReply` turns that typed answer (or a native tap id)
 * back into the option.
 *
 * Shape (all strings may contain {placeholders}, personalised per recipient
 * before the message is queued):
 *   {
 *     type: 'buttons' | 'cta' | 'list' | 'carousel',
 *     header?: string, footer?: string,                // not used by carousels
 *     buttons?: [{ id, title, payload? }]            // type 'buttons': 1-3, title <= 20 chars
 *     cta?: [{ kind: 'url'|'call'|'copy', title, value }]  // type 'cta': 1-2 url/call, or 1 copy
 *     list?: { button: string, sections: [{ title, rows: [{ id, title, description?, payload? }] }] }  // <= 10 rows total
 *     carousel?: { kind: 'url'|'reply', cards: [{      // type 'carousel' (campaigns only): 2-5 cards, all of one kind
 *       mediaId, mediaUrl?, text,                      // image required, text <= 160 chars
 *       buttons?: [{ id, title, payload? }]            // kind 'reply': 1-2 per card, title <= 20; default id = SLUG_<card no>
 *       cta?: [{ kind: 'url', title, value }]          // kind 'url': exactly 1 per card
 *     }] }
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

/**
 * Validate and clean an interactive block. Returns null for "none".
 * `carousel`: campaigns opt in; templates, auto-replies and API sends refuse carousels.
 * `keepMedia`: only the campaign manager, whose cards the store already resolved to files; never user input.
 */
export function normalizeInteractive(input, { carousel = false, keepMedia = false } = {}) {
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
    if (type === 'carousel') {
        if (!carousel) throw new InteractiveError('Carousels are only available in campaigns.');
        const kind = input.carousel?.kind;
        if (kind !== 'url' && kind !== 'reply') throw new InteractiveError('A carousel needs link buttons or quick reply buttons.');
        const raw = Array.isArray(input.carousel.cards) ? input.carousel.cards : [];
        if (raw.length < 2 || raw.length > 5) throw new InteractiveError('A carousel needs 2 to 5 cards.');
        const cards = raw.map((c, i) => {
            const card = { mediaId: clip(c?.mediaId, 100), mediaUrl: clip(c?.mediaUrl, 500) || undefined, text: clip(c?.text, 160) };
            if (!card.mediaId) throw new InteractiveError(`Card ${i + 1} needs an image.`);
            if (keepMedia && c.media) card.media = c.media;
            if (kind === 'reply') {
                // The card number keeps "Buy" on two cards distinct.
                card.buttons = (Array.isArray(c.buttons) ? c.buttons : [])
                    .map((b, j) => ({ id: clip(b?.id, 40) || `${slug(b?.title, j)}_${i + 1}`, title: clip(b?.title, 20), payload: clip(b?.payload, 200) || undefined }))
                    .filter((b) => b.title);
                if (!card.buttons.length || card.buttons.length > 2) throw new InteractiveError(`Card ${i + 1} needs 1 or 2 quick reply buttons, each with a title.`);
            } else {
                card.cta = (Array.isArray(c.cta) ? c.cta : [])
                    .map((b) => ({ kind: 'url', title: clip(b?.title, 20), value: clip(b?.value, 500) }))
                    .filter((b) => b.title && b.value);
                if (card.cta.length !== 1) throw new InteractiveError(`Card ${i + 1} needs one link button with a title and a link.`);
            }
            return card;
        });
        return { ...base, header: undefined, footer: undefined, carousel: { kind, cards } };
    }
    throw new InteractiveError(`Unknown interactive type "${type}".`);
}

/** Every option a recipient can pick, in display order. */
export function interactiveOptions(interactive) {
    if (!interactive) return [];
    if (interactive.type === 'buttons') return interactive.buttons;
    if (interactive.type === 'list') return interactive.list.sections.flatMap((s) => s.rows);
    if (interactive.type === 'carousel') return interactive.carousel.cards.flatMap((c) => c.buttons ?? []);
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
    if (interactive.carousel) {
        out.carousel = {
            ...interactive.carousel,
            cards: interactive.carousel.cards.map((c) => ({
                ...c,
                text: p(c.text),
                ...(c.buttons ? { buttons: c.buttons.map((b) => ({ ...b, title: p(b.title), payload: p(b.payload ?? b.id) })) } : {}),
                ...(c.cta ? { cta: c.cta.map((x) => ({ ...x, title: p(x.title), value: p(x.value) })) } : {}),
            })),
        };
    }
    return out;
}

const CTA_ICON = { url: '🔗', call: '📞', copy: '📋' };

/**
 * The plain-text rendering for transports (or phones) without native buttons.
 * Each type reads differently so customers can tell them apart:
 *
 *   buttons  "Reply 1 or 2:" then the numbered options
 *   cta      one "🔗 Title: https://..." / "📞 ..." / "📋 ..." line per button
 *   list     *Menu title*, then each section with rows numbered across sections
 *
 * Numbers run across the whole menu because matchReply() maps "3" to the third option overall.
 */
export function renderFallbackText(text, interactive) {
    if (interactive?.type === 'carousel') return [String(text ?? '').trim(), ...carouselCaptions(interactive)].filter(Boolean).join('\n\n');
    const parts = [];
    if (interactive?.header) parts.push(`*${interactive.header}*`);
    parts.push(String(text ?? '').trim());
    if (interactive?.type === 'buttons') {
        const nums = interactive.buttons.map((_, i) => NUMBERS[i]);
        const ask = nums.length > 1 ? `${nums.slice(0, -1).join(', ')} or ${nums.at(-1)}` : nums[0];
        parts.push([`Reply ${ask}:`, ...interactive.buttons.map((o, i) => `${nums[i]}. ${o.title}`)].join('\n'));
    } else if (interactive?.type === 'cta') {
        parts.push(interactive.cta.map((c) => `${CTA_ICON[c.kind] ?? CTA_ICON.url} ${c.title}: ${c.value}`).join('\n'));
    } else if (interactive?.type === 'list') {
        let n = 0;
        const sections = interactive.list.sections.map((s) => [
            ...(s.title ? [`_${s.title}_`] : []),
            ...s.rows.map((r) => `${NUMBERS[n++]}. ${r.title}${r.description ? ` - ${r.description}` : ''}`),
        ].join('\n'));
        parts.push([`*${interactive.list.button}*`, ...sections].join('\n\n'));
    }
    if (interactive?.footer) parts.push(`_${interactive.footer}_`);
    return parts.filter(Boolean).join('\n\n');
}

/**
 * One caption per carousel card: its text, then "Reply 3 or 4:" with the card's buttons or a
 * "🔗 Title: url" line. Reply numbers run across ALL cards so matchReply("3") finds the third button overall.
 */
export function carouselCaptions(interactive) {
    if (interactive?.type !== 'carousel') return [];
    let n = 0;
    return interactive.carousel.cards.map((card) => {
        let lines = '';
        if (card.buttons) {
            const nums = card.buttons.map(() => String(++n));
            const ask = nums.length > 1 ? `${nums.slice(0, -1).join(', ')} or ${nums.at(-1)}` : nums[0];
            lines = [`Reply ${ask}:`, ...card.buttons.map((b, i) => `${nums[i]}. ${b.title}`)].join('\n');
        } else if (card.cta) {
            lines = card.cta.map((c) => `${CTA_ICON.url} ${c.title}: ${c.value}`).join('\n');
        }
        return [String(card.text ?? '').trim(), lines].filter(Boolean).join('\n\n');
    });
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
