/**
 * QR-login delivery through Baileys (@whiskeysockets/baileys): a direct
 * WebSocket client for WhatsApp's multi-device protocol. No browser, no
 * puppeteer, no Chrome: media is encrypted and uploaded by this process, which
 * is why attachments are far more reliable here than through whatsapp-web.js.
 *
 * Same interface and events as the other transports (see base.js), so app.js
 * wiring is unchanged: 'qr' | 'state' | 'ready' | 'disconnected' | 'receipt' | 'inbound',
 * plus 'restricted' { code, until } when WhatsApp caps messages to new people (463 / 475).
 *
 * Visible on every device: buttons, lists and carousels go out as the numbered
 * text menu plus captioned images (native buttons render on some phones only),
 * and every sent message is kept (`messageStore`) so a device that asks for a
 * retry later still gets it instead of "Waiting for this message".
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
import os from 'node:os';
import path from 'node:path';

import NodeCache from '@cacheable/node-cache';

import { SESSION_DIR } from '../config.js';
import { carouselCaptions, renderFallbackText } from '../messaging/interactive.js';
import { maskPhone, maskText } from '../observability/logger.js';
import { fileKeyId } from '../security/crypto.js';
import { STATUS_RANK, Status } from '../protocol.js';
import { NOT_ON_WHATSAPP_CODE, Transport, TransportConnectionError, TransportSendError } from './base.js';
import { useEncryptedAuthState } from './encryptedAuth.js';

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

/** Why WhatsApp rejected a message it had accepted, from the code on the failed ack (Baileys handleBadAck). */
const ACK_ERRORS = {
    463: 'WhatsApp refused this message (error 463): the linked device has no privacy token for this contact yet.',
    475: 'WhatsApp has paused new chats from this number for a while (error 475). Send later, more slowly.',
    479: 'WhatsApp rejected the message (error 479): the recipient\'s device session was out of date.',
};

export function ackError(code) {
    if (!code) return 'Baileys reported a send failure';
    return ACK_ERRORS[code] ?? `WhatsApp rejected the message (error ${code}).`;
}

/** Statuses kept in memory for getStatus(); older ones are forgotten so the map cannot grow without end. */
const RECEIPTS_MAX = 20_000;
const LOGGED_OUT = 401;
const CONNECTION_REPLACED = 440;
const FORBIDDEN = 403; // WhatsApp banned the number (CB:failure)
const BAD_SESSION = 500;
const MULTIDEVICE_MISMATCH = 411;
const RESTART_REQUIRED = 515; // after a QR scan, and now and then: reconnect at once, not a drop
/** Logins Baileys can never use again: cleared, and the number asks for a new QR instead of looping. */
const RESCAN = new Map([
    [BAD_SESSION, 'The saved WhatsApp login is damaged'],
    [MULTIDEVICE_MISMATCH, 'WhatsApp needs this number linked again (multi-device mismatch)'],
]);
export const BAN_TEXT = 'WhatsApp banned this number.';
/** More than this many unexpected socket drops in an hour, in this process, turns on the `unstable` brake. */
export const UNSTABLE_RECONNECTS = 8;
/**
 * Bad sessions (500) in a row, with no open between, before the login is cleared. Baileys also reports 500
 * for network and stream errors it cannot place, so one alone is only a drop.
 */
const BAD_SESSIONS_TO_RESCAN = 3;
/** Rate limits (429) in an hour before the `restricted` brake. */
const RATE_LIMITS_TO_RESTRICT = 3;
/**
 * Unexpected socket drops per login folder, in memory: a clean process start begins at 0, and a process
 * restart is never one of them. Per folder, not per transport object, so a reconnect that builds a new one keeps counting.
 */
const drops = new Map();
const CONNECT_TIMEOUT_MS = 60000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const RECONNECT_JITTER = 0.25;
/** Numbers per `onWhatsApp` lookup, and how long one may take before its numbers count as unknown. */
const REGISTRY_BATCH = 50;
const REGISTRY_TIMEOUT_MS = 15000;
/**
 * The app-state collection WhatsApp keeps the address book in. Its local synced version is current after
 * the first link, so contacts are never pushed again: reading them later needs a forced snapshot.
 */
const CONTACTS_COLLECTION = 'critical_unblock_low';
/** A forced address-book snapshot costs a round trip, so a number asks for at most one every few minutes. */
const ADDRESS_BOOK_REFRESH_MS = 5 * 60_000;
/**
 * Ack errors that mean WhatsApp is capping messages to new people (475 message capping); the reach-out timelock
 * (connection.update) is the other signal. A 463 is never one: it is about one contact's privacy token, which this
 * linked device may lack while the phone has it, so it is resent once and then fails that message alone.
 */
const RESTRICTED_CODES = new Set(['475']);
const TOKEN_MISSING = '463';
const TOKEN_RETRY_MS = 5000;
const RESTRICTED_MIN_MS = 24 * 3_600_000;
const RETRY_MISS = 'recv retry request, but message not available';
/**
 * QR codes shown per Connect. The `qrTimeout` setting (seconds) is the whole window, split evenly between
 * them; once the last one goes unscanned the transport stops instead of showing codes forever.
 */
export const QR_MAX_CODES = 3;
export const QR_EXPIRED_TEXT = 'QR expired, try again.';
/** In each login folder: the pid that is using it, so a second process cannot open the same login. */
export const LOCK_FILE = '.lock';

/** Signal 0 checks a pid exists; EPERM means it does, under another user. */
export function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

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
    supportsContacts = true;
    supportsRegistrationCheck = true;

    /**
     * @param {object} config
     * @param {object} deps `createSocket` is injectable so the tests can drive
     *   this without a network. It must return a Baileys-shaped socket:
     *   { ev, user, sendMessage, onWhatsApp?, logout, end }.
     *   `messageStore` ({ saveSentProto, sentProto }, the channel's db) keeps what was sent for retries.
     */
    constructor(config, {
        createSocket = defaultSocketFactory,
        messageStore = null,
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
        this.messageStore = messageStore;
        // One per transport, not per socket: a reconnect must not reset the retry counts Baileys keeps per message.
        this.retryCache = new NodeCache({ stdTTL: 3600, useClones: false });
        this.restrictedUntil = 0;
        this.rateLimits = []; // when each 429 of the last hour came (#rateLimited)
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
        this.banned = false; // 403: WhatsApp banned this number; reconnecting only deepens it
        this.reconnectTimer = null;
        this.reconnectAttempt = 0;
        this.badSessions = 0; // 500s in a row with no open between (#rescan)
        this.receipts = new Map();
        this.tokenRetried = new Set(); // message ids resent once after a 463; dropped on their second answer
        // The number's address book as WhatsApp syncs it (contacts.upsert / history). Baileys 7 keeps no
        // store of its own, so this is the only place `listContacts()` can read it from. WhatsApp sends
        // the address book once, so the last copy is kept in the session folder and read back on restart.
        this.contacts = new Map();
        this.contactsFile = path.join(this.authDir, 'contacts.json');
        try {
            for (const contact of JSON.parse(fs.readFileSync(this.contactsFile, 'utf8'))) {
                if (contact?.id) this.contacts.set(String(contact.id), contact);
            }
        } catch {
            // first run, or no readable copy: the next sync fills it
        }
        this.contactsRefresh = null; // the in-flight forced snapshot, so concurrent fetches share it
        this.contactsRefreshedAt = 0; // when the last forced snapshot finished
        this.events = new EventEmitter();
        this.qrWindowMs = Math.max(30, Number(config?.qrTimeout) || 180) * 1000;
        this.qrCount = 0; // codes shown since this Connect
        this.qrExpiresAt = null; // ISO time the current code stops working, for the countdown
        this.qrExpired = false; // QR_MAX_CODES went unscanned: stopped until the next Connect
        this.qrTimer = null;
        this.lockFile = null;
    }

    isConnected() {
        return this.connected;
    }

    async connect() {
        this.closed = false;
        this.replaced = false;
        this.banned = false;
        this.loggingOut = false;
        this.#clearReconnectTimer();
        if (this.connecting) {
            throw new TransportConnectionError('Baileys connection already in progress');
        }
        if (this.qrExpired) {
            this.qrExpired = false;
            this.qrCount = 0;
        }
        this.#lock();
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
            sock = await this.createSocket({
                authDir: this.authDir,
                sessionDir: this.sessionDir,
                qrTimeoutMs: Math.round(this.qrWindowMs / QR_MAX_CODES),
                getMessage: (key) => this.#getMessage(key),
                msgRetryCounterCache: this.retryCache,
            });
        } catch (err) {
            throw new TransportConnectionError(`Failed to start Baileys: ${err.message ?? err}`);
        }
        this.sock = sock;

        sock.ev.on('connection.update', (update) => this.#handleConnectionUpdate(sock, update));
        sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify') return; // 'append' is history sync
            for (const msg of messages ?? []) void this.#handleInbound(sock, msg);
        });
        // The history WhatsApp syncs on link lists the number's chats: its one-to-one count suggests the
        // answers to the 2 questions (policy/levels.js suggestStart). Batches add up; a group never counts.
        const chats = new Set();
        sock.ev.on('messaging-history.set', ({ chats: batch, contacts: book }) => {
            for (const chat of batch ?? []) if (String(chat?.id ?? '').endsWith('@s.whatsapp.net')) chats.add(chat.id);
            this.#rememberContacts(book);
            this.events.emit('history', { chats: chats.size });
        });
        // The address book WhatsApp pushes while the session is open (a save on the phone, a new profile name).
        sock.ev.on('contacts.upsert', (list) => this.#rememberContacts(list));
        sock.ev.on('contacts.update', (list) => this.#rememberContacts(list));
        sock.ev.on('messages.update', (updates) => {
            for (const { key, update } of updates ?? []) {
                // A failed ack carries WhatsApp's error code (messages-recv.js handleBadAck).
                const code = String(update?.messageStubParameters?.[0] ?? '');
                if (RESTRICTED_CODES.has(code)) this.#restricted(code, Date.now() + RESTRICTED_MIN_MS);
                if (update?.status == null) continue;
                // 463 is a missing privacy token as often as a restriction: Baileys asks WhatsApp for the token on
                // its own, so send the same message once more; only a second 463 fails it.
                if (code === TOKEN_MISSING && key?.id && key.remoteJid && !this.tokenRetried.has(key.id)) {
                    // Only a second 463 clears an id (a sent/delivered update in between must not allow a second resend);
                    // ids that went through stay, so the set is capped like receipts.
                    if (this.tokenRetried.size >= RECEIPTS_MAX) this.tokenRetried.delete(this.tokenRetried.values().next().value);
                    this.tokenRetried.add(key.id);
                    this.setTimeoutFn(() => { void this.#resendWithToken(sock, key); }, TOKEN_RETRY_MS);
                    continue;
                }
                // A second 463 fails this one message only: it is about this contact, not the whole number (the phone
                // can still message them). WhatsApp signals a real restriction with 475 or the reach-out timelock.
                if (code === TOKEN_MISSING) this.tokenRetried.delete(key?.id);
                this.#emitReceipt(key?.id, ackStatus(update.status), code);
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
                        qrExpiresAt: this.qrExpiresAt,
                    });
                } else if (connection === 'open') {
                    finish(resolve, this.#readyInfo(sock));
                } else if (connection === 'close' && statusCode(lastDisconnect) === FORBIDDEN) {
                    finish(reject, new TransportConnectionError(`${BAN_TEXT} (${reasonText(lastDisconnect)})`, { retryable: false }));
                } else if (connection === 'close' && statusCode(lastDisconnect) === LOGGED_OUT) {
                    this.#dropSession();
                    finish(reject, new TransportConnectionError(
                        `Baileys authentication failed: ${reasonText(lastDisconnect)}. The saved login was rejected and has been cleared: connect again and scan the QR code.`, { retryable: false }));
                } else if (connection === 'close' && this.#rescan(statusCode(lastDisconnect))) {
                    this.#dropSession();
                    finish(reject, new TransportConnectionError(
                        `${RESCAN.get(statusCode(lastDisconnect))}. It has been cleared: connect again and scan the QR code.`, { retryable: false }));
                } else if (connection === 'close' && statusCode(lastDisconnect) === BAD_SESSION) {
                    finish(reject, new TransportConnectionError(`Baileys connection closed: ${reasonText(lastDisconnect)}`));
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
        this.qrCount = 0;
        this.qrExpiresAt = null;
        this.#clearQrTimer();
        this.reconnectAttempt = 0;
        this.badSessions = 0;
        this.account = accountOf(sock);
        return {
            connected: true,
            account: this.account,
            detail: `QR session, no access token, no browser. ${TOS_WARNING}`,
            realDelivery: true,
        };
    }

    #handleConnectionUpdate(sock, { connection, lastDisconnect, qr, reachoutTimeLock }) {
        if (sock !== this.sock) return;
        if (reachoutTimeLock?.isActive) {
            const ends = new Date(reachoutTimeLock.timeEnforcementEnds ?? 0).getTime() || 0;
            this.#restricted('timelock', Math.max(ends, Date.now() + RESTRICTED_MIN_MS));
        }
        if (qr) {
            if (this.qrCount >= QR_MAX_CODES) {
                this.#expireQr();
                return;
            }
            this.qrCount += 1;
            this.qr = qr;
            const lifeMs = Math.round(this.qrWindowMs / QR_MAX_CODES);
            this.qrExpiresAt = new Date(Date.now() + lifeMs).toISOString();
            if (this.qrCount === QR_MAX_CODES) {
                // The last code: when it runs out unscanned, stop (Baileys would otherwise close and reconnect).
                this.#clearQrTimer();
                this.qrTimer = setTimeout(() => { if (!this.connected) this.#expireQr(); }, lifeMs);
                this.qrTimer.unref?.();
            }
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
            const wasOpen = this.connected;
            this.connected = false;
            const code = statusCode(lastDisconnect);
            const detail = reasonText(lastDisconnect);
            if (code === BAD_SESSION) this.badSessions += 1;
            if (code === LOGGED_OUT) {
                this.#dropSession();
                this.#stopAutoReconnect();
                this.qr = null;
                // Not our own logout(): the device was removed from the phone, or WhatsApp ended the session.
                if (!this.loggingOut) this.events.emit('logged_out', { detail });
                this.events.emit('state', { state: 'auth_failure', detail: `Baileys session logged out: ${detail}` });
                return;
            }
            if (this.#rescan(code)) {
                // Reconnecting with this login fails the same way forever: clear it and ask for a new QR scan.
                this.#dropSession();
                this.#stopAutoReconnect();
                this.qr = null;
                this.events.emit('state', { state: 'auth_failure', detail: `${RESCAN.get(code)}: scan a new QR code to link it again.` });
                return;
            }
            if (code === RESTART_REQUIRED) {
                // Expected (always right after a QR scan): reconnect at once, and it is not a drop.
                this.#scheduleReconnect(detail, { now: true });
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
            if (code === FORBIDDEN) {
                // Retrying a banned number only deepens the ban. Keep the session: a temporary ban lifts, and wiping it would force a new QR.
                console.warn('[baileys] banned (403):', JSON.stringify(lastDisconnect?.error?.data ?? null));
                this.#stopAutoReconnect();
                this.banned = true;
                this.events.emit('state', { state: 'banned', detail: BAN_TEXT });
                return;
            }
            this.events.emit('state', { state: 'disconnected', detail });
            // Only a socket that was open drops: failed reconnects (a host network outage) are not the number's health.
            if (wasOpen) this.#countDrop();
            this.#scheduleReconnect(detail);
        }
    }

    /** A 411 at once; a 500 only on the BAD_SESSIONS_TO_RESCAN-th in a row. */
    #rescan(code) {
        return code === BAD_SESSION ? this.badSessions >= BAD_SESSIONS_TO_RESCAN : RESCAN.has(code);
    }

    /** One unexpected drop; past UNSTABLE_RECONNECTS in the last hour, 'unstable' (app.js starts the 8h brake). */
    #countDrop(now = Date.now()) {
        const recent = (drops.get(this.authDir) ?? []).filter((at) => now - at < 3_600_000);
        recent.push(now);
        drops.set(this.authDir, recent);
        if (recent.length > UNSTABLE_RECONNECTS) this.events.emit('unstable', { reconnects: recent.length });
    }

    /** Unexpected socket drops of this login in the last hour, this process. */
    get reconnectsLastHour() {
        return (drops.get(this.authDir) ?? []).filter((at) => Date.now() - at < 3_600_000).length;
    }

    /** Remember a message's latest status; the oldest is forgotten past RECEIPTS_MAX (the database keeps them all). */
    #receipt(providerId, status) {
        if (!this.receipts.has(providerId) && this.receipts.size >= RECEIPTS_MAX) this.receipts.delete(this.receipts.keys().next().value);
        this.receipts.set(providerId, status);
    }

    #emitReceipt(providerId, status, code = '') {
        if (!providerId || !status) return;
        if (status === Status.FAILED) console.warn(`[baileys] WhatsApp rejected message ${providerId}${code ? ` (error ${code})` : ''}`);
        // A late "delivered" must not hide a "read" the memory already holds.
        const known = this.receipts.get(providerId);
        if (!known || (STATUS_RANK[status] ?? 0) > (STATUS_RANK[known] ?? 0) || status === Status.FAILED) {
            this.#receipt(providerId, status);
        }
        this.events.emit('receipt', {
            providerId,
            status,
            error: status === Status.FAILED ? ackError(code) : null,
        });
    }

    #restricted(code, untilMs) {
        // A campaign's failed acks arrive in a burst: one event per minute of extension is enough.
        if (untilMs - this.restrictedUntil < 60_000) return;
        this.restrictedUntil = untilMs;
        this.events.emit('restricted', { code, until: new Date(untilMs).toISOString() });
    }

    /** One 429; RATE_LIMITS_TO_RESTRICT in an hour turn on the `restricted` brake. */
    #rateLimited(now = Date.now()) {
        this.rateLimits = this.rateLimits.filter((at) => now - at < 3_600_000);
        this.rateLimits.push(now);
        if (this.rateLimits.length >= RATE_LIMITS_TO_RESTRICT) this.#restricted('429', now + RESTRICTED_MIN_MS);
    }

    /** The one resend after a 463 (see messages.update): same id, so its receipt lands on the same job. */
    async #resendWithToken(sock, key) {
        const message = await this.#getMessage(key);
        try {
            if (!message || sock !== this.sock) throw new Error('message or connection gone');
            await sock.relayMessage(key.remoteJid, message, { messageId: key.id });
        } catch {
            this.tokenRetried.delete(key.id);
            this.#emitReceipt(key.id, Status.FAILED, TOKEN_MISSING);
        }
    }

    /**
     * Baileys asks for a sent message when a recipient device requests a retry. By id only, so a
     * receipt keyed by the LID still hits. Undefined on a miss: an empty message would be resent as blank.
     */
    async #getMessage(key) {
        try {
            const bytes = key?.id ? this.messageStore?.sentProto(key.id) : null;
            if (!bytes) return undefined;
            const { proto } = await import('@whiskeysockets/baileys');
            return proto.Message.decode(bytes);
        } catch (err) {
            console.warn(`[baileys] could not read message ${key?.id} for a retry: ${err?.message ?? err}`);
            return undefined;
        }
    }

    async #remember(sent) {
        if (!this.messageStore || !sent?.key?.id || !sent.message) return;
        try {
            const { proto } = await import('@whiskeysockets/baileys');
            this.messageStore.saveSentProto(sent.key.id, proto.Message.encode(sent.message).finish());
        } catch (err) {
            console.warn(`[baileys] could not keep message ${sent.key.id} for retries: ${err?.message ?? err}`);
        }
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

    /** `now`: reconnect at once without counting an attempt (a 515 restart is not a failure). */
    #scheduleReconnect(reason, { now = false } = {}) {
        if (this.closed || this.reconnectTimer || this.connecting) return;
        if (!now) this.reconnectAttempt += 1;
        const delay = now ? 0 : this.#nextReconnectDelay();
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
        this.#forgetContacts();
        try {
            fs.rmSync(this.authDir, { recursive: true, force: true });
        } catch {
            // best effort: the next logout() tries again
        }
    }

    /** Forget the address book a previous login left in memory (its file lives in the session folder). */
    #forgetContacts() {
        this.contacts.clear();
        this.contactsRefresh = null;
        this.contactsRefreshedAt = 0;
    }

    #stopAutoReconnect() {
        this.closed = true;
        this.#clearReconnectTimer();
    }

    #clearQrTimer() {
        if (this.qrTimer) clearTimeout(this.qrTimer);
        this.qrTimer = null;
    }

    /** QR_MAX_CODES codes went unscanned: close the socket and wait for the user to press Connect again. */
    #expireQr() {
        if (this.qrExpired) return;
        this.qrExpired = true;
        this.qr = null;
        this.qrExpiresAt = null;
        this.#clearQrTimer();
        this.#stopAutoReconnect();
        const sock = this.sock;
        if (sock) void this.#endSocket(sock);
        this.#unlock();
        this.events.emit('state', { state: 'qr_expired', detail: QR_EXPIRED_TEXT });
    }

    /**
     * Claim the login folder for this process. A lock left by a process that has exited, or by one from before
     * the last reboot (its pid may now be someone else's), is taken over; a live one refuses.
     */
    #lock() {
        const file = path.join(this.sessionDir, LOCK_FILE);
        const boot = Math.round(Date.now() / 1000 - os.uptime());
        fs.mkdirSync(this.sessionDir, { recursive: true });
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                fs.writeFileSync(file, JSON.stringify({ pid: process.pid, boot }), { flag: 'wx' });
                this.lockFile = file;
                return;
            } catch (err) {
                if (err.code !== 'EEXIST') throw err;
            }
            let held = {};
            try {
                held = JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch {
                // unreadable: treat as stale
            }
            if (held.pid && held.pid !== process.pid && Math.abs((held.boot ?? 0) - boot) < 120 && pidAlive(held.pid)) {
                throw new TransportConnectionError(
                    `This number's login folder is in use by another server process (pid ${held.pid}). Stop that process, then connect again.`,
                    { retryable: false, code: 'WHATSAPP_WEB_PROFILE_LOCKED' });
            }
            fs.rmSync(file, { force: true });
        }
        throw new TransportConnectionError("Could not lock this number's login folder", { retryable: false, code: 'WHATSAPP_WEB_PROFILE_LOCKED' });
    }

    #unlock() {
        if (!this.lockFile) return;
        try {
            if (JSON.parse(fs.readFileSync(this.lockFile, 'utf8')).pid === process.pid) fs.rmSync(this.lockFile, { force: true });
        } catch {
            // already gone
        }
        this.lockFile = null;
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
        this.#clearQrTimer();
        this.connected = false;
        this.qr = null;
        this.qrExpiresAt = null;
        const sock = this.sock;
        this.sock = null;
        if (sock) await this.#endSocket(sock);
        if (this.contactsSave) this.#flushContacts(); // a pending save is written before the session closes
        this.#unlock();
    }

    /** Unlink the device and drop the cached session so the next connect asks for a new QR. */
    async logout() {
        if (this.sock) {
            this.loggingOut = true; // the 401 this causes is ours, not an unexpected logout
            try {
                await this.sock.logout();
            } catch {
                // fall through
            }
        }
        await this.disconnect();
        this.#forgetContacts();
        fs.rmSync(this.authDir, { recursive: true, force: true });
    }

    async sendMessage(recipient, message, { media = null, interactive = null, typingMs = 0, registered = false, nativeCarousel = false } = {}) {
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
            return await this.#deliver(jid, message, attachment, interactive, typingMs, nativeCarousel);
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
            const participants = g.participants ?? [];
            // LID lookups are independent: ask for every member at once, keep the order.
            const phones = await Promise.all(participants.map((p) => phoneOf(sock, p)));
            for (const [i, p] of participants.entries()) {
                const phone = phones[i];
                if (!phone) hidden += 1;
                else if (phone !== this.account && !members.has(phone)) {
                    // Group metadata carries a profile name / username when WhatsApp knows one for the member.
                    const name = String(p.name || p.notify || p.verifiedName || p.username || '').trim();
                    const username = String(p.username || '').trim();
                    members.set(phone, { phone, admin: p.admin ?? null, ...(name && { name }), ...(username && { username }) });
                }
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

    /**
     * The numbers in this account's own address book (the contacts saved on the phone), with the
     * name WhatsApp shows for each: [{ phone, name, saved }]. `saved` is true when the user put the
     * name in their address book; a profile name alone leaves it false. A contact WhatsApp only
     * knows by LID, with no number in the LID mapping, is counted in `hidden`.
     */
    async listContacts() {
        if (!this.connected || !this.sock) {
            throw new TransportConnectionError('WhatsApp is not connected', { retryable: true });
        }
        const sock = this.sock;
        // A number linked before the address book was kept, or a run that only saw profile names from
        // incoming messages, has no saved contacts yet - and WhatsApp will not push the book again.
        if (!this.#hasAddressBook()) await this.#refreshAddressBook(sock);
        const byPhone = new Map();
        let hidden = 0;
        const book = [...this.contacts.values()];
        const phones = await Promise.all(book.map((contact) => phoneOf(sock, contact)));
        for (const [i, contact] of book.entries()) {
            const phone = phones[i];
            if (!phone) {
                hidden += 1;
                continue;
            }
            if (phone === this.account) continue;
            const name = String(contact.name || contact.verifiedName || contact.notify || '').trim();
            const saved = Boolean(contact.name);
            const row = byPhone.get(phone);
            if (!row) byPhone.set(phone, { phone, name, saved });
            // The address-book name wins over a profile name seen for the same number.
            else if (saved && (!row.saved || !row.name)) Object.assign(row, { name, saved: true });
            else if (!row.name && name) row.name = name;
        }
        return {
            contacts: [...byPhone.values()].sort((a, b) => a.phone.localeCompare(b.phone)),
            hidden,
        };
    }

    /** True once WhatsApp has sent the address book itself: a saved contact always carries the name the user gave it. */
    #hasAddressBook() {
        for (const contact of this.contacts.values()) if (contact.name) return true;
        return false;
    }

    /**
     * WhatsApp sends the address book on the first link, then its synced version says "already seen"
     * and it is never pushed again. Forgetting that version and asking for the contact collection's
     * snapshot makes WhatsApp send every saved contact again; the `contacts.upsert` listener fills
     * the map. One snapshot at a time, at most one every few minutes, and never fatal: a failure just
     * leaves whatever the map already had.
     */
    #refreshAddressBook(sock) {
        if (this.contactsRefresh) return this.contactsRefresh;
        if (typeof sock?.resyncAppState !== 'function') return Promise.resolve();
        if (Date.now() - this.contactsRefreshedAt < ADDRESS_BOOK_REFRESH_MS) return Promise.resolve();
        this.contactsRefresh = (async () => {
            try {
                // `null` deletes the stored version (useMultiFileAuthState), so the sync returns a snapshot.
                await sock.authState?.keys?.set?.({ 'app-state-sync-version': { [CONTACTS_COLLECTION]: null } });
                await sock.resyncAppState([CONTACTS_COLLECTION], true);
                // The re-sync emits through Baileys' event buffer: deliver it now, not on its timer.
                sock.ev?.flush?.();
                this.contactsRefreshedAt = Date.now();
            } catch {
                // WhatsApp is busy or the snapshot key is missing: try again on a later fetch
            } finally {
                this.contactsRefresh = null;
            }
        })();
        return this.contactsRefresh;
    }

    /** Merge a batch of contacts, then keep the copy a restart reads. */
    #rememberContacts(list) {
        let changed = false;
        for (const contact of list ?? []) changed = this.#rememberContact(contact) || changed;
        if (changed) this.#saveContacts();
    }

    /** Merge one contact (a full row from upsert/history, a partial from contacts.update) into the map. */
    #rememberContact(contact) {
        const id = String(contact?.id ?? '').trim();
        // Only people: a group, broadcast list or newsletter is not an address-book contact.
        if (!/@(s\.whatsapp\.net|lid)$/.test(id)) return false;
        const before = this.contacts.get(id) ?? { id };
        const merged = { ...before };
        for (const [key, value] of Object.entries(contact)) if (value != null) merged[key] = value;
        merged.id = id;
        // contacts.update fires for every message carrying a push name, usually the one already kept:
        // only a real change is worth rewriting the file.
        if (JSON.stringify(merged) === JSON.stringify(before)) return false;
        this.contacts.set(id, merged);
        return true;
    }

    /** History sync sends the book in many batches: write it at most every 5s, not once per batch. */
    #saveContacts() {
        if (this.contactsSave) return;
        this.contactsSave = setTimeout(() => this.#flushContacts(), 5000);
        this.contactsSave.unref?.();
    }

    /** Best effort: a failed write only means the next restart syncs the address book again. */
    #flushContacts() {
        clearTimeout(this.contactsSave);
        this.contactsSave = null;
        try {
            fs.mkdirSync(this.authDir, { recursive: true });
            fs.writeFileSync(this.contactsFile, JSON.stringify([...this.contacts.values()]));
        } catch {
            // the fetch still answers from memory
        }
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

    async #deliver(jid, message, attachment, interactive, typingMs, nativeCarousel = false) {
        // No native buttons: they render on some devices only, and Baileys' retry resend drops the node they need.
        // A carousel is the one exception, by the user's choice: native unless the admin picked separate images.
        if (interactive?.type === 'carousel') {
            return nativeCarousel
                ? this.#deliverCarouselNative(jid, message, interactive)
                : this.#deliverCarouselText(jid, message, attachment, interactive, typingMs);
        }
        const text = interactive ? renderFallbackText(message, interactive) : message;
        const sent = await this.#send(jid, attachment ? { ...attachment, caption: text } : { text });
        return this.#accepted(sent?.key?.id);
    }

    /**
     * The carousel every device shows: the main text, then one plain image (or video, or document) per card, each
     * card's text and options its caption. WhatsApp itself groups 4+ consecutive photos into a grid, and any photo
     * opens the swipe viewer. No explicit album message: iPhones never showed the photos tied to a Baileys album.
     * shortcut: N+1 messages in one paced job; the job's receipt is the first message's, and a failure midway leaves
     * the earlier ones sent. Per-card jobs would need queue changes.
     */
    async #deliverCarouselText(jid, message, attachment, interactive, typingMs) {
        const text = String(message ?? '');
        const first = await this.#send(jid, attachment ? { ...attachment, caption: text } : { text });
        const captions = carouselCaptions(interactive);
        const media = interactive.carousel.cards.map((card, i) => mediaContent(card.media, captions[i]));
        for (const content of media) {
            if (typingMs > 0) {
                await this.#presence('composing', jid);
                await new Promise((resolve) => setTimeout(resolve, typingMs));
            }
            await this.#send(jid, content);
        }
        // `parts`: the budgets and the rests count each WhatsApp message, not the one job.
        return { ...this.#accepted(first?.key?.id), parts: 1 + media.length };
    }

    /**
     * WhatsApp's swipe carousel: one interactive message, each card an uploaded image, its text and its buttons
     * (quick replies or one link). A tap comes back as interactiveResponseMessage, which the inbound parser reads.
     * iOS drops the native carousel when it is wrapped in viewOnceMessage or a card lacks messageParamsJson;
     * send it raw, label each card by index, and mark the carousel type. sending.carouselImages switches back
     * to separate images per card for tenants that want the guaranteed-everywhere fallback.
     */
    async #deliverCarouselNative(jid, message, interactive) {
        const { generateWAMessageFromContent, prepareWAMessageMedia } = await import('@whiskeysockets/baileys');
        const { kind, cards } = interactive.carousel;
        const built = [];
        for (const card of cards) {
            const media = mediaContent(card.media);
            if (!media.image) throw new TransportSendError('A carousel card needs an image.', { retryable: false });
            const { imageMessage } = await prepareWAMessageMedia({ image: media.image }, { upload: this.sock.waUploadToServer, mediaCache });
            const buttons = kind === 'url'
                ? (card.cta ?? []).map((b) => ({ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: b.title, url: b.value, merchant_url: b.value }) }))
                : (card.buttons ?? []).map((b) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: b.title, id: b.id }) }));
            // iOS drops a card whose nativeFlowMessage lacks messageParamsJson; label each card by index.
            built.push({ header: { hasMediaAttachment: true, imageMessage }, ...(card.text ? { body: { text: card.text } } : {}), nativeFlowMessage: { buttons, messageParamsJson: JSON.stringify({ card_index: String(built.length) }) } });
        }
        const content = {
            interactiveMessage: { ...(message ? { body: { text: String(message) } } : {}), carouselMessage: { cards: built, messageVersion: 1, carouselCardType: 'UNKNOWN' } }
        };
        const msg = generateWAMessageFromContent(jid, content, { userJid: this.sock.user?.id });
        // Phones drop a native-flow message whose stanza lacks this biz node; Web renders it either way.
        // shortcut: Baileys' retry resend leaves the node out, so a phone that asks for a retry still sees nothing.
        const bizNode = { tag: 'biz', attrs: {}, content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }] };
        // shortcut: the bot node is a 1:1 trick seen in Baileys helpers, unverified; drop it if phones still show nothing.
        const additionalNodes = jid.endsWith('@g.us') ? [bizNode] : [bizNode, { tag: 'bot', attrs: { biz_bot: '1' } }];
        const sent = await this.#send(jid, null, () => this.sock.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes }).then(() => msg));
        return { ...this.#accepted(sent?.key?.id), parts: 1 };
    }

    async #send(jid, content, deliver = () => this.sock.sendMessage(jid, content)) {
        let sent;
        try {
            sent = await deliver();
        } catch (err) {
            const text = String(err?.message ?? err);
            // WhatsApp's rate limit: Baileys raises data 429, "rate-overlimit". The manager backs off 90s or more.
            const limited = err?.data === 429 || err?.output?.statusCode === 429 || /rate-overlimit/i.test(text);
            if (limited) this.#rateLimited();
            throw new TransportSendError(text, { retryable: true, code: limited ? 'RATE_LIMITED' : null });
        }
        await this.#remember(sent);
        return sent;
    }

    #accepted(id) {
        const providerId = id ?? `local.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
        // A receipt can beat us here; never write SENT over DELIVERED/READ.
        if (!this.receipts.has(providerId)) this.#receipt(providerId, Status.SENT);
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
                console.warn(maskText(`[baileys] registration check failed: ${err?.message ?? err}`));
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
/**
 * Uploaded media, keyed by kind and file path: a campaign sends the same image to every recipient, and Baileys only
 * looks a file up here when it is given as `{ url }`. An hour stays well inside how long WhatsApp keeps an upload.
 * shortcut: keyed by path, so a file must not be rewritten in place; media-library files are write-once.
 */
export const mediaCache = {
    ttlMs: 3_600_000,
    max: 200,
    entries: new Map(),
    get(key) {
        const hit = this.entries.get(key);
        if (hit && hit.until > Date.now()) return hit.value;
        this.entries.delete(key);
        return undefined;
    },
    set(key, value) {
        if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value);
        this.entries.set(key, { value, until: Date.now() + this.ttlMs });
    },
};

export function mediaContent(media, caption) {
    // A file on disk goes as a path so mediaCache can skip re-uploading it; a buffer has no stable key.
    if (!Buffer.isBuffer(media.buffer)) fs.accessSync(media.filePath); // a missing file fails here, not mid-upload
    const data = Buffer.isBuffer(media.buffer) ? media.buffer : { url: media.filePath };
    const mimetype = media.mimetype || 'application/octet-stream';
    const fileName = media.filename || path.basename(String(media.filePath ?? 'attachment'));
    const kind = mimetype.split('/')[0];
    if (kind === 'image') return { image: data, caption, mimetype };
    // Only mp4 plays everywhere; 3gp, mov or webm shows a broken player on some devices, a document opens.
    if (mimetype === 'video/mp4') return { video: data, caption, mimetype };
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

/** A contact's or group member's phone digits: the PN jid, the phone number WhatsApp sent with a LID, or the LID mapping. */
async function phoneOf(sock, p) {
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

async function defaultSocketFactory({ authDir, qrTimeoutMs, getMessage, msgRetryCounterCache }) {
    const baileys = await import('@whiskeysockets/baileys');
    const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, fetchLatestBaileysVersion } = baileys;
    fs.mkdirSync(authDir, { recursive: true });
    // WHATSAPP_ENCRYPT_AUTH=1 seals every login file (encryptedAuth.js). With the flag off, Baileys' own reader
    // would take a sealed creds.json for a missing one and start a fresh login: refuse instead (keyGate.js
    // stops this at startup; this covers a sealed file copied in later).
    const encrypt = process.env.WHATSAPP_ENCRYPT_AUTH === '1';
    const creds = path.join(authDir, 'creds.json');
    if (!encrypt && fs.existsSync(creds) && fileKeyId(creds).encrypted) {
        throw new TransportConnectionError('This login is encrypted but WHATSAPP_ENCRYPT_AUTH is off; see docs/OPS.md',
            { retryable: false, code: 'WHATSAPP_AUTH_ENCRYPTED' });
    }
    const { state, saveCreds } = encrypt ? await useEncryptedAuthState(authDir) : await useMultiFileAuthState(authDir);
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
        getMessage,
        msgRetryCounterCache,
        patchMessageBeforeSending: ownDeviceCopy,
        mediaCache,
        ...(qrTimeoutMs ? { qrTimeout: qrTimeoutMs } : {}),
    });
    sock.ev.on('creds.update', saveCreds);
    return sock;
}

/**
 * The copy of a sent message for this number's own phone and Web (a deviceSentMessage). Those devices
 * hide a carousel wrapped in viewOnceMessage, so they get the interactive message unwrapped; recipients
 * keep the wrapped one, which they show.
 */
export function ownDeviceCopy(msg) {
    const inner = msg?.deviceSentMessage?.message?.viewOnceMessage?.message;
    if (!inner?.interactiveMessage) return msg;
    return {
        ...msg,
        deviceSentMessage: { ...msg.deviceSentMessage, message: inner },
        messageContextInfo: inner.messageContextInfo ?? msg.messageContextInfo,
    };
}

/**
 * pino-shaped logger: warn/error to the console, everything below dropped, except a retry that
 * found no stored message: that recipient device shows "Waiting for this message".
 */
export function quietLogger() {
    const noop = () => {};
    const out = (level) => (obj, msg) => console[level](maskText(`[baileys] ${msg ?? ''}`), maskText(typeof obj === 'string' ? obj : obj?.err?.message ?? obj?.error?.message ?? ''));
    const logger = {
        level: 'warn',
        trace: noop, info: noop,
        debug: (obj, msg) => { if (msg === RETRY_MISS) console.warn(`[baileys] ${msg}`, maskPhone(obj?.jid ?? ''), obj?.id ?? ''); },
        warn: out('warn'), error: out('error'), fatal: out('error'),
        child: () => logger,
    };
    return logger;
}
