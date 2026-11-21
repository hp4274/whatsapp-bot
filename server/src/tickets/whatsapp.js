/**
 * Tickets and the WhatsApp chat.
 *
 * - `ticketInbound` (start of handleInbound): a customer's message goes on their open ticket, and a ticket resolved
 *   in the last few days reopens. Returns a mark for `ticketAfterInbound`.
 * - `ticketFromHandoff` (the auto-reply engine's escalate action): the customer asked for a person.
 * - `ticketAfterInbound` (end of handleInbound): a complaint word opens a ticket; the customer is told its
 *   reference only when nothing else answered them, so they never get two messages for one.
 * - `ticketSweep` (moduleSweeps.js): owner alert when a ticket passes its SLA, and auto-close.
 *
 * Opening a ticket needs the business's own switch (Tickets page, off by default) and the platform's
 * `tickets.autoCreate`. None of this may stop a message being handled, so every entry point swallows its errors.
 */

import { hasWord } from '../autoreply/match.js';
import { ownerAlert } from '../moduleSweeps.js';
import { ruleCap } from '../policy/modules.js';
import { deliver } from '../school/routes.js';

const DAY = 86_400_000;
/** A customer writing within this long of a resolution reopens the ticket rather than starting over. */
export const REOPEN_DAYS = 3;
/** SLA breaches older than this are not alerted: a first sweep after an upgrade must not page the owner for history. */
const ALERT_WINDOW_MS = DAY;

const hasService = (state) => state.tenancy?.getTenant?.(state.db.tenantId)?.services?.includes('tickets') ?? true;
const bodyOf = (msg) => String(msg.body ?? '').trim() || '(a photo or file)';
const changed = (state) => state.broadcast?.({ type: 'changed', topic: 'tickets' });
const isoZ = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

function contactOf(state, msg, create = false) {
    const contacts = state.contacts;
    if (!contacts) return null;
    let phone = msg.sender;
    try {
        phone = contacts.normalize(msg.sender, true);
    } catch {
        // not a number the store can normalise; look it up as it came
    }
    const found = contacts.getByPhone(phone) ?? contacts.getByPhone(msg.sender);
    if (found || !create) return found;
    return contacts.upsert({ phone, normalized: true, name: String(msg.senderName ?? '').trim() || undefined, channelId: state.channel?.id });
}

/** Add the message to the contact's open ticket, reopening a recent resolved one. */
export function ticketInbound(state, msg, now = new Date()) {
    let mark = 0;
    try {
        mark = state.db.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM messages').get().n;
        if (!state.tickets || !hasService(state)) return mark;
        const contact = contactOf(state, msg);
        if (!contact) return mark;
        let ticket = state.tickets.openFor(contact.id);
        if (!ticket) {
            const resolved = state.tickets.resolvedSince(contact.id, new Date(now.getTime() - REOPEN_DAYS * DAY));
            if (!resolved) return mark;
            ticket = state.tickets.setStatus(resolved.id, 'OPEN', { note: 'The customer wrote again' });
        }
        state.tickets.addNote(ticket.id, bodyOf(msg), { kind: 'inbound' });
        changed(state);
    } catch (err) {
        console.error('[tickets] could not add an inbound message to a ticket:', err.message);
    }
    return mark;
}

/** The auto-reply handoff fired: the customer asked for a person. */
export function ticketFromHandoff(state, msg) {
    try {
        open(state, msg, 'Asked for a person');
    } catch (err) {
        console.error('[tickets] could not open a ticket for a handoff:', err.message);
    }
}

/** A complaint word opens a ticket; the reference goes out only if no reply was sent since `mark`. */
export function ticketAfterInbound(state, msg, mark = 0) {
    try {
        if (!state.tickets || !String(msg.body ?? '').trim()) return null;
        if (!hasWord(msg.body, state.tickets.settings().keywords)) return null;
        const ticket = open(state, msg, 'Complaint word');
        if (!ticket) return null;
        const replied = state.db.db.prepare('SELECT 1 FROM messages WHERE rowid > ? AND recipient = ? LIMIT 1').get(mark, msg.sender);
        if (!replied) {
            deliver(state, {
                recipient: msg.sender, messageType: 'auto_reply', key: `ticket.ack.${ticket.id}`,
                text: `Thanks, we have noted this as ticket ${ticket.reference}. Our team will reply here.`,
            });
        }
        return ticket;
    } catch (err) {
        console.error('[tickets] could not open a ticket from a keyword:', err.message);
        return null;
    }
}

/** A new WhatsApp ticket, or null when switched off, capped, or the contact already has one open. */
function open(state, msg, reason) {
    if (!state.tickets || !hasService(state)) return null;
    const policy = state.platformPolicy?.() ?? {};
    const settings = state.tickets.settings();
    if (policy['tickets.autoCreate'] === false || !settings.autoCreate) return null;
    const contact = contactOf(state, msg, true);
    // One open ticket per contact: ticketInbound already put this message on it.
    if (!contact || state.tickets.openFor(contact.id)) return null;
    const cap = ruleCap(policy, 'tickets.maxOpen');
    if (cap && state.tickets.countOpen() >= cap) return null;

    const body = bodyOf(msg);
    const ticket = state.tickets.create({
        contactId: contact.id,
        conversationId: state.conversations?.getByPhone?.(msg.sender, state.channel?.id)?.id ?? null,
        source: 'whatsapp',
        subject: body.length > 120 ? `${body.slice(0, 117)}...` : body,
        metadata: { messageId: msg.messageId ?? null, reason },
    });
    state.tickets.addNote(ticket.id, body, { kind: 'inbound' });
    if (settings.ownerAlerts) {
        ownerAlert(state, `New ticket ${ticket.reference} from ${contact.name || contact.phone}: ${ticket.subject}`, `ticket.new.${ticket.id}`);
    }
    changed(state);
    return ticket;
}

/** Each minute: alert the owner once per ticket past its SLA, and close resolved tickets left alone long enough. */
export function ticketSweep(state, now = new Date()) {
    const tickets = state.tickets;
    if (!tickets) return;
    if (tickets.settings().ownerAlerts) {
        const since = now.getTime() - ALERT_WINDOW_MS;
        for (const t of tickets.overdue(isoZ(now))) {
            if (Date.parse(t.slaDueAt) < since) continue;
            ownerAlert(state, `Ticket ${t.reference} is past its response time: ${t.subject || t.category || 'no subject'}`, `ticket.sla.${t.id}`);
        }
    }
    const days = ruleCap(state.platformPolicy?.() ?? {}, 'tickets.autoCloseDays');
    if (!days) return;
    const stale = tickets.resolvedBefore(new Date(now.getTime() - days * DAY));
    for (const t of stale) tickets.close(t.id, { note: `Closed: no reply for ${days} day${days === 1 ? '' : 's'} after it was resolved` });
    if (stale.length) changed(state);
}
