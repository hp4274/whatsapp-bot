/**
 * Phase 9 routes. Mounted per channel, so `db` is already channel-scoped and
 * every query in the store is tenant-filtered underneath.
 *
 * Customer notification is opt-in per request (`notify: true`) and only fires
 * on RESOLVED or CLOSED. Messaging a customer automatically on every edit is
 * how a WhatsApp number gets reported and banned, and an agent fixing a typo
 * in a subject line is not news. The caller that genuinely wants to tell the
 * customer says so; everything else is silent.
 */

import express from 'express';

import { TicketError, TicketStore, CLOSED_STATUSES } from './store.js';

/** What we say when a ticket is closed out, unless the caller supplies text. */
const NOTIFY_TEXT = Object.freeze({
    RESOLVED: (t) => `Your ticket ${t.reference} has been resolved. Reply here if you still need help.`,
    CLOSED: (t) => `Your ticket ${t.reference} has been closed. Reply here to reopen it.`,
});

export function createTicketRouter({ db, state }) {
    const router = express.Router();
    const tickets = new TicketStore(db);

    const fail = (res, err) => {
        if (!(err instanceof TicketError)) throw err;
        return res.status(err.status).json({ errors: [err.message] });
    };
    const announce = (type, ticket) => state.broadcast?.({ type, ticket });

    /**
     * Tell the customer, if asked to and if there is a customer to tell.
     * Goes through the message service like everything else, so opt-out,
     * channel capability and idempotency all still apply.
     */
    const notify = (ticket, { text = null, userId = null } = {}) => {
        if (!CLOSED_STATUSES.includes(ticket.status)) return null;
        const contact = ticket.contactId ? state.contacts?.get(ticket.contactId) : null;
        if (!contact?.phone) return null;

        const body = text || NOTIFY_TEXT[ticket.status](ticket);
        const result = state.messages.send({
            messageType: 'transactional',
            recipient: contact.phone,
            name: contact.name,
            text: body,
            contactId: ticket.contactId,
            conversationId: ticket.conversationId,
            metadata: { ticketId: ticket.id, reference: ticket.reference },
            // Same ticket, same status, one message - a double PATCH does not
            // message the customer twice.
            idempotencyKey: `ticket:${ticket.id}:${ticket.status}`,
        });
        tickets.addNote(ticket.id, body, { userId, kind: 'message' });
        return result;
    };

    router.get('/tickets', (req, res) => {
        const q = req.query;
        res.json({
            tickets: tickets.list({
                status: q.status && q.status !== 'ALL' ? q.status : undefined,
                priority: q.priority || undefined,
                assignedTo: q.assignedTo ?? q.assigned_to,
                contactId: q.contactId ?? q.contact_id,
                conversationId: q.conversationId ?? q.conversation_id,
                overdue: q.overdue === 'true' || q.overdue === '1',
                limit: Number(q.limit) || 200,
                offset: Number(q.offset) || 0,
            }),
        });
    });

    // Before /tickets/:id, or 'stats' is read as an id.
    router.get('/tickets/stats', (req, res) => {
        res.json({ stats: tickets.stats() });
    });

    router.post('/tickets', (req, res) => {
        const body = req.body ?? {};
        if (!body.subject && !body.category) {
            return res.status(400).json({ errors: ['a ticket needs a subject or a category'] });
        }
        try {
            const ticket = tickets.create({ ...body, userId: req.user?.id ?? null });
            announce('ticketCreated', ticket);
            return res.status(201).json({ ticket });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.get('/tickets/:id', (req, res) => {
        const ticket = /^\d+$/.test(req.params.id)
            ? tickets.get(req.params.id)
            : tickets.getByReference(req.params.id);
        if (!ticket) return res.status(404).json({ errors: ['ticket not found'] });
        return res.json({ ticket });
    });

    router.patch('/tickets/:id', (req, res) => {
        const { notify: wantsNotify = false, notifyText = null, note = null, ...patch } = req.body ?? {};
        try {
            const userId = req.user?.id ?? null;
            const ticket = tickets.update(req.params.id, patch, { userId, note });
            const sent = wantsNotify ? notify(ticket, { text: notifyText, userId }) : null;
            announce('ticketUpdated', ticket);
            return res.json({ ticket, notified: Boolean(sent?.accepted) });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.post('/tickets/:id/notes', (req, res) => {
        try {
            const event = tickets.addNote(req.params.id, req.body?.body, { userId: req.user?.id ?? null });
            return res.status(201).json({ event });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.get('/tickets/:id/events', (req, res) => {
        try {
            return res.json({ events: tickets.events(req.params.id) });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.post('/tickets/:id/satisfaction', (req, res) => {
        try {
            const ticket = tickets.recordSatisfaction(
                req.params.id, req.body?.score, req.body?.comment ?? '',
                { userId: req.user?.id ?? null },
            );
            announce('ticketUpdated', ticket);
            return res.json({ ticket });
        } catch (err) {
            return fail(res, err);
        }
    });

    return router;
}
