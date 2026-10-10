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
    template = null, fallbackTemplate = null,
}) {
    return {
        recipient,
        message,
        name,
        campaignId,
        media,
        interactive,
        // Meta approved template ({name, language, components}) and the one
        // to swap in on 131047 ({template, text}) - messaging/templateSend.js.
        template,
        fallbackTemplate,
        messageType,
        priority,
        idempotencyKey,
        messageId: newMessageId(),
        attempt: 0,
        get key() {
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

    /** Make a stopped queue usable again (new campaign, clean dedupe set). */
    reset() {
        this.items = [];
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

    /** Next item, or null when empty, paused or stopped. */
    get() {
        if (this.state !== QueueState.RUNNING) return null;
        return this.items.shift() ?? null;
    }

    get pending() {
        return this.items.length;
    }

    snapshot() {
        return [...this.items];
    }
}
