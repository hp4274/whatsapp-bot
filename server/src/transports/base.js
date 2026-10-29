/**
 * Transport interface.  The API layer and the campaign engine talk to this
 * only - they never know whether the bytes go to a QR-linked WhatsApp
 * session (Baileys) or to a local file.
 */

export class TransportError extends Error {
    constructor(message, { retryable = true, code = null } = {}) {
        super(message);
        this.name = 'TransportError';
        this.retryable = retryable;
        this.code = code;
    }
}

/** `TransportError.code` of a send refused because the number has no WhatsApp account. */
export const NOT_ON_WHATSAPP_CODE = 'not_on_whatsapp';

export class TransportConnectionError extends TransportError {
    constructor(message, options) {
        super(message, options);
        this.name = 'TransportConnectionError';
    }
}

export class TransportSendError extends TransportError {
    constructor(message, options) {
        super(message, options);
        this.name = 'TransportSendError';
    }
}

/**
 * @typedef {{mediaId?: string, filename: string, mimetype: string, size: number,
 *            filePath?: string, buffer?: Buffer}} MediaPayload
 * @typedef {{providerId: string, status: string, detail?: string}} SendResult
 * @typedef {{connected: boolean, account?: string, detail?: string,
 *            realDelivery?: boolean}} ConnectionInfo
 */

export class Transport {
    /** Human readable name shown in the UI. */
    static name_ = 'transport';
    /** True only when messages reach real WhatsApp users. */
    realDelivery = false;
    /** True when the transport can report DELIVERED/READ receipts. */
    supportsReceipts = false;
    /** True when the transport can list the groups the number is in (`listGroups()`). */
    supportsGroups = false;
    /** True when the transport can list the number's own address book (`listContacts()`). */
    supportsContacts = false;
    /** True when `checkRegistered()` can actually ask WhatsApp. */
    supportsRegistrationCheck = false;

    get name() {
        return this.constructor.name_;
    }

    /** Authenticate / open the session. Throws TransportConnectionError. */
    async connect() {
        throw new Error('not implemented');
    }

    /** Close the session. Must be safe to call when already closed. */
    async disconnect() {}

    /** Send one message. Throws TransportSendError on failure. */
    async sendMessage(_recipient, _message, { media = null } = {}) {
        void media;
        throw new Error('not implemented');
    }

    /**
     * Which of these numbers have a WhatsApp account: phone -> true | false.
     * A number left out is unknown, and an unknown number is sent to as usual,
     * so a transport that cannot tell answers with an empty map.
     */
    async checkRegistered(_phones) {
        return new Map();
    }

    /** Latest status known for a provider message id, or null - never a guess. */
    getStatus() {
        return null;
    }

    isConnected() {
        return false;
    }

    async reconnect() {
        try {
            await this.disconnect();
        } catch {
            // reconnect must not die on cleanup
        }
        return this.connect();
    }
}
