/**
 * QR-login delivery through Baileys (@whiskeysockets/baileys): a direct
 * WebSocket client for WhatsApp's multi-device protocol. No browser, no
 * puppeteer, no Chrome: media is encrypted and uploaded by this process, which
 * is why attachments are far more reliable here than through whatsapp-web.js.
 *
 * Same interface and the same events as transports/whatsappWeb.js, so app.js
 * wiring is unchanged: 'qr' | 'state' | 'ready' | 'disconnected' | 'receipt' | 'inbound'.
 *
 * Status mapping (proto.WebMessageInfo.Status):
 *   send accepted -> SENT, SERVER_ACK(2) -> SENT, DELIVERY_ACK(3) -> DELIVERED,
 *   READ(4)/PLAYED(5) -> READ, ERROR(0) -> FAILED. PENDING(1) reports nothing.
 *
 * Like whatsapp-web.js this automates a personal/business number outside the
 * official API: the ToS warning applies and the UI shows it.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { SESSION_DIR } from '../config.js';
import { renderFallbackText } from '../messaging/interactive.js';
import { Status } from '../protocol.js';
import { Transport, TransportConnectionError, TransportSendError } from './base.js';

export const TOS_WARNING =
    'Baileys automates a WhatsApp account over the multi-device protocol. It is not an '
    + 'official API, it violates the WhatsApp Terms of Service, and bulk sending from a '
    + 'personal number can get that number banned.';

const ACK_STATUS = {
    0: Status.FAILED,
    2: Status.SENT,
    3: Status.DELIVERED,
    4: Status.READ,
    5: Status.READ,
};

export function ackStatus(status) {
    return ACK_STATUS[String(status)] ?? null; // 1 (pending) reports nothing
}

const LOGGED_OUT = 401;
const CONNECT_TIMEOUT_MS = 60000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const RECONNECT_JITTER = 0.25;

export class BaileysTransport extends Transport {
    static name_ = 'WhatsApp via Baileys (QR login, no browser, no access token)';
    realDelivery = true;
    supportsReceipts = true;

    /**
     * @param {object} config
     * @param {object} deps `createSocket` is injectable so the tests can drive
     *   this without a network. It must return a Baileys-shaped socket:
     *   { ev, user, sendMessage, onWhatsApp?, logout, end }.
     */
    constructor(config, {
        createSocket = defaultSocketFactory,
        sessionDir = SESSION_DIR,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        randomFn = Math.random,
        reconnectBaseMs = RECONNECT_BASE_MS,
        reconnectMaxMs = RECONNECT_MAX_MS,
    } = {}) {
        super();
        this.config = config;
        this.createSocket = createSocket;
        this.sessionDir = sessionDir;
        this.authDir = path.join(sessionDir, 'baileys');
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.randomFn = randomFn;
        this.reconnectBaseMs = reconnectBaseMs;
        this.reconnectMaxMs = reconnectMaxMs;
        this.sock = null;
        this.connected = false;
        this.account = '';
        this.qr = null;
        this.closed = false;
        this.connecting = false;
        this.reconnectTimer = null;
        this.reconnectAttempt = 0;
        this.receipts = new Map();
        this.events = new EventEmitter();
    }

    isConnected() {
        return this.connected;
    }

    async connect() {
        this.closed = false;
        this.#clearReconnectTimer();
        if (this.connecting) {
            throw new TransportConnectionError('Baileys connection already in progress');
        }
        this.connecting = true;
        try {
            return await this.#connectOnce();
        } finally {
            this.connecting = false;
        }
    }

    async #connectOnce() {
        if (this.sock) await this.#endSocket(this.sock);
        let sock;
        try {
            sock = await this.createSocket({ authDir: this.authDir, sessionDir: this.sessionDir });
        } catch (err) {
            throw new TransportConnectionError(`Failed to start Baileys: ${err.message ?? err}`);
        }
        this.sock = sock;

        sock.ev.on('connection.update', (update) => this.#handleConnectionUpdate(sock, update));
        sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify') return; // 'append' is history sync
            for (const msg of messages ?? []) void this.#handleInbound(sock, msg);
        });
        sock.ev.on('messages.update', (updates) => {
            for (const { key, update } of updates ?? []) {
                if (update?.status == null) continue;
                this.#emitReceipt(key?.id, ackStatus(update.status));
            }
        });
        sock.ev.on('message-receipt.update', (updates) => {
            for (const { key, receipt } of updates ?? []) {
                const status = receipt?.readTimestamp ? Status.READ
                    : receipt?.receiptTimestamp ? Status.DELIVERED : null;
                this.#emitReceipt(key?.id, status);
            }
        });

        return await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                sock.ev.off('connection.update', onUpdate);
                fn(value);
            };
            const onUpdate = ({ connection, lastDisconnect, qr }) => {
                if (qr) {
                    finish(resolve, {
                        connected: false,
                        account: '',
                        detail: `Scan the QR code to link WhatsApp. ${TOS_WARNING}`,
                        realDelivery: true,
                        qr,
                    });
                } else if (connection === 'open') {
                    finish(resolve, this.#readyInfo(sock));
                } else if (connection === 'close' && statusCode(lastDisconnect) === LOGGED_OUT) {
                    finish(reject, new TransportConnectionError(
                        `Baileys authentication failed: ${reasonText(lastDisconnect)}`, { retryable: false }));
                }
                // Any other close: #handleConnectionUpdate already scheduled a
                // reconnect (Baileys needs one right after a QR scan, code 515).
            };
            // Real timer: the injectable one is for reconnect backoff only.
            const timer = setTimeout(() => finish(reject, new TransportConnectionError(
                `Timed out after ${CONNECT_TIMEOUT_MS / 1000}s waiting for Baileys to connect`)), CONNECT_TIMEOUT_MS);
            sock.ev.on('connection.update', onUpdate);
        });
    }

    #readyInfo(sock) {
        this.connected = true;
        this.qr = null;
        this.reconnectAttempt = 0;
        this.account = accountOf(sock);
        return {
            connected: true,
            account: this.account,
            detail: `QR session, no access token, no browser. ${TOS_WARNING}`,
            realDelivery: true,
        };
    }

    #handleConnectionUpdate(sock, { connection, lastDisconnect, qr }) {
        if (sock !== this.sock) return;
        if (qr) {
            this.qr = qr;
            this.events.emit('qr', qr);
            this.events.emit('state', { state: 'qr', detail: 'scan the QR code to link' });
        }
        if (connection === 'connecting') {
            this.events.emit('state', { state: 'loading', detail: 'connecting' });
        } else if (connection === 'open') {
            const info = this.#readyInfo(sock);
            this.events.emit('state', { state: 'ready', detail: 'session cached, no access token' });
            this.events.emit('ready', info);
        } else if (connection === 'close') {
            this.connected = false;
            const code = statusCode(lastDisconnect);
            const detail = reasonText(lastDisconnect);
            if (code === LOGGED_OUT) {
                this.#stopAutoReconnect();
                this.qr = null;
                this.events.emit('state', { state: 'auth_failure', detail: `Baileys session logged out: ${detail}` });
                return;
            }
            this.events.emit('state', { state: 'disconnected', detail });
            this.#scheduleReconnect(detail);
        }
    }

    #emitReceipt(providerId, status) {
        if (!providerId || !status) return;
        this.receipts.set(providerId, status);
        this.events.emit('receipt', {
            providerId,
            status,
            error: status === Status.FAILED ? 'Baileys reported a send failure' : null,
        });
    }

    async #handleInbound(sock, msg) {
        if (!msg?.key || msg.key.fromMe) return;
        const inbound = await toInboundMessage(msg, sock);
        if (inbound) this.events.emit('inbound', inbound);
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
        return Math.round(capped + capped * RECONNECT_JITTER * this.randomFn());
    }

    async #runReconnect() {
        if (this.closed || this.connected || this.connecting) return;
        try {
            await this.connect();
        } catch (err) {
            const detail = String(err?.message ?? err);
            const permanent = err instanceof TransportConnectionError && err.retryable === false;
            this.connected = false;
            this.events.emit('state', { state: permanent ? 'auth_failure' : 'reconnect_failed', detail });
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

    async #endSocket(sock) {
        if (this.sock === sock) this.sock = null;
        try {
            sock.ev?.removeAllListeners?.('connection.update');
            await sock.end?.(undefined);
        } catch {
            // already dead
        }
    }

    async disconnect() {
        this.#stopAutoReconnect();
        this.connected = false;
        this.qr = null;
        const sock = this.sock;
        this.sock = null;
        if (sock) await this.#endSocket(sock);
    }

    /** Unlink the device and drop the cached session so the next connect asks for a new QR. */
    async logout() {
        if (this.sock) {
            try {
                await this.sock.logout();
            } catch {
                // fall through
            }
        }
        await this.disconnect();
        fs.rmSync(this.authDir, { recursive: true, force: true });
    }

    async sendMessage(recipient, message, { media = null, interactive = null } = {}) {
        if (!this.connected || !this.sock) {
            throw new TransportConnectionError('Transport is reconnecting', { retryable: true });
        }
        const jid = toJid(recipient);
        if (!jid) throw new TransportSendError(`${recipient} is not a phone number`, { retryable: false });
        if (!String(recipient).includes('@')) await this.#assertOnWhatsApp(jid, recipient);

        // Baileys buttons/lists are unreliable for ordinary accounts: send the
        // numbered-menu rendering and let matchReply() map the typed answer back.
        const text = interactive ? renderFallbackText(message, interactive) : message;
        let content;
        try {
            content = media ? mediaContent(media, text) : { text };
        } catch (err) {
            throw new TransportSendError(`attachment file is missing: ${err.message ?? err}`, { retryable: false });
        }

        let sent;
        try {
            sent = await this.sock.sendMessage(jid, content);
        } catch (err) {
            throw new TransportSendError(String(err?.message ?? err), { retryable: true });
        }
        const providerId = sent?.key?.id
            ?? `local.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
        this.receipts.set(providerId, Status.SENT);
        return {
            providerId,
            status: Status.SENT,
            detail: sent?.key?.id ? 'accepted by WhatsApp' : 'sent, but Baileys returned no message id - no DELIVERED/READ for this one',
        };
    }

    async #assertOnWhatsApp(jid, recipient) {
        if (typeof this.sock.onWhatsApp !== 'function') return;
        let result;
        try {
            [result] = await this.sock.onWhatsApp(jid) ?? [];
        } catch {
            return; // the lookup failed, not the number: let the send decide
        }
        if (result && result.exists === false) {
            throw new TransportSendError(`${recipient} is not on WhatsApp`, { retryable: false });
        }
    }

    getStatus(providerId) {
        return this.receipts.get(providerId) ?? null;
    }
}

function statusCode(lastDisconnect) {
    return lastDisconnect?.error?.output?.statusCode ?? null;
}

function reasonText(lastDisconnect) {
    const err = lastDisconnect?.error;
    return String(err?.output?.payload?.message ?? err?.message ?? err ?? 'disconnected');
}

function accountOf(sock) {
    return String(sock?.user?.id ?? '').split('@')[0].split(':')[0];
}

/** '9198...' | '9198...@c.us' | '9198...@s.whatsapp.net' | '...@lid' -> a Baileys jid. */
export function toJid(recipient) {
    const value = String(recipient ?? '').trim();
    if (/^[^@\s]+@(s\.whatsapp\.net|lid)$/.test(value)) return value;
    if (/^[^@\s]+@c\.us$/.test(value)) return value.replace(/@c\.us$/, '@s.whatsapp.net');
    const digits = value.replace(/[^\d]/g, '');
    return digits ? `${digits}@s.whatsapp.net` : null;
}

/** The Baileys content object for one attachment, keyed by MIME family. */
export function mediaContent(media, caption) {
    const data = Buffer.isBuffer(media.buffer) ? media.buffer : fs.readFileSync(media.filePath);
    const mimetype = media.mimetype || 'application/octet-stream';
    const fileName = media.filename || path.basename(String(media.filePath ?? 'attachment'));
    const kind = mimetype.split('/')[0];
    if (kind === 'image') return { image: data, caption, mimetype };
    if (kind === 'video') return { video: data, caption, mimetype };
    return { document: data, caption, mimetype, fileName };
}

const MEDIA_TYPES = {
    imageMessage: 'image',
    videoMessage: 'video',
    documentMessage: 'document',
    audioMessage: 'audio',
    stickerMessage: 'sticker',
};

/** Unwrap ephemeral / view-once envelopes down to the real content. */
function unwrap(message) {
    let content = message ?? null;
    for (let i = 0; i < 3 && content; i += 1) {
        const inner = content.ephemeralMessage?.message
            ?? content.viewOnceMessage?.message
            ?? content.viewOnceMessageV2?.message
            ?? content.documentWithCaptionMessage?.message;
        if (!inner) break;
        content = inner;
    }
    return content;
}

/** The text and, for a button/list answer, the selected option id. */
export function extractContent(message) {
    const c = unwrap(message);
    if (!c) return { body: '', replyId: null, mediaType: null };
    const mediaType = Object.keys(MEDIA_TYPES).find((k) => c[k]) ?? null;
    if (c.buttonsResponseMessage) {
        return { body: c.buttonsResponseMessage.selectedDisplayText ?? '', replyId: c.buttonsResponseMessage.selectedButtonId ?? null, mediaType: null };
    }
    if (c.listResponseMessage) {
        return { body: c.listResponseMessage.title ?? '', replyId: c.listResponseMessage.singleSelectReply?.selectedRowId ?? null, mediaType: null };
    }
    if (c.templateButtonReplyMessage) {
        return { body: c.templateButtonReplyMessage.selectedDisplayText ?? '', replyId: c.templateButtonReplyMessage.selectedId ?? null, mediaType: null };
    }
    if (c.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
        let replyId = null;
        try {
            replyId = JSON.parse(c.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id ?? null;
        } catch { /* not ours */ }
        return { body: c.interactiveResponseMessage.body?.text ?? '', replyId, mediaType: null };
    }
    const body = c.conversation
        ?? c.extendedTextMessage?.text
        ?? (mediaType ? c[Object.keys(MEDIA_TYPES).find((k) => c[k])]?.caption : null)
        ?? '';
    return { body: String(body ?? ''), replyId: null, mediaType: mediaType ? MEDIA_TYPES[mediaType] : null };
}

async function toInboundMessage(msg, sock) {
    const key = msg.key;
    const remote = String(key.remoteJid ?? '');
    if (!remote || /@(g\.us|broadcast|newsletter)$/.test(remote)) return null;
    let phoneJid = remote.endsWith('@lid') ? String(key.remoteJidAlt ?? '') : remote;
    if (!phoneJid && remote.endsWith('@lid')) {
        try {
            phoneJid = String(await sock?.signalRepository?.lidMapping?.getPNForLID?.(remote) ?? '');
        } catch { /* unknown LID */ }
    }
    if (!phoneJid.endsWith('@s.whatsapp.net')) return null; // no phone number to answer to
    const sender = phoneJid.split('@')[0].split(':')[0];
    if (!sender) return null;
    const { body, replyId, mediaType } = extractContent(msg.message);
    if (!body && !replyId && !mediaType) return null; // protocol/reaction/empty
    const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0);
    return {
        messageId: key.id ?? null,
        sender,
        senderName: msg.pushName ?? '',
        body,
        replyId,
        mediaType,
        timestamp: ts ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
    };
}

async function defaultSocketFactory({ authDir }) {
    const baileys = await import('@whiskeysockets/baileys');
    const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers } = baileys;
    fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    // Baileys' default pino logger prints every protocol event at 'info';
    // keep warnings and errors on the server log, drop the rest.
    const logger = quietLogger();
    const sock = makeWASocket({
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        logger,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
    });
    sock.ev.on('creds.update', saveCreds);
    return sock;
}

/** pino-shaped logger: warn/error to the console, everything below dropped. */
function quietLogger() {
    const noop = () => {};
    const out = (level) => (obj, msg) => console[level](`[baileys] ${msg ?? ''}`, typeof obj === 'string' ? obj : obj?.err?.message ?? obj?.error?.message ?? '');
    const logger = {
        level: 'warn',
        trace: noop, debug: noop, info: noop,
        warn: out('warn'), error: out('error'), fatal: out('error'),
        child: () => logger,
    };
    return logger;
}
