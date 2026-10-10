/**
 * Real delivery through the WhatsApp Business Cloud API (Meta Graph API).
 *
 * The only publicly documented, officially supported programmatic send path.
 * Needs a Meta app, a WhatsApp Business Account, a phone_number_id and an
 * access token.
 *
 * Limits you will hit: free-form text only reaches a user who messaged you in
 * the last 24 hours (otherwise send an approved template, error 131047, which
 * is NOT retried here because retrying cannot fix it); test numbers may only
 * message verified recipients; throughput is set by Meta per number.
 *
 * The send call only reports "accepted" -> SENT.  DELIVERED and READ exist
 * only as webhook receipts, so they are written by the webhook route and never
 * inferred locally.
 */

import { graphBaseUrl } from '../config.js';
import { renderFallbackText } from '../messaging/interactive.js';
import { Status } from '../protocol.js';
import { Transport, TransportConnectionError, TransportSendError } from './base.js';

/** Meta error codes worth another attempt. Everything else is permanent. */
export const RETRYABLE_ERROR_CODES = new Set([
    130429, // rate limit hit
    131048, // spam rate limit hit
    131056, // pair rate limit hit
    133016, // too many requests / temporary block
    131000, // generic something went wrong
    1, 2, 4, // API unknown / unavailable / too many calls
    80007,  // rate limit issues
]);

/** Codes that mean "your credentials are wrong" - a connection problem. */
export const AUTH_ERROR_CODES = new Set([190, 102, 10, 200, 3]);

export const WEBHOOK_STATUS_MAP = Object.freeze({
    sent: Status.SENT,
    delivered: Status.DELIVERED,
    read: Status.READ,
    failed: Status.FAILED,
});

export class CloudApiTransport extends Transport {
    static name_ = 'WhatsApp Business Cloud API';
    realDelivery = true;
    supportsReceipts = true;

    constructor(config, { fetchImpl = fetch } = {}) {
        super();
        this.config = config;
        this.fetch = fetchImpl;
        this.connected = false;
        this.account = '';
        this.receipts = new Map();
    }

    get messagesUrl() {
        return `${graphBaseUrl(this.config)}/${this.config.phoneNumberId}/messages`;
    }

    get mediaUrl() {
        return `${graphBaseUrl(this.config)}/${this.config.phoneNumberId}/media`;
    }

    headers() {
        return {
            Authorization: `Bearer ${this.config.accessToken}`,
            'Content-Type': 'application/json',
        };
    }

    authHeaders() {
        return { Authorization: `Bearer ${this.config.accessToken}` };
    }

    async connect() {
        const url = new URL(`${graphBaseUrl(this.config)}/${this.config.phoneNumberId}`);
        url.searchParams.set('fields', 'display_phone_number,verified_name,quality_rating');
        let response;
        try {
            response = await this.fetch(url, {
                headers: this.headers(),
                signal: AbortSignal.timeout(this.config.requestTimeout * 1000),
            });
        } catch (err) {
            throw new TransportConnectionError(`Network error reaching Graph API: ${err.message}`);
        }
        if (response.status !== 200) {
            const { code, message } = await parseError(response);
            throw new TransportConnectionError(
                `Graph API rejected the credentials (${response.status}/${code}): ${message}`,
                { retryable: !AUTH_ERROR_CODES.has(code), code });
        }
        const data = await response.json();
        this.account = `${data.verified_name ?? ''} (${data.display_phone_number ?? this.config.phoneNumberId})`.trim();
        this.connected = true;
        return {
            connected: true,
            account: this.account,
            detail: `quality: ${data.quality_rating ?? 'UNKNOWN'}`,
            qualityRating: data.quality_rating ?? null, // the ban-risk guard reads this (policy/channelOps.js)
            realDelivery: true,
        };
    }

    async disconnect() {
        this.connected = false;
    }

    isConnected() {
        return this.connected;
    }

    payload(recipient, message, { uploadedMedia = null } = {}) {
        if (uploadedMedia) {
            const kind = uploadedMedia.mimetype?.split('/')[0];
            const type = kind === 'image' || kind === 'video' ? kind : 'document';
            return {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: recipient,
                type,
                [type]: {
                    id: uploadedMedia.id,
                    caption: message,
                    ...(type === 'document' ? { filename: uploadedMedia.filename } : {}),
                },
            };
        }
        if (this.config.useTemplate) {
            return {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: recipient,
                type: 'template',
                template: {
                    name: this.config.templateName,
                    language: { code: this.config.templateLanguage },
                    components: [{ type: 'body', parameters: [{ type: 'text', text: message }] }],
                },
            };
        }
        return {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipient,
            type: 'text',
            text: { preview_url: Boolean(this.config.previewUrl), body: message },
        };
    }

    async sendMessage(recipient, message, { media = null, interactive = null, template = null } = {}) {
        if (!this.connected) {
            throw new TransportConnectionError('Transport is not connected', { retryable: false });
        }
        if (template) return this.#sendTemplate(recipient, template, media);
        const uploadedMedia = media ? await this.uploadMedia(media) : null;
        // Native buttons / list / single URL CTA; anything else (call, copy,
        // two CTAs, template mode) goes out as the numbered text fallback.
        if (interactive && (!nativeInteractive(interactive) || this.config.useTemplate)) {
            return this.#post(this.payload(recipient, renderFallbackText(message, interactive), { uploadedMedia }));
        }
        if (interactive) {
            // A list message only takes a text header: send the media first.
            if (uploadedMedia && interactive.type === 'list') {
                await this.#post(this.payload(recipient, '', { uploadedMedia }));
            }
            const header = interactive.type === 'list' ? null : uploadedMedia;
            return this.#post(interactivePayload(recipient, message, interactive, header));
        }
        return this.#post(this.payload(recipient, message, { uploadedMedia }));
    }

    // --- approved template send (messaging/templateSend.js builds `template`) ---
    /** One upload per attachment for a whole campaign: Meta media ids live 30 days. */
    #templateUploads = new WeakMap();

    async #sendTemplate(recipient, template, media) {
        let uploadedMedia = null;
        if (media) {
            uploadedMedia = this.#templateUploads.get(media);
            if (!uploadedMedia) {
                uploadedMedia = await this.uploadMedia(media);
                this.#templateUploads.set(media, uploadedMedia);
            }
        }
        return this.#post(templatePayload(recipient, template, uploadedMedia));
    }
    // --- end approved template send ---

    async #post(payload) {
        let response;
        try {
            response = await this.fetch(this.messagesUrl, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(this.config.requestTimeout * 1000),
            });
        } catch (err) {
            const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
            throw new TransportSendError(
                timedOut ? `Request timed out: ${err.message}` : `Network error: ${err.message}`,
                { retryable: true });
        }

        if (response.status >= 400) {
            const { code, message: detail } = await parseError(response);
            if (AUTH_ERROR_CODES.has(code)) {
                this.connected = false;
                throw new TransportConnectionError(`Authentication failed (${code}): ${detail}`,
                    { retryable: false, code });
            }
            throw new TransportSendError(
                `Cloud API error ${response.status}/${code}: ${detail}`,
                { retryable: response.status >= 500 || RETRYABLE_ERROR_CODES.has(code), code });
        }

        let providerId;
        try {
            const body = await response.json();
            providerId = body.messages[0].id;
        } catch {
            throw new TransportSendError('Unexpected Cloud API response', { retryable: false });
        }
        // The API only confirms it accepted the message for delivery: that is
        // SENT.  DELIVERED / READ arrive later on the webhook, or not at all.
        return { providerId, status: Status.SENT, detail: 'accepted' };
    }

    async uploadMedia(media) {
        const form = new FormData();
        form.set('messaging_product', 'whatsapp');
        form.set('file', new Blob([media.buffer], { type: media.mimetype }), media.filename);
        let response;
        try {
            response = await this.fetch(this.mediaUrl, {
                method: 'POST',
                headers: this.authHeaders(),
                body: form,
                signal: AbortSignal.timeout(this.config.requestTimeout * 1000),
            });
        } catch (err) {
            const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
            throw new TransportSendError(
                timedOut ? `Media upload timed out: ${err.message}` : `Media upload network error: ${err.message}`,
                { retryable: true });
        }
        if (response.status >= 400) {
            const { code, message } = await parseError(response);
            throw new TransportSendError(
                `Cloud API media upload error ${response.status}/${code}: ${message}`,
                { retryable: response.status >= 500 || RETRYABLE_ERROR_CODES.has(code), code });
        }
        const body = await response.json();
        if (!body.id) throw new TransportSendError('Unexpected Cloud API media upload response', { retryable: false });
        return { id: body.id, filename: media.filename, mimetype: media.mimetype };
    }

    getStatus(providerId) {
        return this.receipts.get(providerId) ?? null;
    }

    recordReceipt(providerId, status) {
        this.receipts.set(providerId, status);
    }
}

/** Whether the Cloud API can send this block as a native interactive message. */
export function nativeInteractive(interactive) {
    if (!interactive) return false;
    if (interactive.type === 'buttons' || interactive.type === 'list') return true;
    return interactive.type === 'cta' && interactive.cta?.length === 1 && interactive.cta[0].kind === 'url';
}

/**
 * The Graph API body for a native interactive message. Reply ids are the
 * option payload (defaults to its id), so a click comes back as something
 * reply rules can match on. `uploadedMedia` becomes the header when given.
 */
export function interactivePayload(recipient, message, interactive, uploadedMedia = null) {
    let header;
    if (uploadedMedia) {
        const kind = uploadedMedia.mimetype?.split('/')[0];
        const type = kind === 'image' || kind === 'video' ? kind : 'document';
        header = { type, [type]: { id: uploadedMedia.id, ...(type === 'document' ? { filename: uploadedMedia.filename } : {}) } };
    } else if (interactive.header) {
        header = { type: 'text', text: interactive.header };
    }
    const body = { text: String(message ?? '').trim().slice(0, 1024) || interactive.header || '.' };
    const footer = interactive.footer ? { text: interactive.footer } : undefined;
    let block;
    if (interactive.type === 'buttons') {
        block = {
            type: 'button',
            action: { buttons: interactive.buttons.map((b) => ({ type: 'reply', reply: { id: String(b.payload || b.id).slice(0, 256), title: b.title } })) },
        };
    } else if (interactive.type === 'list') {
        block = {
            type: 'list',
            action: {
                button: interactive.list.button,
                sections: interactive.list.sections.map((s) => ({
                    title: s.title || undefined,
                    rows: s.rows.map((r) => ({ id: String(r.payload || r.id).slice(0, 200), title: r.title, description: r.description || undefined })),
                })),
            },
        };
    } else {
        const [cta] = interactive.cta;
        block = { type: 'cta_url', action: { name: 'cta_url', parameters: { display_text: cta.title, url: cta.value } } };
    }
    return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'interactive',
        interactive: { type: block.type, ...(header ? { header } : {}), body, ...(footer ? { footer } : {}), action: block.action },
    };
}

/**
 * Graph API body for an approved template. `template` is
 * { name, language, components } already resolved for this recipient;
 * `uploadedMedia` (the campaign attachment) becomes the header, replacing
 * any header the mapping carried (a template has at most one).
 */
export function templatePayload(recipient, template, uploadedMedia = null) {
    let components = Array.isArray(template.components) ? template.components : [];
    if (uploadedMedia) {
        const kind = uploadedMedia.mimetype?.split('/')[0];
        const type = kind === 'image' || kind === 'video' ? kind : 'document';
        const ref = { id: uploadedMedia.id, ...(type === 'document' ? { filename: uploadedMedia.filename } : {}) };
        components = [
            { type: 'header', parameters: [{ type, [type]: ref }] },
            ...components.filter((c) => c.type !== 'header'),
        ];
    }
    const language = typeof template.language === 'string' ? template.language : template.language?.code;
    return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'template',
        template: {
            name: template.name,
            language: { code: language || 'en_US' },
            ...(components.length ? { components } : {}),
        },
    };
}

async function parseError(response) {
    try {
        const body = await response.json();
        const error = body.error ?? {};
        return { code: error.code ?? 0, message: error.message ?? JSON.stringify(body).slice(0, 300) };
    } catch {
        return { code: 0, message: `HTTP ${response.status}` };
    }
}

/**
 * Pull the delivery receipts out of a Meta webhook body.
 * Returns [{providerId, status, error}].
 */
export function parseStatusPayload(payload) {
    const receipts = [];
    for (const entry of payload?.entry ?? []) {
        for (const change of entry.changes ?? []) {
            for (const status of change.value?.statuses ?? []) {
                const mapped = WEBHOOK_STATUS_MAP[status.status];
                if (!mapped || !status.id) continue;
                const errors = status.errors ?? [];
                receipts.push({
                    providerId: status.id,
                    status: mapped,
                    error: errors.length ? (errors[0].title ?? errors[0].message ?? null) : null,
                });
            }
        }
    }
    return receipts;
}

export function parseInboundPayload(payload) {
    const inbounds = [];
    for (const entry of payload?.entry ?? []) {
        for (const change of entry.changes ?? []) {
            const value = change.value ?? {};
            const contacts = value.contacts ?? [];
            const namesByWaId = new Map(contacts.map((contact) => [
                contact.wa_id,
                contact.profile?.name ?? '',
            ]));
            for (const msg of value.messages ?? []) {
                if (!msg.id || !msg.from) continue;
                inbounds.push({
                    messageId: msg.id,
                    sender: msg.from,
                    senderName: namesByWaId.get(msg.from) ?? contacts[0]?.profile?.name ?? '',
                    body: inboundBody(msg),
                    // The id of the tapped reply button / list row, or a
                    // template quick-reply payload: what reply rules match on.
                    ...inboundReplyId(msg),
                    mediaUrl: inboundMediaUrl(msg),
                    mediaType: ['text', 'interactive', 'button'].includes(msg.type) ? null : msg.type,
                    timestamp: msg.timestamp
                        ? new Date(Number(msg.timestamp) * 1000).toISOString()
                        : new Date().toISOString(),
                });
            }
        }
    }
    return inbounds;
}

function inboundBody(msg) {
    if (msg.text?.body) return msg.text.body;
    if (msg.button?.text) return msg.button.text;
    if (msg.interactive?.button_reply?.title) return msg.interactive.button_reply.title;
    if (msg.interactive?.list_reply?.title) return msg.interactive.list_reply.title;
    if (msg.image?.caption) return msg.image.caption;
    if (msg.document?.caption) return msg.document.caption;
    if (msg.video?.caption) return msg.video.caption;
    return '';
}

/** `{ replyId }` for a button / list / quick-reply tap, nothing for plain messages. */
function inboundReplyId(msg) {
    const replyId = msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id ?? msg.button?.payload;
    return replyId ? { replyId } : {};
}

function inboundMediaUrl(msg) {
    const media = msg.image ?? msg.document ?? msg.audio ?? msg.video ?? msg.sticker;
    return media?.id ?? null;
}
