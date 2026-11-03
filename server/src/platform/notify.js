/**
 * Wapzo's own WhatsApp number: the platform messaging its clients ("we got your request", "your plan was renewed",
 * "your plan ends in 3 days"). The number is linked by QR like any business's, on a hidden system tenant
 * (Tenancy.systemTenant), so linking, sending, warm-up levels and the ban guard are the ones every number has.
 *
 * Nothing here ever throws into the caller: a platform event (a lead, a payment) must never fail because the
 * Wapzo number is unlinked or a client gave a bad number. Each message has an idempotency key, so a retried request
 * or a second daily check sends it once.
 */

import { PhoneError, normalizePhone } from '../protocol.js';
import { MessageJobError } from '../messaging/job.js';

export const PLATFORM_MESSAGES_SCHEMA = `
-- The text and on/off switch of each message Wapzo's own number sends (platform/notify.js); no row = the default.
CREATE TABLE IF NOT EXISTS platform_messages (
    kind       TEXT PRIMARY KEY,
    enabled    INTEGER NOT NULL DEFAULT 1,
    text       TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`;

/** Every event Wapzo writes to a client about, in the order the admin page lists them, with its default text. */
export const PLATFORM_EVENTS = Object.freeze([
    {
        kind: 'lead_received', label: 'Request received', when: 'Someone sends the "Ask for your account" form.',
        text: 'Hi {name}, thanks for asking for a Wapzo account for {business}. We will set it up and write to you within one working day.',
    },
    {
        kind: 'account_activated', label: 'Account ready', when: 'You activate a business.',
        text: 'Hi {name}, your Wapzo account for {business} is ready. Sign in with {email} at {link}. The password is in your email.',
    },
    {
        kind: 'plan_started', label: 'Plan started', when: 'A business is put on a new plan.',
        text: 'Hi {name}, {business} is now on the {plan} plan{amount_text}. It renews on {date}.',
    },
    {
        kind: 'plan_renewed', label: 'Plan renewed', when: 'A plan is renewed.',
        text: 'Hi {name}, your {plan} plan for {business} has been renewed{amount_text}. Next renewal: {date}.',
    },
    {
        kind: 'topup_added', label: 'Top-up added', when: 'Days or messages are topped up.',
        text: 'Hi {name}, we added {topup} to {business}{amount_text}. Your plan now runs until {date}.',
    },
    {
        kind: 'payment_received', label: 'Payment received', when: 'You record a payment.',
        text: 'Hi {name}, we received {amount} for {business}. Thank you! Still due: {due}.',
    },
    {
        kind: 'plan_ending', label: 'Plan ending soon', when: '3 days before a plan or trial ends.',
        text: 'Hi {name}, the {plan} plan for {business} ends on {date} ({days} days left). Reply here to renew.',
    },
    {
        kind: 'plan_expired', label: 'Plan ended', when: 'The day a plan or trial ends.',
        text: 'Hi {name}, the {plan} plan for {business} ended on {date}. Sending is paused after 7 days of grace. Reply here to renew.',
    },
]);

const EVENT = new Map(PLATFORM_EVENTS.map((e) => [e.kind, e]));
const MAX_TEXT = 1000;

/** `{word}` filled from `vars`; an unknown or empty one is dropped, and the spaces it leaves are tidied. */
export function renderText(text, vars = {}) {
    return String(text)
        .replace(/\{(\w+)\}/g, (_, key) => (vars[key] === undefined || vars[key] === null ? '' : String(vars[key])))
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ ([,.!?])/g, '$1')
        .trim();
}

export class PlatformMessages {
    /** @param {import('node:sqlite').DatabaseSync} raw the platform-wide connection */
    constructor(raw) {
        this.db = raw;
    }

    list() {
        const rows = new Map(this.db.prepare('SELECT * FROM platform_messages').all().map((r) => [r.kind, r]));
        return PLATFORM_EVENTS.map((e) => {
            const row = rows.get(e.kind);
            return {
                kind: e.kind, label: e.label, when: e.when, defaultText: e.text,
                enabled: row ? Boolean(row.enabled) : true, text: row?.text ?? e.text,
            };
        });
    }

    get(kind) {
        return this.list().find((m) => m.kind === kind) ?? null;
    }

    /** One event's switch and/or text; an empty text goes back to the default. */
    save(kind, { enabled, text } = {}) {
        const current = this.get(kind);
        if (!current) return null;
        const nextText = text === undefined ? current.text : (String(text).trim().slice(0, MAX_TEXT) || EVENT.get(kind).text);
        const nextOn = enabled === undefined ? current.enabled : Boolean(enabled);
        this.db.prepare(`INSERT INTO platform_messages (kind, enabled, text, updated_at) VALUES (?, ?, ?, ?)
                         ON CONFLICT (kind) DO UPDATE SET enabled = excluded.enabled, text = excluded.text,
                         updated_at = excluded.updated_at`)
            .run(kind, nextOn ? 1 : 0, nextText, new Date().toISOString());
        return this.get(kind);
    }
}

/**
 * @param {object} deps
 * @param {import('../tenancy.js').Tenancy} deps.tenancy
 * @param {(tenantId: number) => object} deps.runtimeFor the app's per-tenant runtime (createTenantRuntime)
 * @param {PlatformMessages} deps.templates
 */
export function createNotifier({ tenancy, runtimeFor, templates }) {
    /** The system number's live state, or null while there is no system tenant yet. */
    const systemState = () => {
        const system = tenancy.systemTenant();
        if (!system) return null;
        const runtime = runtimeFor(system.id);
        const channel = runtime.channels.getDefault();
        return channel ? runtime.runtimeFor(channel).state : null;
    };

    /** One message from the Wapzo number. Returns what happened; never throws. */
    const send = ({ to, text, key, kind = 'test', messageType = 'transactional', media = null }) => {
        try {
            if (!String(to ?? '').trim()) return { sent: false, reason: 'No WhatsApp number on file.' };
            const state = systemState();
            if (!state?.transport?.isConnected?.()) return { sent: false, reason: 'The Wapzo WhatsApp number is not linked.' };
            const recipient = normalizePhone(to, state.config.defaultCountryCode || '91');
            const outcome = state.messages.send({
                messageType, recipient, text, media, idempotencyKey: key, campaignId: `wapzo:${kind}`,
            });
            if (outcome.accepted) state.manager.start();
            return outcome.accepted
                ? { sent: true, messageId: outcome.messageId, recipient }
                : { sent: false, reason: outcome.reason === 'duplicate' ? 'Already sent.' : outcome.reason, recipient };
        } catch (err) {
            if (err instanceof PhoneError || err instanceof MessageJobError) return { sent: false, reason: err.message };
            console.warn(`[wapzo] ${kind} to ${to} failed: ${err.message}`);
            return { sent: false, reason: 'Could not send.' };
        }
    };

    /**
     * A platform event for a client: the event's text, filled in, if it is switched on and (for a business) the
     * business still wants Wapzo's updates.
     */
    const event = (kind, { to, vars = {}, tenantId = null, key }) => {
        const message = templates.get(kind);
        if (!message?.enabled) return { sent: false, reason: 'This message is switched off.' };
        if (tenantId != null && tenancy.getTenant(tenantId)?.wapzoUpdates === false) {
            return { sent: false, reason: 'This business does not get Wapzo updates.' };
        }
        return send({ to, text: renderText(message.text, vars), key, kind });
    };

    return { send, event, systemState };
}
