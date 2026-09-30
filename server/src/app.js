/**
 * The Express application: REST for commands, Server-Sent Events for the live
 * feed the browser needs (status changes, QR codes, campaign stats).
 *
 * It binds to loopback and carries no authentication: this is the same
 * single-operator tool the desktop app was, now driven from a browser on the
 * same machine.  Put it behind a real auth proxy before exposing the port.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';

import { AutoReplyEngine } from './autoreply/engine.js';
import { processOptOut } from './autoreply/optout.js';
import { CampaignManager } from './campaign/manager.js';
import {
    TRANSPORTS,
    TRANSPORT_CLOUD_API,
    TRANSPORT_SANDBOX,
    TRANSPORT_WEB_JS,
    loadConfig,
    mergeConfig,
    publicConfig,
    saveConfig,
    validateConfig,
} from './config.js';
import { Database } from './db.js';
import { importContacts } from './contacts.js';
import { PhoneError, Status, normalizePhone, personalize } from './protocol.js';
import { TransportError } from './transports/base.js';
import { CloudApiTransport, parseInboundPayload, parseStatusPayload } from './transports/cloudApi.js';
import { SandboxTransport } from './transports/sandbox.js';
import { TOS_WARNING, WhatsAppWebTransport } from './transports/whatsappWeb.js';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024 },
});
const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 16 * 1024 * 1024 },
});
const UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');
const ALLOWED_MEDIA_TYPES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
]);

export function createTransport(config, deps = {}) {
    switch (config.transport) {
        case TRANSPORT_SANDBOX:
            return new SandboxTransport(config);
        case TRANSPORT_CLOUD_API:
            return new CloudApiTransport(config, deps);
        case TRANSPORT_WEB_JS:
            return new WhatsAppWebTransport(config, deps);
        default:
            throw new Error(`Unknown transport: ${config.transport}`);
    }
}

export function createApp({ db = new Database(), config = loadConfig(), deps = {} } = {}) {
    const app = express();
    app.use(express.json({ limit: '1mb' }));

    const state = {
        db,
        config,
        transport: null,
        info: null,
        qr: null,
        connecting: false,
        manager: null,
        clients: new Set(), // SSE subscribers
        media: new Map(),
    };

    const manager = new CampaignManager(db, new NullTransport(), config);
    const autoReply = new AutoReplyEngine(db, new NullTransport());
    state.manager = manager;
    state.autoReply = autoReply;
    manager.on('event', (event) => broadcast(state, event));
    manager.start();

    // ------------------------------------------------------------ config --
    app.get('/api/config', (req, res) => {
        res.json({
            config: publicConfig(state.config),
            transports: TRANSPORTS,
            warnings: { [TRANSPORT_WEB_JS]: TOS_WARNING },
        });
    });

    app.put('/api/config', (req, res) => {
        const merged = mergeConfig(state.config, req.body);
        const problems = validateConfig(merged);
        if (problems.length) return res.status(400).json({ errors: problems });
        state.config = saveConfig(merged);
        manager.applyConfig(state.config);
        return res.json({ config: publicConfig(state.config) });
    });

    // --------------------------------------------------------- connection --
    app.get('/api/connection', (req, res) => res.json(connectionState(state)));

    app.post('/api/connection/connect', async (req, res) => {
        if (state.connecting) {
            return res.json(connectionState(state));
        }
        if (state.transport?.isConnected?.()) {
            return res.json(connectionState(state));
        }
        const problems = validateConfig(state.config);
        if (problems.length) return res.status(400).json({ errors: problems });

        if (state.transport) {
            try {
                await state.transport.disconnect();
            } catch {
                // Ignore disconnect errors
            }
            state.transport = null;
        }

        let transport;
        try {
            transport = createTransport(state.config, deps);
        } catch (err) {
            return res.status(400).json({ errors: [err.message] });
        }
        // The WhatsApp Web transport talks back while it connects: QR codes,
        // loading progress, and the ACKs that become DELIVERED / READ.
        transport.events?.on('qr', async (qr) => {
            state.qr = await toQrDataUrl(qr);
            broadcast(state, { type: 'qr', qr, image: state.qr });
        });
        transport.events?.on('state', (payload) => broadcast(state, { type: 'transportState', ...payload }));
        transport.events?.on('ready', (info) => {
            state.info = info;
            state.qr = null;
            state.connecting = false;
            manager.setTransport(transport);
            autoReply.setTransport(transport);
            manager.start();
            broadcast(state, { type: 'connection', ...connectionState(state) });
        });
        transport.events?.on('disconnected', (detail) => {
            state.transport = null;
            state.info = null;
            state.qr = null;
            state.connecting = false;
            manager.setTransport(new NullTransport());
            autoReply.setTransport(new NullTransport());
            broadcast(state, { type: 'connection', connected: false, detail });
        });
        transport.events?.on('receipt', ({ providerId, status, error }) => {
            manager.handleReceipt(providerId, status, error);
        });
        transport.events?.on('inbound', (message) => {
            void handleInbound(state, message);
        });

        state.connecting = true;
        state.transport = transport;
        try {
            state.info = await transport.connect();
        } catch (err) {
            state.connecting = false;
            state.transport = null;
            state.info = null;
            state.qr = null;
            const status = err instanceof TransportError ? 502 : 500;
            broadcast(state, { type: 'connection', connected: false, error: err.message });
            return res.status(status).json({ errors: [err.message] });
        }

        if (state.info?.connected) {
            state.connecting = false;
            state.qr = null;
            manager.setTransport(transport);
            autoReply.setTransport(transport);
            manager.start();
        } else if (state.info?.qr) {
            state.qr = await toQrDataUrl(state.info.qr);
        }

        broadcast(state, { type: 'connection', ...connectionState(state) });
        return res.json(connectionState(state));
    });

    app.post('/api/connection/disconnect', async (req, res) => {
        state.connecting = false;
        if (state.transport) {
            try {
                await state.transport.disconnect();
            } catch {
                // a failed teardown must not block the UI
            }
        }
        state.transport = null;
        state.info = null;
        state.qr = null;
        manager.setTransport(new NullTransport());
        autoReply.setTransport(new NullTransport());
        broadcast(state, { type: 'connection', connected: false, qr: null });
        res.json(connectionState(state));
    });

    app.post('/api/connection/logout', async (req, res) => {
        state.connecting = false;
        if (state.transport?.logout) {
            try {
                await state.transport.logout();
            } catch {}
        } else if (state.transport?.disconnect) {
            try {
                await state.transport.disconnect();
            } catch {}
        }
        state.transport = null;
        state.info = null;
        state.qr = null;
        manager.setTransport(new NullTransport());
        autoReply.setTransport(new NullTransport());
        broadcast(state, { type: 'connection', connected: false, qr: null });
        res.json(connectionState(state));
    });

    // ----------------------------------------------------------- messages --
    app.post('/api/messages', (req, res) => {
        const { recipient, message, name = '', mediaId = null } = req.body ?? {};
        if (!message) return res.status(400).json({ errors: ['message is required'] });
        let normalized;
        try {
            normalized = normalizePhone(recipient, state.config.defaultCountryCode);
        } catch (err) {
            if (!(err instanceof PhoneError)) throw err;
            return res.status(400).json({ errors: [err.message] });
        }
        if (!state.transport?.isConnected?.()) {
            return res.status(409).json({ errors: ['Connect a transport first.'] });
        }
        if (state.config.safetyEnabled && state.transport?.realDelivery
            && manager.quota.exhausted()) {
            return res.status(429).json({
                errors: [`Daily limit of ${manager.quota.limit} messages reached.`
                    + ' It resets at midnight.'],
                safety: manager.safetyStatus(),
            });
        }
        const body = personalize(message, { name, phone: normalized });
        const media = mediaId ? state.media.get(mediaId) : null;
        if (mediaId && !media) return res.status(404).json({ errors: ['media not found'] });
        const messageId = manager.enqueueSingle(normalized, body, name, { media });
        if (!messageId) {
            return res.status(409).json({
                errors: ['That exact message is already queued for this number.'],
            });
        }
        manager.start();
        return res.json({ messageId, recipient: normalized, message: body });
    });

    // ----------------------------------------------------------- contacts --
    app.post('/api/contacts/import', upload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ errors: ['no file uploaded'] });
        try {
            const result = await importContacts(
                req.file.originalname, req.file.buffer, state.config.defaultCountryCode);
            return res.json(result);
        } catch (err) {
            return res.status(400).json({ errors: [`Import failed: ${err.message}`] });
        }
    });

    app.post('/api/contacts/preview', (req, res) => {
        const { template = '', contact = {} } = req.body ?? {};
        const context = {
            name: contact.name ?? '', phone: contact.phone ?? '', ...(contact.extra ?? {}),
        };
        res.json({
            preview: personalize(template, context),
            previews: Array.from({ length: 3 }, () => personalize(template, context)),
        });
    });

    // -------------------------------------------------------------- media --
    app.post('/api/media/upload', mediaUpload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ errors: ['no file uploaded'] });
        if (!ALLOWED_MEDIA_TYPES.has(req.file.mimetype)) {
            return res.status(400).json({ errors: [`unsupported media type: ${req.file.mimetype}`] });
        }
        const mediaId = `med_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const filename = path.basename(req.file.originalname).replace(/[^\w.\- ]+/g, '_');
        const storedName = `${mediaId}_${filename}`;
        const filePath = path.join(UPLOAD_DIR, storedName);
        try {
            await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
            await fs.promises.writeFile(filePath, req.file.buffer);
        } catch (err) {
            return res.status(500).json({ errors: [`Media upload failed: ${err.message}`] });
        }
        const media = {
            mediaId,
            filename,
            mimetype: req.file.mimetype,
            size: req.file.size,
            filePath,
            buffer: req.file.buffer,
            url: `/api/media/${mediaId}`,
        };
        state.media.set(mediaId, media);
        return res.status(201).json(mediaMetadata(media));
    });

    app.get('/api/media/:mediaId', (req, res) => {
        const media = state.media.get(req.params.mediaId);
        if (!media) return res.status(404).json({ errors: ['media not found'] });
        return res.type(media.mimetype).download(media.filePath, media.filename);
    });

    // ----------------------------------------------------------- campaign --
    app.post('/api/campaign/start', (req, res) => {
        const { contacts = [], template = '', onePerNumber = true, mediaId = null } = req.body ?? {};
        if (!contacts.length) return res.status(400).json({ errors: ['no contacts'] });
        if (!template) return res.status(400).json({ errors: ['message is required'] });
        if (!state.transport?.isConnected?.()) {
            return res.status(409).json({ errors: ['Connect a transport first.'] });
        }
        manager.resetStats();
        manager.queue.reset();
        manager.pausedByQuota = false;
        const media = mediaId ? state.media.get(mediaId) : null;
        if (mediaId && !media) return res.status(404).json({ errors: ['media not found'] });
        const result = manager.enqueueContacts(contacts, template, { onePerNumber, media });
        manager.start();
        return res.json(result);
    });

    app.post('/api/campaign/:action', (req, res) => {
        const { action } = req.params;
        if (!['pause', 'resume', 'stop'].includes(action)) {
            return res.status(404).json({ errors: [`unknown action: ${action}`] });
        }
        const accepted = manager[action]();
        if (action === 'resume' && accepted === false) {
            return res.status(409).json({
                errors: [`Daily limit of ${manager.quota.limit} reached - resume after midnight.`],
                stats: manager.statsSnapshot(),
            });
        }
        return res.json({ stats: manager.statsSnapshot() });
    });

    app.get('/api/campaign/stats', (req, res) => res.json({ stats: manager.statsSnapshot() }));

    // ------------------------------------------------------------- inbox --
    app.get('/api/inbox/messages', (req, res) => {
        res.json({ messages: db.getInboundMessages({
            sender: req.query.sender || null,
            limit: Number(req.query.limit) || 100,
        }) });
    });

    app.get('/api/inbox/conversations', (req, res) => {
        res.json({ conversations: db.getConversations() });
    });

    app.post('/api/inbox/mark-read', (req, res) => {
        const { sender } = req.body ?? {};
        if (!sender) return res.status(400).json({ errors: ['sender is required'] });
        return res.json({ updated: db.markInboundRead(sender) });
    });

    // ------------------------------------------------------ auto-replies --
    app.get('/api/auto-replies', (req, res) => {
        res.json({ rules: db.getAutoReplies() });
    });

    app.post('/api/auto-replies', (req, res) => {
        const rule = validateAutoReply(req.body);
        if (rule.errors) return res.status(400).json({ errors: rule.errors });
        return res.status(201).json({ rule: db.saveAutoReply(rule) });
    });

    app.put('/api/auto-replies/:id', (req, res) => {
        const current = db.getAutoReplies().find((rule) => rule.id === Number(req.params.id));
        if (!current) return res.status(404).json({ errors: ['rule not found'] });
        const rule = validateAutoReply({ ...current, ...req.body, id: current.id });
        if (rule.errors) return res.status(400).json({ errors: rule.errors });
        return res.json({ rule: db.saveAutoReply(rule) });
    });

    app.delete('/api/auto-replies/:id', (req, res) => {
        return res.json({ deleted: db.deleteAutoReply(Number(req.params.id)) });
    });

    app.post('/api/auto-replies/preview', (req, res) => {
        const { template = '', sender = '15551234567', senderName = 'Valued Customer' } = req.body ?? {};
        res.json({
            preview: autoReply.formatResponse(template, { sender, senderName, body: '' }),
        });
    });

    // ---------------------------------------------------------- opt-outs --
    app.get('/api/optouts', (req, res) => {
        res.json({ optouts: db.getOptOuts() });
    });

    app.post('/api/optouts', (req, res) => {
        const { phone, reason = 'manual' } = req.body ?? {};
        if (!phone) return res.status(400).json({ errors: ['phone is required'] });
        let normalized;
        try {
            normalized = normalizePhone(phone, state.config.defaultCountryCode);
        } catch (err) {
            if (!(err instanceof PhoneError)) throw err;
            return res.status(400).json({ errors: [err.message] });
        }
        return res.status(201).json({ optout: db.addOptOut(normalized, reason) });
    });

    app.delete('/api/optouts/:phone', (req, res) => {
        let normalized;
        try {
            normalized = normalizePhone(req.params.phone, state.config.defaultCountryCode);
        } catch (err) {
            if (!(err instanceof PhoneError)) throw err;
            return res.status(400).json({ errors: [err.message] });
        }
        return res.json({ deleted: db.removeOptOut(normalized) });
    });

    // ------------------------------------------------------------- safety --
    app.get('/api/safety', (req, res) => {
        const batch = Number(req.query.contacts) || 0;
        res.json({ safety: manager.safetyStatus(batch) });
    });

    // ------------------------------------------------------------ history --
    app.get('/api/history', (req, res) => {
        const status = req.query.status && req.query.status !== 'ALL' ? req.query.status : null;
        const recipient = req.query.recipient || null;
        const signature = db.historySignature({ status, recipient });
        // The browser sends back the signature it already has: same answer
        // means no rows are shipped at all.
        if (req.query.signature === `${signature.count}:${signature.last}`) {
            return res.status(204).end();
        }
        return res.json({
            records: db.history({ limit: Number(req.query.limit) || 1000, status, recipient }),
            counts: db.countsByStatus(),
            signature: `${signature.count}:${signature.last}`,
        });
    });

    // ------------------------------------------- Cloud API webhook (receipts) --
    app.get('/api/webhook', (req, res) => {
        // Meta's verification handshake.
        if (req.query['hub.mode'] === 'subscribe'
            && req.query['hub.verify_token'] === state.config.webhookVerifyToken) {
            return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
        }
        return res.status(403).send('verification failed');
    });

    app.post('/api/webhook', (req, res) => {
        for (const receipt of parseStatusPayload(req.body)) {
            if (state.transport instanceof CloudApiTransport) {
                state.transport.recordReceipt(receipt.providerId, receipt.status);
            }
            manager.handleReceipt(receipt.providerId, receipt.status, receipt.error);
        }
        for (const inbound of parseInboundPayload(req.body)) {
            void handleInbound(state, inbound);
        }
        res.sendStatus(200);
    });

    // ---------------------------------------------------------------- SSE --
    app.get('/api/events', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`event: hello\ndata: ${JSON.stringify(connectionState(state))}\n\n`);
        state.clients.add(res);

        const cleanup = () => {
            clearInterval(keepAlive);
            state.clients.delete(res);
        };

        res.on('error', cleanup);
        req.on('error', cleanup);
        req.on('close', cleanup);

        // Proxies drop an idle stream; a comment every 25s keeps it open.
        const keepAlive = setInterval(() => {
            if (res.writableEnded || res.destroyed) {
                cleanup();
                return;
            }
            res.write(': ping\n\n', (err) => {
                if (err) cleanup();
            });
        }, 25000);
    });

    app.get('/api/health', (req, res) => res.json({ ok: true, status: Status.QUEUED && 'ready' }));

    app.locals.state = state;
    return app;
}

async function handleInbound(state, message) {
    const saved = state.db.insertInbound(message);
    broadcast(state, { type: 'inbound_message', message: saved });
    try {
        const optOut = await processOptOut(state.db, state.transport, saved);
        if (optOut.handled) {
            broadcast(state, { type: 'optout', sender: saved.sender, action: optOut.action });
            return saved;
        }
        const reply = await state.autoReply.handleInbound(saved);
        if (reply?.rule) {
            state.db.markInboundReplied(saved.messageId, reply.rule.keyword);
            broadcast(state, {
                type: 'auto_reply',
                sender: saved.sender,
                rule: reply.rule.keyword,
                providerId: reply.result?.providerId ?? null,
            });
        }
    } catch (err) {
        broadcast(state, { type: 'inbound_error', sender: saved.sender, error: err.message ?? String(err) });
    }
    return saved;
}

function validateAutoReply(input = {}) {
    const rule = {
        id: input.id,
        keyword: String(input.keyword ?? '').trim(),
        matchType: String(input.matchType ?? input.match_type ?? '').trim().toUpperCase(),
        replyBody: String(input.replyBody ?? input.reply_body ?? '').trim(),
        isActive: input.isActive ?? input.is_active ?? true,
        cooldownSec: Number(input.cooldownSec ?? input.cooldown_sec ?? 300),
    };
    const errors = [];
    if (!rule.keyword && rule.matchType !== 'FALLBACK') errors.push('keyword is required');
    if (!['EXACT', 'CONTAINS', 'REGEX', 'FALLBACK'].includes(rule.matchType)) {
        errors.push('matchType must be EXACT, CONTAINS, REGEX, or FALLBACK');
    }
    if (!rule.replyBody) errors.push('replyBody is required');
    if (!Number.isFinite(rule.cooldownSec) || rule.cooldownSec < 0) {
        errors.push('cooldownSec must be zero or greater');
    }
    return errors.length ? { errors } : rule;
}

/**
 * Stop the engine and the transport this app owns.  The worker loop outlives a
 * closed HTTP server otherwise, and then writes to a closed database.
 */
export async function closeApp(app) {
    const state = app.locals.state;
    if (!state) return;
    await state.manager.shutdown();
    if (state.transport) {
        try {
            await state.transport.disconnect();
        } catch {
            // shutting down anyway
        }
    }
    for (const client of state.clients) {
        try {
            client.end();
        } catch {
            // already gone
        }
    }
    state.clients.clear();
}

function connectionState(state) {
    const transport = state.transport;
    const connected = Boolean(transport?.isConnected?.());
    return {
        connected,
        transport: state.config.transport,
        name: transport?.name ?? null,
        account: state.info?.account ?? '',
        detail: state.info?.detail ?? '',
        realDelivery: Boolean(state.info?.realDelivery),
        supportsReceipts: Boolean(transport?.supportsReceipts),
        qr: state.qr,
    };
}

function broadcast(state, event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of state.clients) {
        if (client.writableEnded || client.destroyed) {
            state.clients.delete(client);
            continue;
        }
        try {
            client.write(payload, (err) => {
                if (err) state.clients.delete(client);
            });
        } catch {
            state.clients.delete(client);
        }
    }
}

function mediaMetadata(media) {
    return {
        mediaId: media.mediaId,
        filename: media.filename,
        mimetype: media.mimetype,
        size: media.size,
        url: media.url,
    };
}

async function toQrDataUrl(qr) {
    try {
        const QRCode = await import('qrcode');
        return await QRCode.toDataURL(qr, { width: 320, margin: 2 });
    } catch {
        return null; // the raw payload still goes out, the UI can render text
    }
}

/** Placeholder before Connect is pressed. It never pretends to send. */
class NullTransport {
    name = 'not connected';
    realDelivery = false;
    supportsReceipts = false;

    isConnected() {
        return false;
    }

    async sendMessage() {
        const { TransportConnectionError } = await import('./transports/base.js');
        throw new TransportConnectionError('No transport connected', { retryable: false });
    }

    getStatus() {
        return null;
    }

    async disconnect() {}
}
