/**
 * The one way out.
 *
 * Every feature that sends a WhatsApp message goes through `send(job)`:
 * campaigns, auto-replies, payment reminders, and the workflow engine when it
 * arrives.  The service owns the checks that must not be skippable by a caller
 * - opt-out, channel capability, idempotency - and then hands the job to the
 * campaign manager, which owns the queue, pacing, rate limit and retries.
 *
 * The manager was already that pipeline for campaigns.  Phase 3 did not build a
 * second one; it made everything else use this one.
 */

import { Status } from '../protocol.js';
import { MessageJobError, messageJob } from './job.js';

/** Traffic a human takeover silences. Everything else is a person acting. */
const AUTOMATIC_TYPES = new Set(['auto_reply', 'workflow', 'campaign', 'reminder']);

export class MessageService {
    /**
     * @param {object} db     a channel-scoped database handle
     * @param {object} manager the channel's CampaignManager
     * @param {() => object} channel reads the live channel row
     */
    constructor(db, manager, channel, { isBotPaused = null } = {}) {
        this.db = db;
        this.manager = manager;
        this.readChannel = typeof channel === 'function' ? channel : () => channel;
        // Human takeover (Phase 8). Guarding here rather than in the auto-reply
        // engine and again in the workflow engine means every automatic path is
        // covered by one check, and a new automatic path cannot forget it.
        this.isBotPaused = isBotPaused;
        this.counts = { accepted: 0, duplicate: 0, suppressed: 0, rejected: 0 };
    }

    /**
     * Accept a job for delivery.
     *
     * @returns {{ accepted: boolean, messageId: string|null, reason: string|null,
     *             duplicateOf: string|null }}
     */
    send(input) {
        const channel = this.readChannel();
        const job = input.idempotencyKey && input.priority !== undefined
            ? input
            : messageJob({ ...input, tenantId: input.tenantId ?? this.db.tenantId, channelId: input.channelId ?? channel.id });

        if (job.channelId !== channel.id) {
            throw new MessageJobError(`job is addressed to channel ${job.channelId}, not ${channel.id}`, 409);
        }
        if (channel.status !== 'active') {
            return this.#reject('channel_disabled', `channel ${channel.id} is disabled`);
        }
        if (!channel.capabilities.includes(capabilityFor(job.messageType))) {
            return this.#reject('capability_disabled',
                `channel ${channel.id} is not enabled for ${capabilityFor(job.messageType)}`);
        }

        // Idempotency before opt-out: a redelivered webhook must get the same
        // answer it got the first time, not a fresh suppression.
        const existing = this.db.findByIdempotencyKey(job.idempotencyKey);
        if (existing) {
            this.counts.duplicate += 1;
            return { accepted: false, messageId: existing.messageId, reason: 'duplicate', duplicateOf: existing.messageId };
        }

        // Opt-out is enforced here so no caller can route around it.
        if (this.db.isOptedOut?.(job.recipient)) {
            this.counts.suppressed += 1;
            return { accepted: false, messageId: null, reason: 'opted_out', duplicateOf: null };
        }

        // While a human has taken the conversation, the bot stays quiet. Only
        // automatic traffic is muted: a human replying from the inbox sends
        // `transactional`, which is the whole point of taking over.
        if (AUTOMATIC_TYPES.has(job.messageType) && this.isBotPaused?.(job.recipient, channel.id)) {
            this.counts.suppressed += 1;
            return { accepted: false, messageId: null, reason: 'bot_paused', duplicateOf: null };
        }

        const messageId = this.manager.enqueueJob(job);
        if (!messageId) {
            // The queue rejected it as a duplicate of something already waiting.
            this.counts.duplicate += 1;
            return { accepted: false, messageId: null, reason: 'duplicate', duplicateOf: null };
        }
        this.counts.accepted += 1;
        return { accepted: true, messageId, reason: null, duplicateOf: null };
    }

    /** Queue depth and outcomes, for the observability endpoint. */
    snapshot() {
        const stats = this.manager.statsSnapshot();
        return {
            channelId: this.readChannel().id,
            pending: stats.pending,
            state: stats.state,
            inFlight: this.manager.inFlight ?? 0,
            byType: this.manager.pendingByType(),
            counts: { ...this.counts },
            totals: {
                total: stats.total,
                successful: stats.successful,
                failed: stats.failed,
                processed: stats.processed,
                skippedOptOut: stats.skippedOptOut,
                duplicates: stats.duplicates,
            },
            statuses: this.db.countsByStatus(null, this.readChannel().id),
            quota: stats.safety,
        };
    }

    #reject(reason, detail) {
        this.counts.rejected += 1;
        const err = new MessageJobError(detail, 409);
        err.reason = reason;
        throw err;
    }
}

/** Which channel capability a kind of traffic needs. */
export function capabilityFor(messageType) {
    switch (messageType) {
        case 'campaign': return 'campaigns';
        case 'auto_reply': return 'auto_replies';
        case 'workflow': return 'workflow_messages';
        case 'reminder':
        case 'transactional':
        default: return 'transactional_messages';
    }
}

export { Status };
