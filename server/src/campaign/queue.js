/** FIFO message queue with pause / resume / stop and duplicate protection. */

import { dedupeKey, newMessageId } from '../protocol.js';

export const QueueState = Object.freeze({
    RUNNING: 'RUNNING',
    PAUSED: 'PAUSED',
    STOPPED: 'STOPPED',
});

export function queueItem({
    recipient, message, name = '', campaignId = '', media = null,
    messageType = 'campaign', priority = 4, idempotencyKey = null, interactive = null,
    variant = null, timezone = null,
}) {
    return {
        recipient,
        message,
        name,
        campaignId,
        media,
        interactive,
        // A/B campaigns: the version ('A' | 'B' | 'C') this recipient got.
        variant,
        // The contact's own IANA zone (humanize.js contactZone): their daytime, not their country code's.
        timezone,
        messageType,
        priority,
        idempotencyKey,
        messageId: newMessageId(),
        attempt: 0,
        // A job's idempotency key already says what counts as "the same message"
        // (the message service checks it); content is the key only for campaign rows.
        get key() {
            if (this.idempotencyKey) return this.idempotencyKey;
            return dedupeKey(this.recipient, `${this.message}|${this.media?.mediaId ?? ''}`);
        },
    };
}

export class MessageQueue {
    /**
     * @param {boolean} dedupe reject an item that was already queued
     * @param {boolean} onePerRecipient key on the number alone, so one number
     *   gets one message however many rows (or names) it appears under
     */
    constructor({ dedupe = true, onePerRecipient = false } = {}) {
        this.items = [];
        this.seen = new Set();
        this.dedupe = dedupe;
        this.onePerRecipient = onePerRecipient;
        this.state = QueueState.RUNNING;
        this.duplicatesRejected = 0;
    }

    get isStopped() {
        return this.state === QueueState.STOPPED;
    }

    get isPaused() {
        return this.state === QueueState.PAUSED;
    }

    pause() {
        if (this.state === QueueState.RUNNING) this.state = QueueState.PAUSED;
    }

    resume() {
        if (this.state === QueueState.PAUSED) this.state = QueueState.RUNNING;
    }

    /** Stop for good and drop everything still waiting. */
    stop() {
        const dropped = this.items;
        this.state = QueueState.STOPPED;
        this.items = [];
        return dropped;
    }

    /**
     * Make a stopped queue usable again (new campaign, clean dedupe set).
     * `keepOneOff`: a campaign starting replaces only campaign rows; a reply or
     * a quick send still waiting is someone's message, so it keeps its place.
     */
    reset({ keepOneOff = false } = {}) {
        this.items = keepOneOff ? this.items.filter((i) => (i.messageType ?? 'campaign') !== 'campaign') : [];
        this.seen.clear();
        this.duplicatesRejected = 0;
        this.state = QueueState.RUNNING;
    }

    /**
     * Insert an item by priority. Returns false when it was rejected as a
     * duplicate.
     *
     * Lower `priority` goes first, and items of equal priority keep FIFO order,
     * so a reply never waits behind a campaign backlog while two campaigns
     * still drain in the order they were queued.
     */
    put(item) {
        if (this.isStopped) return false;
        if (this.dedupe) {
            const key = this.onePerRecipient ? item.recipient : item.key;
            if (this.seen.has(key)) {
                this.duplicatesRejected += 1;
                return false;
            }
            this.seen.add(key);
        }
        const priority = item.priority ?? 4;
        // ponytail: linear scan from the back. The queue is a few thousand
        // items at worst; a heap only pays off well past that.
        let at = this.items.length;
        while (at > 0 && (this.items[at - 1].priority ?? 4) > priority) at -= 1;
        this.items.splice(at, 0, item);
        return true;
    }

    /**
     * Re-insert an item that was already taken (no dedupe) at the head of its
     * priority band: it keeps its turn, but a higher-priority reply still wins.
     */
    putBack(item) {
        if (this.isStopped) return;
        const priority = item.priority ?? 4;
        const at = this.items.findIndex((other) => (other.priority ?? 4) >= priority);
        this.items.splice(at === -1 ? this.items.length : at, 0, item);
    }

    /** How many items of each message type are waiting. */
    pendingByType() {
        const counts = {};
        for (const item of this.items) {
            const type = item.messageType ?? 'campaign';
            counts[type] = (counts[type] ?? 0) + 1;
        }
        return counts;
    }

    /** Put an item back at the head (used when a retry is deferred). */
    putFront(item) {
        if (this.isStopped) return;
        this.items.unshift(item);
    }

    /** Re-insert a taken item behind everything of its priority band (a failed send waits its turn). */
    putLast(item) {
        if (this.isStopped) return;
        const priority = item.priority ?? 4;
        let at = this.items.length;
        while (at > 0 && (this.items[at - 1].priority ?? 4) > priority) at -= 1;
        this.items.splice(at, 0, item);
    }

    /**
     * Next item, or null when empty, paused or stopped. With `ready`, the first
     * item (in priority order) it accepts: items that must wait stay queued
     * and the ones behind them go first.
     */
    get(ready = null) {
        if (this.state !== QueueState.RUNNING) return null;
        if (!ready) return this.items.shift() ?? null;
        const at = this.items.findIndex(ready);
        return at === -1 ? null : this.items.splice(at, 1)[0];
    }

    get pending() {
        return this.items.length;
    }

    snapshot() {
        return [...this.items];
    }
}
