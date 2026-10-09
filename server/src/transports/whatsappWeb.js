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
import path from 'node:path';

import { APP_DIR, SESSION_DIR } from '../config.js';
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
const PROFILE_LOCK_CODE = 'WHATSAPP_WEB_PROFILE_LOCKED';
const WEB_CACHE_DIR = path.join(APP_DIR, 'wwebjs_cache');
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const RECONNECT_JITTER = 0.25;

function isProfileLockError(err) {
    const message = String(err?.message ?? err);
    return message.includes('The browser is already running')
        && message.includes('Use a different userDataDir or stop the running browser first');
}

function profileLockMessage(message) {
    return 'WhatsApp Web profile is already in use. Close the other Chrome/Chromium window '
        + `using this session, then connect again. Original error: ${message}`;
}

function isInvalidSessionReason(reason) {
    const message = String(reason ?? '').toLowerCase();
    return message.includes('logout')
        || message.includes('logged out')
        || message.includes('auth_failure')
        || message.includes('authentication failed')
        || message.includes('invalid session');
}

export class WhatsAppWebTransport extends Transport {
    static name_ = 'WhatsApp Web via whatsapp-web.js (QR login, no access token)';
    realDelivery = true;
    supportsReceipts = true;

    /**
     * @param {object} config
     * @param {object} deps `createClient` is injectable so the tests can drive
     *   this without a browser.
     */
    constructor(config, {
        createClient = defaultClientFactory,
        sessionDir = SESSION_DIR,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        randomFn = Math.random,
        sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        reconnectBaseMs = RECONNECT_BASE_MS,
        reconnectMaxMs = RECONNECT_MAX_MS,
    } = {}) {
        super();
        this.config = config;
        this.createClient = createClient;
        this.sessionDir = sessionDir;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.randomFn = randomFn;
        this.sleepFn = sleepFn;
        this.reconnectBaseMs = reconnectBaseMs;
        this.reconnectMaxMs = reconnectMaxMs;
        this.client = null;
        this.connected = false;
        this.account = '';
        this.qr = null;
        this.closed = false;
        this.connecting = false;
        this.reconnectTimer = null;
        this.reconnectAttempt = 0;
        this.receipts = new Map();
        this.events = new EventEmitter(); // 'qr' | 'receipt' | 'state'
        /**
         * client.sendMessage() returns undefined whenever WhatsApp Web changes
         * shape under whatsapp-web.js, even though the message WAS dispatched.
         * Reporting that as a failure makes the caller retry and the recipient
         * gets the message twice, so outgoing messages are also tracked here.
         */
        this.recentOutgoing = new Map();
        this.botOutgoing = new Map();
    }

    isConnected() {
        return this.connected;
    }

    async connect() {
        this.closed = false;
        this.#clearReconnectTimer();
        if (this.connecting) {
            throw new TransportConnectionError('WhatsApp Web connection already in progress');
        }
        this.connecting = true;
        try {
            return await this.#connectOnce();
        } finally {
            this.connecting = false;
        }
    }

    async #connectOnce() {
        if (this.client) await this.#destroyClient(this.client);
        const client = await this.createClient({
            sessionDir: this.sessionDir,
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
            if (!msg?.fromMe) return;
            const chatId = privateChatId(msg?.to ?? msg?.id?.remote);
            this.#recordOutgoing(chatId, msg.body, serializedId(msg));
            if (this.#consumeBotOutgoing(chatId, msg.body, serializedId(msg))) return;
            const inbound = toInboundMessage(msg, chatId);
            if (inbound) this.events.emit('inbound', inbound);
        });
        client.on('message', (msg) => {
            if (msg?.fromMe) return;
            const inbound = toInboundMessage(msg, msg?.from);
            if (inbound) this.events.emit('inbound', inbound);
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
            this.#handleDisconnect(client, reason);
        });
        client.on('error', (err) => {
            this.#handleClientError(client, err);
        });
        client.on('auth_failure', (message) => {
            this.#handleAuthFailure(client, message);
        });

        client.on('ready', () => {
            this.connected = true;
            this.qr = null;
            this.reconnectAttempt = 0;
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
                this.reconnectAttempt = 0;
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
                this.#stopAutoReconnect();
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

    #handleDisconnect(client, reason) {
        if (client !== this.client) return;
        this.connected = false;
        const detail = String(reason ?? 'disconnected');
        if (isInvalidSessionReason(detail)) {
            this.#stopAutoReconnect();
            this.qr = null;
            this.events.emit('state', { state: 'auth_failure', detail });
            return;
        }
        this.events.emit('state', { state: 'disconnected', detail });
        this.#scheduleReconnect(detail);
    }

    #handleClientError(client, err) {
        if (client !== this.client) return;
        this.connected = false;
        const detail = String(err?.message ?? err);
        this.events.emit('state', { state: 'error', detail });
        this.#scheduleReconnect(detail);
    }

    #handleAuthFailure(client, message) {
        if (client !== this.client) return;
        const detail = `WhatsApp Web authentication failed: ${message}`;
        this.connected = false;
        this.qr = null;
        this.#stopAutoReconnect();
        this.events.emit('state', { state: 'auth_failure', detail });
    }

    #scheduleReconnect(reason) {
        if (this.closed || this.reconnectTimer || this.connecting) return;
        this.reconnectAttempt += 1;
        const delay = this.#nextReconnectDelay();
        this.events.emit('state', {
            state: 'reconnecting',
            detail: `Reconnecting after disconnect (${reason}). Attempt ${this.reconnectAttempt} in ${Math.round(delay / 1000)}s`,
        });
        this.reconnectTimer = this.setTimeoutFn(() => {
            this.reconnectTimer = null;
            void this.#runReconnect();
        }, delay);
    }

    #nextReconnectDelay() {
        const exponential = this.reconnectBaseMs * (2 ** Math.max(0, this.reconnectAttempt - 1));
        const capped = Math.min(exponential, this.reconnectMaxMs);
        const jitter = capped * RECONNECT_JITTER * this.randomFn();
        return Math.round(capped + jitter);
    }

    async #runReconnect() {
        if (this.closed || this.connected || this.connecting) return;
        try {
            await this.connect();
        } catch (err) {
            const detail = String(err?.message ?? err);
            const permanent = err instanceof TransportConnectionError && err.retryable === false;
            this.connected = false;
            this.events.emit('state', {
                state: permanent ? 'auth_failure' : 'reconnect_failed',
                detail,
            });
            if (permanent) {
                this.#stopAutoReconnect();
                return;
            }
            this.#scheduleReconnect(detail);
        }
    }

    #clearReconnectTimer() {
        if (!this.reconnectTimer) return;
        this.clearTimeoutFn(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    #stopAutoReconnect() {
        this.closed = true;
        this.#clearReconnectTimer();
    }

    async #initializeWithRetries(client, attempts) {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                await client.initialize();
                return;
            } catch (err) {
                if (this.connected || this.qr) return; // already usable
                if (isProfileLockError(err)) {
                    const detail = profileLockMessage(String(err.message ?? err));
                    this.events.emit('state', { state: 'auth_failure', detail });
                    await this.#destroyClient(client);
                    throw new TransportConnectionError(detail, {
                        retryable: false,
                        code: PROFILE_LOCK_CODE,
                    });
                }
                if (attempt === attempts) {
                    const detail = String(err.message ?? err);
                    this.events.emit('state', { state: 'error', detail });
                    await this.#destroyClient(client);
                    throw new TransportConnectionError(
                        `Failed to initialize WhatsApp Web: ${detail}`, { retryable: true }
                    );
                }
                await this.#destroyClient(client);
                await this.sleepFn(3000);
            }
        }
    }

    async #destroyClient(client) {
        if (this.client === client) this.client = null;
        try {
            await client.destroy();
        } catch {
            // already dead
        }
    }

    async disconnect() {
        this.#stopAutoReconnect();
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

    async sendMessage(recipient, message, { media = null } = {}) {
        if (!this.connected || !this.client) {
            throw new TransportConnectionError('Transport is reconnecting', { retryable: true });
        }

        let chatId = directPrivateChatId(recipient);
        if (!chatId) {
            let numberId;
            try {
                numberId = await this.client.getNumberId(recipient);
            } catch (err) {
                throw new TransportSendError(String(err.message ?? err), { retryable: true });
            }
            if (!numberId) {
                throw new TransportSendError(`${recipient} is not on WhatsApp`, { retryable: false });
            }
            chatId = numberId._serialized;
        }
        const startedAt = Date.now();
        let providerId = null;
        let sendError = null;
        this.#recordBotOutgoing(chatId, message);
        try {
            if (media) {
                const pkg = await import('whatsapp-web.js');
                const { MessageMedia } = pkg.default ?? pkg;
                const attachment = MessageMedia.fromFilePath(media.filePath);
                providerId = serializedId(await this.client.sendMessage(chatId, attachment, { caption: message, sendSeen: false }));
            } else {
                // sendSeen: false - marking the chat read first is what throws
                // "Data passed to getter must include an id property" on recent
                // WhatsApp Web builds, and a bulk send has nothing to mark read.
                providerId = serializedId(await this.client.sendMessage(chatId, message, { sendSeen: false }));
            }
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
            this.#recordBotOutgoing(chatId, message, providerId);
            return { providerId, status: Status.SENT, detail: 'accepted by WhatsApp Web' };
        }
        if (sendError) {
            throw new TransportSendError(sendError, { retryable: true });
        }
        // Dispatched, but nothing confirms it. NOT retried: a synthetic id
        // keeps the history row, at the price of no ACK tracking for this one.
        const localId = `local.${startedAt}.${Math.random().toString(36).slice(2, 8)}`;
        this.receipts.set(localId, Status.SENT);
        this.#recordBotOutgoing(chatId, message, localId);
        return {
            providerId: localId,
            status: Status.SENT,
            detail: 'sent, but WhatsApp Web returned no message id - no DELIVERED/READ for this one',
        };
    }

    #recordOutgoing(chatId, body, id) {
        if (!chatId || !id) return;
        this.recentOutgoing.set(`${chatId}|${body}`, { id, at: Date.now() });
        this.#pruneOutgoing(this.recentOutgoing);
    }

    #recordBotOutgoing(chatId, body, id = null) {
        if (!chatId) return;
        const at = Date.now();
        this.botOutgoing.set(`${chatId}|${body}`, { id, at });
        if (id) this.botOutgoing.set(`${chatId}|${id}`, { id, at });
        this.#pruneOutgoing(this.botOutgoing);
    }

    #consumeBotOutgoing(chatId, body, id) {
        if (!chatId) return false;
        this.#pruneOutgoing(this.botOutgoing);
        const bodyKey = `${chatId}|${body}`;
        const idKey = id ? `${chatId}|${id}` : null;
        const matched = this.botOutgoing.get(bodyKey) ?? (idKey ? this.botOutgoing.get(idKey) : null);
        if (!matched) return false;
        this.botOutgoing.delete(bodyKey);
        if (idKey) this.botOutgoing.delete(idKey);
        return true;
    }

    #pruneOutgoing(map) {
        const now = Date.now();
        for (const [key, entry] of map) {
            if (now - entry.at > OUTGOING_TTL_MS) map.delete(key);
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

function directPrivateChatId(recipient) {
    return privateChatId(recipient);
}

function privateChatId(recipient) {
    const value = String(recipient ?? '').trim();
    if (/^[^@\s]+@(c\.us|lid)$/.test(value)) return value;
    return null;
}

function toInboundMessage(msg, rawChatId) {
    if (msg?.isStatus || msg?.from === 'status@broadcast' || msg?.to === 'status@broadcast') return null;
    const chatId = privateChatId(rawChatId);
    if (!chatId || msg?.isGroup || chatId.endsWith('@g.us')) return null;
    const sender = chatId.replace(/@c\.us$/, '');
    if (!sender) return null;
    return {
        messageId: serializedId(msg),
        sender,
        senderName: msg?._data?.notifyName ?? msg?.notifyName ?? '',
        body: msg?.body ?? '',
        mediaType: msg?.hasMedia ? msg?.type ?? null : null,
        timestamp: msg?.timestamp
            ? new Date(Number(msg.timestamp) * 1000).toISOString()
            : new Date().toISOString(),
    };
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
        webVersionCache: {
            type: 'local',
            path: WEB_CACHE_DIR,
        },
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            ...(chromePath ? { executablePath: chromePath } : {}),
        },
    });
}
