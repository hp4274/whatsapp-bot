/**
 * Local sandbox transport - for exercising the app, never for real delivery.
 *
 * Nothing leaves the machine.  Every message it handles is written with the
 * dedicated SANDBOX status, which is deliberately *not* SENT: the history, the
 * counters and the logs all keep saying SANDBOX, so a local test run can never
 * be read as a real WhatsApp delivery.
 */

import fs from 'node:fs';
import path from 'node:path';

import { APP_DIR } from '../config.js';
import { Status, utcNow } from '../protocol.js';
import { Transport, TransportConnectionError, TransportSendError } from './base.js';

export class SandboxTransport extends Transport {
    static name_ = 'Local sandbox (NO real delivery)';
    realDelivery = false;
    supportsReceipts = false;

    constructor(config, outboxPath = path.join(APP_DIR, 'sandbox_outbox.log')) {
        super();
        this.config = config;
        this.outboxPath = outboxPath;
        this.connected = false;
        this.sent = new Map();
        /** Set to a phone prefix to force failures while testing retries. */
        this.failPrefix = null;
    }

    async connect() {
        this.connected = true;
        return {
            connected: true,
            account: 'local sandbox',
            detail: 'no real delivery',
            realDelivery: false,
        };
    }

    async disconnect() {
        this.connected = false;
    }

    isConnected() {
        return this.connected;
    }

    async sendMessage(recipient, message) {
        if (!this.connected) {
            throw new TransportConnectionError('Sandbox transport is not connected',
                { retryable: false });
        }
        if (this.failPrefix && recipient.startsWith(this.failPrefix)) {
            throw new TransportSendError('Simulated sandbox failure',
                { retryable: true, code: 'sandbox' });
        }
        const providerId = `sandbox.${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        try {
            fs.mkdirSync(path.dirname(this.outboxPath), { recursive: true });
            fs.appendFileSync(this.outboxPath,
                `${utcNow()}\t${providerId}\t${recipient}\t${JSON.stringify(message)}\n`, 'utf8');
        } catch (err) {
            throw new TransportSendError(`Could not write sandbox outbox: ${err.message}`);
        }
        this.sent.set(providerId, Status.SANDBOX);
        return {
            providerId,
            status: Status.SANDBOX,
            detail: 'written to local outbox, not sent to WhatsApp',
        };
    }

    getStatus(providerId) {
        return this.sent.get(providerId) ?? null;
    }
}
