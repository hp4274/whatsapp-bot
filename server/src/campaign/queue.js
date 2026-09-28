/** FIFO message queue with pause / resume / stop and duplicate protection. */

import { dedupeKey, newMessageId } from '../protocol.js';

export const QueueState = Object.freeze({
    RUNNING: 'RUNNING',
    PAUSED: 'PAUSED',
    STOPPED: 'STOPPED',
});

export function queueItem({ recipient, message, name = '', campaignId = '' }) {
    return {
        recipient,
        message,
        name,
        campaignId,
        messageId: newMessageId(),
        attempt: 0,
        get key() {
            return dedupeKey(this.recipient, this.message);
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

    /** Append an item. Returns false when it was rejected as a duplicate. */
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
        this.items.push(item);
        return true;
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
