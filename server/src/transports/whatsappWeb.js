/**
 * Token-free delivery through whatsapp-web.js (QR login).
 *
 * The Python build ran this as a separate Node sidecar and talked to it over
 * loopback HTTP.  The backend is already Node, so the library runs in-process
 * here and the bridge is gone: fewer moving parts, no port, no shared secret.
 *
 * What it costs you: whatsapp-web.js is not an official API - it automates the
 * WhatsApp Web client, which violates the WhatsApp Terms of Service and gets
 * numbers banned for bulk sending.  The UI says so on every screen.
 *
 * Status mapping (whatsapp-web.js MessageAck):
 *   send accepted -> SENT, ACK_SERVER(1) -> SENT, ACK_DEVICE(2) -> DELIVERED,
 *   ACK_READ(3)/ACK_PLAYED(4) -> READ, ACK_ERROR(-1) -> FAILED.
 *   ACK_PENDING(0) reports nothing: a status is never guessed.
 */

import { EventEmitter } from 'node:events';

import { SESSION_DIR } from '../config.js';
import { Status } from '../protocol.js';
import { Transport, TransportConnectionError, TransportSendError } from './base.js';

const ACK_STATUS = {
    '-1': Status.FAILED,
    1: Status.SENT,
    2: Status.DELIVERED,
    3: Status.READ,
    4: Status.READ,
};

export const TOS_WARNING =
    'whatsapp-web.js automates WhatsApp Web. It is not an official API, it violates the '
    + 'WhatsApp Terms of Service, and bulk sending from a personal number can get that '
    + 'number banned.';

export function ackStatus(ack) {
    return ACK_STATUS[String(ack)] ?? null; // 0 (pending) reports nothing
}

const OUTGOING_TTL_MS = 5 * 60 * 1000;
const CONFIRM_TIMEOUT_MS = 5000;

export class WhatsAppWebTransport extends Transport {
    static name_ = 'WhatsApp Web via whatsapp-web.js (QR login, no access token)';
    realDelivery = true;
    supportsReceipts = true;

    /**
     * @param {object} config
     * @param {object} deps `createClient` is injectable so the tests can drive
     *   this without a browser.
     */
    constructor(config, { createClient = defaultClientFactory } = {}) {
        super();
        this.config = config;
        this.createClient = createClient;
        this.client = null;
        this.connected = false;
        this.account = '';
        this.qr = null;
        this.receipts = new Map();
        this.events = new EventEmitter(); // 'qr' | 'receipt' | 'state'
        /**
         * client.sendMessage() returns undefined whenever WhatsApp Web changes
         * shape under whatsapp-web.js, even though the message WAS dispatched.
         * Reporting that as a failure makes the caller retry and the recipient
         * gets the message twice, so outgoing messages are also tracked here.
         */
        this.recentOutgoing = new Map();
    }

    isConnected() {
        return this.connected;
    }

    async connect() {
        if (this.client) await this.disconnect();
        const client = await this.createClient({
            sessionDir: SESSION_DIR,
            chromePath: this.config.chromePath,
        });
        this.client = client;

        client.on('qr', (qr) => {
            this.qr = qr;
            this.events.emit('qr', qr);
            this.events.emit('state', { state: 'qr', detail: 'scan the QR code to link' });
        });
        client.on('authenticated', () =>
            this.events.emit('state', { state: 'authenticated', detail: 'loading' }));
        client.on('loading_screen', (percent) =>
            this.events.emit('state', { state: 'loading', detail: `loading ${percent}%` }));
        client.on('message_create', (msg) => {
            if (msg?.fromMe) this.#recordOutgoing(msg.to, msg.body, serializedId(msg));
        });
        client.on('message', (msg) => {
            if (msg?.fromMe) return;
            if (msg?.isStatus || msg?.from === 'status@broadcast') return;
            if (msg?.isGroup || String(msg?.from ?? '').endsWith('@g.us')) return;
            const sender = String(msg?.from ?? '').replace(/@c\.us$/, '');
            if (!sender) return;
            this.events.emit('inbound', {
                messageId: serializedId(msg),
                sender,
                senderName: msg?._data?.notifyName ?? msg?.notifyName ?? '',
                body: msg?.body ?? '',
                mediaType: msg?.hasMedia ? msg?.type ?? null : null,
                timestamp: msg?.timestamp
                    ? new Date(Number(msg.timestamp) * 1000).toISOString()
                    : new Date().toISOString(),
            });
        });
        client.on('message_ack', (msg, ack) => {
            const status = ackStatus(ack);
            const providerId = serializedId(msg);
            if (!status || !providerId) return;
            this.receipts.set(providerId, status);
            this.events.emit('receipt', {
                providerId,
                status,
                error: status === Status.FAILED ? 'WhatsApp Web reported a send failure' : null,
            });
        });
        client.on('disconnected', (reason) => {
            this.connected = false;
            this.events.emit('state', { state: 'disconnected', detail: String(reason) });
        });

        client.on('ready', () => {
            this.connected = true;
            this.qr = null;
            this.account = client.info?.wid?.user ?? '';
            this.events.emit('state', { state: 'ready', detail: 'session cached, no access token' });
            this.events.emit('ready', {
                connected: true,
                account: this.account,
                detail: `QR session, no access token. ${TOS_WARNING}`,
                realDelivery: true,
            });
        });

        // WhatsApp Web reloads itself while the login page is being injected,
        // which surfaces as a puppeteer "Execution context was destroyed"
        // ProtocolError. It is transient, so initialize gets a few attempts.
        const firstEvent = new Promise((resolve, reject) => {
            let settled = false;

            const onReady = () => {
                if (settled) return;
                settled = true;
                cleanup();
                this.connected = true;
                this.qr = null;
                this.account = client.info?.wid?.user ?? '';
                resolve({
                    connected: true,
                    account: this.account,
                    detail: `QR session, no access token. ${TOS_WARNING}`,
                    realDelivery: true,
                });
            };

            const onQr = (qr) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve({
                    connected: false,
                    account: '',
                    detail: `Scan the QR code to link WhatsApp. ${TOS_WARNING}`,
                    realDelivery: true,
                    qr,
                });
            };

            const onAuthFail = (message) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new TransportConnectionError(
                    `WhatsApp Web authentication failed: ${message}`, { retryable: false }));
            };

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new TransportConnectionError(
                    `Timed out after 60s waiting for WhatsApp Web to initialize`));
            }, 60000);

            function cleanup() {
                clearTimeout(timer);
                client.off('ready', onReady);
                client.off('qr', onQr);
                client.off('auth_failure', onAuthFail);
            }

            client.once('ready', onReady);
            client.once('qr', onQr);
            client.once('auth_failure', onAuthFail);

            this.#initializeWithRetries(client, 3).catch((err) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err instanceof TransportConnectionError ? err : new TransportConnectionError(String(err.message ?? err)));
            });
        });

        return await firstEvent;
    }

    async #initializeWithRetries(client, attempts) {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                await client.initialize();
                return;
            } catch (err) {
                if (this.connected || this.qr) return; // already usable
                if (attempt === attempts) {
                    this.events.emit('state', { state: 'auth_failure', detail: String(err.message ?? err) });
                    throw new TransportConnectionError(
                        `Failed to initialize WhatsApp Web: ${err.message ?? err}`, { retryable: false }
                    );
                }
                try {
                    await client.destroy();
                } catch {
                    // already dead
                }
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
        }
    }

    async disconnect() {
        this.connected = false;
        this.qr = null;
        const client = this.client;
        this.client = null;
        if (client) {
            try {
                await client.destroy();
            } catch {
                // shutting down anyway
            }
        }
    }

    /** Drop the cached session so the next connect asks for a new QR scan. */
    async logout() {
        if (this.client) {
            try {
                await this.client.logout();
            } catch {
                // fall through to destroy
            }
        }
        await this.disconnect();
    }

    async sendMessage(recipient, message) {
        if (!this.connected || !this.client) {
            throw new TransportConnectionError('Transport is not connected', { retryable: false });
        }

        let numberId;
        try {
            numberId = await this.client.getNumberId(recipient);
        } catch (err) {
            throw new TransportSendError(String(err.message ?? err), { retryable: true });
        }
        if (!numberId) {
            throw new TransportSendError(`${recipient} is not on WhatsApp`, { retryable: false });
        }

        const chatId = numberId._serialized;
        const startedAt = Date.now();
        let providerId = null;
        let sendError = null;
        try {
            providerId = serializedId(await this.client.sendMessage(chatId, message));
        } catch (err) {
            sendError = String(err.message ?? err);
        }
        if (!providerId) {
            // No id from the call: ask WhatsApp Web itself whether the message
            // went out.  Retrying a message that was in fact sent is exactly
            // what delivers it twice.
            providerId = await this.#confirmOutgoing(chatId, message, startedAt);
        }
        if (providerId) {
            this.receipts.set(providerId, Status.SENT);
            return { providerId, status: Status.SENT, detail: 'accepted by WhatsApp Web' };
        }
        if (sendError) {
            throw new TransportSendError(sendError, { retryable: true });
        }
        // Dispatched, but nothing confirms it. NOT retried: a synthetic id
        // keeps the history row, at the price of no ACK tracking for this one.
        const localId = `local.${startedAt}.${Math.random().toString(36).slice(2, 8)}`;
        this.receipts.set(localId, Status.SENT);
        return {
            providerId: localId,
            status: Status.SENT,
            detail: 'sent, but WhatsApp Web returned no message id - no DELIVERED/READ for this one',
        };
    }

    #recordOutgoing(chatId, body, id) {
        if (!chatId || !id) return;
        this.recentOutgoing.set(`${chatId}|${body}`, { id, at: Date.now() });
        for (const [key, entry] of this.recentOutgoing) {
            if (Date.now() - entry.at > OUTGOING_TTL_MS) this.recentOutgoing.delete(key);
        }
    }

    async #confirmOutgoing(chatId, body, notBefore) {
        const key = `${chatId}|${body}`;
        const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const entry = this.recentOutgoing.get(key);
            if (entry && entry.at >= notBefore) {
                this.recentOutgoing.delete(key); // never match the same message twice
                return entry.id;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return null;
    }

    getStatus(providerId) {
        return this.receipts.get(providerId) ?? null;
    }
}

function serializedId(msg) {
    const id = msg?.id;
    if (!id) return null;
    if (typeof id === 'string') return id;
    return id._serialized ?? null;
}

async function defaultClientFactory({ sessionDir, chromePath }) {
    // whatsapp-web.js is CJS (module.exports = Client, with named props bolted
    // on). Node's ESM interop only statically detects `Client` as a named
    // export and leaves the rest undefined, so pull everything off .default
    // instead of destructuring the namespace import.
    const pkg = await import('whatsapp-web.js');
    const { Client, LocalAuth } = pkg.default ?? pkg;
    return new Client({
        authStrategy: new LocalAuth({ dataPath: sessionDir }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            ...(chromePath ? { executablePath: chromePath } : {}),
        },
    });
}
