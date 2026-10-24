/**
 * QR-login delivery through Baileys (@whiskeysockets/baileys): a direct
 * WebSocket client for WhatsApp's multi-device protocol. No browser, no
 * puppeteer, no Chrome: media is encrypted and uploaded by this process, which
 * is why attachments are far more reliable here than through whatsapp-web.js.
 *
 * Same interface and events as the other transports (see base.js), so app.js
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
import { carouselCaptions, renderFallbackText } from '../messaging/interactive.js';
import { STATUS_RANK, Status } from '../protocol.js';
import { NOT_ON_WHATSAPP_CODE, Transport, TransportConnectionError, TransportSendError } from './base.js';

export const TOS_WARNING =
    'Baileys automates a WhatsApp account over the multi-device protocol. It is not an '
    + 'official API, it violates the WhatsApp Terms of Service, and bulk sending from a '
    + 'personal number can get that number banned.';

// Numbers are proto.WebMessageInfo.Status; some Baileys builds hand over the enum name instead.
const ACK_STATUS = {
    0: Status.FAILED, ERROR: Status.FAILED,
    2: Status.SENT, SERVER_ACK: Status.SENT,
    3: Status.DELIVERED, DELIVERY_ACK: Status.DELIVERED,
    4: Status.READ, READ: Status.READ,
    5: Status.READ, PLAYED: Status.READ,
};

export function ackStatus(status) {
    return ACK_STATUS[String(status)] ?? null; // 1 (pending) reports nothing
}

const LOGGED_OUT = 401;
const CONNECTION_REPLACED = 440;
const CONNECT_TIMEOUT_MS = 60000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const RECONNECT_JITTER = 0.25;
/** Numbers per `onWhatsApp` lookup, and how long one may take before its numbers count as unknown. */
const REGISTRY_BATCH = 50;
const REGISTRY_TIMEOUT_MS = 15000;

const withTimeout = (promise, ms) => {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); }),
    ]).finally(() => clearTimeout(timer));
};

export class BaileysTransport extends Transport {
    static name_ = 'WhatsApp via Baileys (QR login, no browser, no access token)';
    realDelivery = true;
    supportsReceipts = true;
    supportsGroups = true;
    supportsRegistrationCheck = true;

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
        this.replaced = false; // 440: another socket took this login; the watchdog must not grab it back
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
        this.replaced = false;
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
                const status = receipt?.readTimestamp || receipt?.playedTimestamp ? Status.READ
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
                    this.#dropSession();
                    finish(reject, new TransportConnectionError(
                        `Baileys authentication failed: ${reasonText(lastDisconnect)}. The saved login was rejected and has been cleared: connect again and scan the QR code.`, { retryable: false }));
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
                this.#dropSession();
                this.#stopAutoReconnect();
                this.qr = null;
                this.events.emit('state', { state: 'auth_failure', detail: `Baileys session logged out: ${detail}` });
                return;
            }
            if (code === CONNECTION_REPLACED) {
                // Another socket is using this login. Reconnecting would kick it, and it kicks
                // us back: the endless disconnect loop. Keep the session and wait for a manual Connect.
                this.#stopAutoReconnect();
                this.replaced = true;
                this.events.emit('state', { state: 'error', detail: 'This number was connected from another session, so this one stopped. Press Connect to take it back.' });
                return;
            }
            this.events.emit('state', { state: 'disconnected', detail });
            this.#scheduleReconnect(detail);
        }
    }

    #emitReceipt(providerId, status) {
        if (!providerId || !status) return;
        // A late "delivered" must not hide a "read" the memory already holds.
        const known = this.receipts.get(providerId);
        if (!known || (STATUS_RANK[status] ?? 0) > (STATUS_RANK[known] ?? 0) || status === Status.FAILED) {
            this.receipts.set(providerId, status);
        }
        this.events.emit('receipt', {
            providerId,
            status,
            error: status === Status.FAILED ? 'Baileys reported a send failure' : null,
        });
    }

    async #handleInbound(sock, msg) {
        if (!msg?.key || msg.key.fromMe) return;
        const inbound = await toInboundMessage(msg, sock);
        if (!inbound) return;
        this.events.emit('inbound', inbound);
        if (this.shouldRead?.(inbound.sender) !== false) this.#markRead(sock, msg.key);
    }

    /** Read what contacts send us, a few seconds late, the way a person opens a chat. */
    #markRead(sock, key) {
        if (typeof sock.readMessages !== 'function' || this.config?.markRead === false) return;
        const timer = setTimeout(() => {
            Promise.resolve(sock.readMessages([key])).catch(() => {});
        }, 2000 + this.randomFn() * 6000);
        timer.unref?.();
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

    /**
     * WhatsApp answered 401: the linked device was removed or the saved login is
     * stale. Those credentials can never work again, and keeping them makes
     * every later connect fail the same way instead of showing a fresh QR.
     */
    #dropSession() {
        try {
            fs.rmSync(this.authDir, { recursive: true, force: true });
        } catch {
            // best effort: the next logout() tries again
        }
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

    async sendMessage(recipient, message, { media = null, interactive = null, typingMs = 0, registered = false } = {}) {
        if (!this.connected || !this.sock) {
            throw new TransportConnectionError('Transport is reconnecting', { retryable: true });
        }
        const jid = toJid(recipient);
        if (!jid) throw new TransportSendError(`${recipient} is not a phone number`, { retryable: false });
        // `registered`: the campaign engine's batch check already said yes, no need to ask again.
        if (!registered && !String(recipient).includes('@')) await this.#assertOnWhatsApp(jid, recipient);

        let attachment = null;
        try {
            attachment = media ? mediaContent(media) : null;
        } catch (err) {
            throw new TransportSendError(`attachment file is missing: ${err.message ?? err}`, { retryable: false });
        }

        // composing -> wait -> send -> paused, like a person typing. No typingMs = instant (API sends, tests).
        if (typingMs > 0) {
            await this.#presence('available');
            await this.#presence('composing', jid);
            await new Promise((resolve) => setTimeout(resolve, typingMs));
        }
        try {
            return await this.#deliver(jid, message, attachment, interactive);
        } finally {
            // Not awaited: the caller only learns the provider id when we return, and a
            // delivery receipt that lands during this round trip finds no row to update.
            if (typingMs > 0) void this.#presence('paused', jid);
        }
    }

    /**
     * Every group and community this number is in, with the members' numbers:
     * [{ id, name, size, isCommunity, community, members: [{ phone, admin }], hidden }].
     * `community` is the parent community's id for a subgroup. A member WhatsApp
     * shows only by LID (privacy in large and community groups) is resolved
     * through the LID mapping when it knows the number, else counted in `hidden`.
     * Broadcast lists have no protocol call to read them, so they are not here.
     */
    async listGroups() {
        if (!this.connected || !this.sock) {
            throw new TransportConnectionError('WhatsApp is not connected', { retryable: true });
        }
        const sock = this.sock;
        const all = Object.values(await sock.groupFetchAllParticipating() ?? {});
        const groups = [];
        for (const g of all) {
            const members = new Map();
            let hidden = 0;
            for (const p of g.participants ?? []) {
                const phone = await participantPhone(sock, p);
                if (!phone) hidden += 1;
                else if (phone !== this.account && !members.has(phone)) members.set(phone, { phone, admin: p.admin ?? null });
            }
            groups.push({
                id: g.id,
                name: String(g.subject ?? ''),
                size: Number(g.size ?? g.participants?.length ?? 0),
                isCommunity: Boolean(g.isCommunity),
                community: g.linkedParent ?? null,
                members: [...members.values()],
                hidden,
            });
        }
        return groups.sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Online / offline / typing state. Never throws: presence is cosmetic, the send is not. */
    async setPresence(state) {
        await this.#presence(state);
    }

    async #presence(state, jid) {
        try {
            await this.sock?.sendPresenceUpdate?.(state, jid);
        } catch {
            // presence is best effort
        }
    }

    async #deliver(jid, message, attachment, interactive) {
        // Native buttons first. Media goes out as its own message before the
        // interactive one rather than in the interactive header: a plain media
        // send is the path we know works, and a header-media failure would
        // otherwise lose the attachment and the buttons together.
        if (interactive && interactive.native !== false) {
            if (attachment) await this.#send(jid, attachment);
            try {
                return this.#accepted(await this.#relayNative(jid, message, interactive));
            } catch (err) {
                console.warn(`[baileys] native buttons failed, sending the text menu instead: ${err?.message ?? err}`);
                attachment = null; // already delivered above
            }
        }

        if (interactive?.type === 'carousel') return this.#deliverCarouselText(jid, message, attachment, interactive);
        const text = interactive ? renderFallbackText(message, interactive) : message;
        const sent = await this.#send(jid, attachment ? { ...attachment, caption: text } : { text });
        return this.#accepted(sent?.key?.id);
    }

    // shortcut: N+1 messages in one paced job (main text, then one image per card); the job's receipt is the
    // first message's, and a failure midway leaves the earlier ones sent. Per-card jobs would need queue changes.
    async #deliverCarouselText(jid, message, attachment, interactive) {
        const text = String(message ?? '');
        const first = await this.#send(jid, attachment ? { ...attachment, caption: text } : { text });
        const captions = carouselCaptions(interactive);
        for (const [i, card] of interactive.carousel.cards.entries()) {
            await this.#send(jid, mediaContent(card.media, captions[i]));
        }
        return this.#accepted(first?.key?.id);
    }

    async #send(jid, content) {
        try {
            return await this.sock.sendMessage(jid, content);
        } catch (err) {
            throw new TransportSendError(String(err?.message ?? err), { retryable: true });
        }
    }

    /**
     * viewOnceMessage > interactiveMessage > nativeFlowMessage, relayed with the
     * `biz` node: without that node WhatsApp clients drop or blank the buttons
     * (sock.sendMessage cannot attach it, hence relayMessage). Throws on any
     * failure so the caller falls back to the text menu.
     */
    async #relayNative(jid, text, interactive) {
        const { generateWAMessageFromContent, prepareWAMessageMedia } = await import('@whiskeysockets/baileys');
        // Each card's image is uploaded first; the card header carries the uploaded imageMessage.
        const images = interactive.type === 'carousel'
            ? await Promise.all(interactive.carousel.cards.map(async (card) =>
                (await prepareWAMessageMedia({ image: mediaContent(card.media).image }, { upload: this.sock.waUploadToServer })).imageMessage))
            : null;
        const msg = generateWAMessageFromContent(jid, nativeInteractiveContent(text, interactive, images), { userJid: this.sock.user?.id });
        await this.sock.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes: [NATIVE_FLOW_NODE] });
        return msg.key.id;
    }

    #accepted(id) {
        const providerId = id ?? `local.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
        // A receipt can beat us here; never write SENT over DELIVERED/READ.
        if (!this.receipts.has(providerId)) this.receipts.set(providerId, Status.SENT);
        return {
            providerId,
            status: Status.SENT,
            detail: id ? 'accepted by WhatsApp' : 'sent, but Baileys returned no message id - no DELIVERED/READ for this one',
        };
    }

    /**
     * One `sock.onWhatsApp(...jids)` lookup per batch of 50. Baileys 7 answers
     * only for the numbers that have an account, so a number missing from a
     * successful answer is not on WhatsApp - unless WhatsApp also answered for
     * a jid we did not ask about (it rewrites some numbers, e.g. Brazil's extra
     * 9), in which case the missing ones stay unknown. A batch that fails or
     * takes over 15s leaves its numbers unknown too: the send decides.
     */
    async checkRegistered(phones) {
        const answers = new Map();
        if (!this.connected || typeof this.sock?.onWhatsApp !== 'function') return answers;
        const wanted = [...new Set(phones.map(String).filter((p) => /^\d+$/.test(p)))];
        for (let i = 0; i < wanted.length; i += REGISTRY_BATCH) {
            const batch = wanted.slice(i, i + REGISTRY_BATCH);
            let results;
            try {
                results = await withTimeout(this.sock.onWhatsApp(...batch.map(toJid)), REGISTRY_TIMEOUT_MS);
            } catch (err) {
                console.warn(`[baileys] registration check failed: ${err?.message ?? err}`);
                continue;
            }
            if (!Array.isArray(results)) continue;
            let unexplained = false;
            for (const r of results) {
                const phone = String(r?.jid ?? '').split('@')[0].split(':')[0];
                if (batch.includes(phone)) answers.set(phone, r.exists !== false);
                else unexplained = true;
            }
            if (!unexplained) for (const phone of batch) if (!answers.has(phone)) answers.set(phone, false);
        }
        return answers;
    }

    async #assertOnWhatsApp(jid, recipient) {
        if (typeof this.sock.onWhatsApp !== 'function') return;
        let results;
        try {
            results = await withTimeout(this.sock.onWhatsApp(jid), REGISTRY_TIMEOUT_MS);
        } catch {
            return; // the lookup failed, not the number: let the send decide
        }
        if (!Array.isArray(results)) return;
        // One number asked: an empty answer (Baileys 7) or exists:false (older) both mean no account.
        if (!results.length || results[0]?.exists === false) {
            throw new TransportSendError(`${recipient} is not on WhatsApp`, { retryable: false, code: NOT_ON_WHATSAPP_CODE });
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

/**
 * The extra stanza node Baileys forks attach to native-flow messages so the
 * recipient's app renders the buttons ("mixed" covers quick_reply, cta_* and
 * single_select in one message).
 */
export const NATIVE_FLOW_NODE = Object.freeze({
    tag: 'biz',
    attrs: {},
    content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }],
});

/** nativeFlowMessage buttons for one normalised interactive block. */
export function nativeFlowButtons(interactive) {
    const button = (name, params) => ({ name, buttonParamsJson: JSON.stringify(params) });
    if (interactive.type === 'buttons') {
        return interactive.buttons.map((b) => button('quick_reply', { display_text: b.title, id: b.id }));
    }
    if (interactive.type === 'cta') {
        return interactive.cta.map((c) => {
            if (c.kind === 'call') return button('cta_call', { display_text: c.title, phone_number: c.value });
            if (c.kind === 'copy') return button('cta_copy', { display_text: c.title, copy_code: c.value });
            return button('cta_url', { display_text: c.title, url: c.value, merchant_url: c.value });
        });
    }
    if (interactive.type === 'list') {
        return [button('single_select', {
            title: interactive.list.button,
            sections: interactive.list.sections.map((s) => ({
                title: s.title,
                rows: s.rows.map((r) => ({ id: r.id, title: r.title, description: r.description ?? '' })),
            })),
        })];
    }
    throw new Error(`no native buttons for interactive type "${interactive.type}"`);
}

/** The Message content (pre-proto) for a native-flow interactive message. A carousel also needs `images`: one uploaded imageMessage per card. */
export function nativeInteractiveContent(text, interactive, images = null) {
    if (interactive.type === 'carousel') {
        const { kind, cards } = interactive.carousel;
        return {
            viewOnceMessage: {
                message: {
                    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                    interactiveMessage: {
                        body: { text: String(text ?? '') },
                        carouselMessage: {
                            messageVersion: 1,
                            cards: cards.map((card, i) => ({
                                header: { imageMessage: images[i], hasMediaAttachment: true },
                                body: { text: card.text },
                                nativeFlowMessage: {
                                    buttons: nativeFlowButtons(kind === 'reply' ? { type: 'buttons', buttons: card.buttons } : { type: 'cta', cta: card.cta }),
                                    messageParamsJson: '',
                                },
                            })),
                        },
                    },
                },
            },
        };
    }
    return {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: {
                    header: { title: interactive.header ?? '', hasMediaAttachment: false },
                    body: { text: String(text ?? '') },
                    ...(interactive.footer ? { footer: { text: interactive.footer } } : {}),
                    nativeFlowMessage: { buttons: nativeFlowButtons(interactive), messageParamsJson: '' },
                },
            },
        },
    };
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

/** A group member's phone digits: the PN jid, the phone number WhatsApp sent with a LID, or the LID mapping. */
async function participantPhone(sock, p) {
    let jid = String(p?.phoneNumber ?? '');
    if (/^\d+$/.test(jid)) jid += '@s.whatsapp.net';
    if (!jid && String(p?.id ?? '').endsWith('@s.whatsapp.net')) jid = String(p.id);
    if (!jid && String(p?.id ?? '').endsWith('@lid')) {
        try {
            jid = String(await sock?.signalRepository?.lidMapping?.getPNForLID?.(p.id) ?? '');
        } catch { /* unknown LID */ }
    }
    if (!jid.endsWith('@s.whatsapp.net')) return null;
    return jid.split('@')[0].split(':')[0] || null;
}

async function defaultSocketFactory({ authDir }) {
    const baileys = await import('@whiskeysockets/baileys');
    const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, fetchLatestBaileysVersion } = baileys;
    fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    // Baileys' default pino logger prints every protocol event at 'info';
    // keep warnings and errors on the server log, drop the rest.
    const logger = quietLogger();
    // WhatsApp rejects clients on an old protocol version ("Connection Failure"); the
    // bundled one ages out within weeks. Ask for the current one, fall back to the bundled.
    let version;
    try {
        ({ version } = await fetchLatestBaileysVersion({ signal: AbortSignal.timeout(5000) }));
    } catch {
        // offline or blocked: use the version Baileys shipped with
    }
    const sock = makeWASocket({
        ...(version ? { version } : {}),
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
