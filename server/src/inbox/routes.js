/**
 * Inbox routes: the agent-facing half of the inbox.
 *
 * Mounted inside a channel runtime, so `db` is already channel-scoped and
 * `state` carries the channel's message service.  Replies go out through
 * `state.messages.send` like everything else - there is no second send path
 * just because a human typed the text.
 *
 * The older `/inbox/*` endpoints in app.js stay: they answer "what came in",
 * grouped by sender, straight off `inbound_messages`.  These answer "what is
 * open, whose is it, and has anyone replied", which is conversation state and
 * needs a row of its own.
 */

import express from 'express';

import { MessageJobError, uniqueKey } from '../messaging/job.js';
import { ConversationStore, InboxError } from './store.js';

export function createInboxRouter({ db, state }) {
    const router = express.Router();
    // One store per router; it is a thin view over the shared connection.
    const conversations = state.conversations ?? new ConversationStore(db);
    state.conversations = conversations;

    const fail = (res, err) => {
        if (err instanceof InboxError || err instanceof MessageJobError) {
            return res.status(err.status ?? 400).json({ errors: [err.message] });
        }
        throw err;
    };

    /** Everything that follows works on one conversation; resolve it once. */
    const resolve = (req, res) => {
        const conversation = conversations.get(req.params.id);
        // A guessed id belonging to another tenant is simply absent here: the
        // store scopes every read, so this is a 404 and not a leak.
        if (!conversation) {
            res.status(404).json({ errors: ['conversation not found'] });
            return null;
        }
        return conversation;
    };

    router.get('/conversations', (req, res) => {
        res.json({
            conversations: conversations.list({
                status: req.query.status || null,
                assignedTo: req.query.assignedTo,
                unread: req.query.unread === 'true' || req.query.unread === '1',
                search: req.query.search || null,
                limit: req.query.limit,
            }),
        });
    });

    router.get('/inbox/stats', (req, res) => res.json({ stats: conversations.stats() }));

    router.get('/conversations/:id', (req, res) => {
        const conversation = resolve(req, res);
        if (conversation) res.json({ conversation, notes: conversations.notes(conversation.id) });
    });

    router.get('/conversations/:id/thread', (req, res) => {
        const conversation = resolve(req, res);
        if (!conversation) return undefined;
        return res.json({
            conversation,
            thread: conversations.thread(conversation.id, { limit: req.query.limit }),
        });
    });

    router.post('/conversations/:id/reply', (req, res) => {
        const conversation = resolve(req, res);
        if (!conversation) return undefined;
        const { text = '', media = null } = req.body ?? {};
        if (!String(text).trim() && !media) {
            return res.status(400).json({ errors: ['a reply needs text or media'] });
        }
        try {
            const outcome = state.messages.send({
                messageType: 'transactional',
                recipient: conversation.phone,
                text: String(text),
                media,
                contactId: conversation.contactId,
                conversationId: conversation.id,
                // An agent sending "ok" twice means two messages, so the key is
                // per call rather than derived from the text.
                idempotencyKey: req.body?.idempotencyKey || uniqueKey('inbox'),
            });
            if (!outcome.accepted) {
                return res.status(409).json({ errors: [outcome.reason ?? 'reply was not accepted'], ...outcome });
            }
            // A human answering is also a human reading.
            conversations.markRead(conversation.id);
            const updated = conversations.touchOutbound(conversation.id);
            state.broadcast?.({ type: 'conversation', action: 'reply', conversation: updated, messageId: outcome.messageId });
            return res.json({ conversation: updated, messageId: outcome.messageId });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.post('/conversations/:id/assign', (req, res) => {
        const conversation = resolve(req, res);
        if (!conversation) return undefined;
        try {
            const { userId } = req.body ?? {};
            const updated = userId == null || userId === ''
                ? conversations.unassign(conversation.id)
                : conversations.assign(conversation.id, userId);
            state.broadcast?.({ type: 'conversation', action: 'assign', conversation: updated });
            return res.json({ conversation: updated });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.post('/conversations/:id/status', (req, res) => {
        const conversation = resolve(req, res);
        if (!conversation) return undefined;
        try {
            const updated = conversations.setStatus(conversation.id, req.body?.status);
            state.broadcast?.({ type: 'conversation', action: 'status', conversation: updated });
            return res.json({ conversation: updated });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.post('/conversations/:id/read', (req, res) => {
        const conversation = resolve(req, res);
        if (conversation) res.json({ conversation: conversations.markRead(conversation.id) });
    });

    router.post('/conversations/:id/tags', (req, res) => {
        const conversation = resolve(req, res);
        if (!conversation) return undefined;
        try {
            const { add = [], remove = [] } = req.body ?? {};
            let updated = conversation;
            for (const tag of add) updated = conversations.addTag(conversation.id, tag);
            for (const tag of remove) updated = conversations.removeTag(conversation.id, tag);
            return res.json({ conversation: updated });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.get('/conversations/:id/notes', (req, res) => {
        const conversation = resolve(req, res);
        if (conversation) res.json({ notes: conversations.notes(conversation.id) });
    });

    router.post('/conversations/:id/notes', (req, res) => {
        const conversation = resolve(req, res);
        if (!conversation) return undefined;
        try {
            return res.status(201).json({
                note: conversations.addNote(conversation.id, req.user?.id ?? null, req.body?.body),
            });
        } catch (err) {
            return fail(res, err);
        }
    });

    /** Human takeover: mute the bot for this conversation. */
    router.post('/conversations/:id/takeover', (req, res) => {
        const conversation = resolve(req, res);
        if (!conversation) return undefined;
        // Taking over means this is yours unless the caller says otherwise.
        const assignTo = req.body?.userId ?? req.user?.id ?? null;
        let updated = conversations.pauseBot(conversation.id);
        if (assignTo != null) updated = conversations.assign(conversation.id, assignTo);
        state.broadcast?.({ type: 'conversation', action: 'takeover', conversation: updated });
        return res.json({ conversation: updated });
    });

    /** Hand the conversation back to the bot. */
    router.post('/conversations/:id/handback', (req, res) => {
        const conversation = resolve(req, res);
        if (!conversation) return undefined;
        const updated = conversations.resumeBot(conversation.id);
        state.broadcast?.({ type: 'conversation', action: 'handback', conversation: updated });
        return res.json({ conversation: updated });
    });

    return router;
}
