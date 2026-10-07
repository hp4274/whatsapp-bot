/**
 * The message job: one provider-neutral description of something to send.
 *
 * Campaigns, auto-replies, reminders and (later) workflows all produce one of
 * these and hand it to the message service.  Nothing below the service knows
 * which feature asked - that is the point of Phase 3.
 *
 * Every job names its tenant and its channel.  There is no default: a job
 * without both is a bug, not a job (Rule 2 in docs/ARCHITECTURE.md).
 */

import crypto from 'node:crypto';

/** What produced the job. Drives queue priority and shows up in observability. */
export const MESSAGE_TYPES = Object.freeze([
    'campaign',
    'transactional',
    'auto_reply',
    'reminder',
    'workflow',
]);

/**
 * Transactional traffic is a person waiting for an answer; a campaign is a
 * backlog.  A reply queued behind five thousand campaign rows is a broken
 * reply, so the small, prompt kinds jump the queue.
 */
const PRIORITY = Object.freeze({
    auto_reply: 0,
    transactional: 1,
    workflow: 2,
    reminder: 3,
    campaign: 4,
});

export const priorityOf = (type) => PRIORITY[type] ?? PRIORITY.campaign;

export class MessageJobError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/**
 * Build a job. `idempotencyKey` is what makes a retried caller safe: the same
 * key inside one tenant is accepted once and reported as a duplicate after
 * that, whether the retry arrives in a millisecond or a day.
 */
export function messageJob({
    tenantId,
    channelId,
    messageType = 'transactional',
    recipient,
    text = '',
    name = '',
    media = null,
    campaignId = '',
    templateId = null,
    conversationId = null,
    contactId = null,
    metadata = null,
    scheduledAt = null,
    idempotencyKey = null,
}) {
    if (!Number.isInteger(Number(tenantId))) throw new MessageJobError('a job needs a tenantId');
    if (!Number.isInteger(Number(channelId))) throw new MessageJobError('a job needs a channelId');
    if (!MESSAGE_TYPES.includes(messageType)) {
        throw new MessageJobError(`messageType must be one of ${MESSAGE_TYPES.join(', ')}`);
    }
    if (!recipient) throw new MessageJobError('a job needs a recipient');
    if (!text && !media) throw new MessageJobError('a job needs text or media');

    return {
        tenantId: Number(tenantId),
        channelId: Number(channelId),
        messageType,
        direction: 'outbound',
        recipient,
        text,
        name,
        media,
        campaignId,
        templateId,
        conversationId,
        contactId,
        metadata,
        scheduledAt,
        priority: priorityOf(messageType),
        idempotencyKey: idempotencyKey || autoKey({ channelId, messageType, recipient, text, media, campaignId }),
    };
}

/**
 * A key for callers that did not supply one.  It is content-derived, so the
 * same auto-reply to the same number with the same text is one message however
 * many times an inbound webhook is redelivered - which Meta does.
 */
function autoKey({ channelId, messageType, recipient, text, media, campaignId }) {
    const basis = [channelId, messageType, recipient, text, media?.mediaId ?? '', campaignId].join('|');
    return `auto.${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32)}`;
}

/** A key that is unique per call, for traffic that is meant to repeat. */
export const uniqueKey = (prefix = 'job') => `${prefix}.${crypto.randomUUID()}`;
