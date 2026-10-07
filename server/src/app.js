/**
 * The Express application: REST for commands, Server-Sent Events for the live
 * feed the browser needs (status changes, QR codes, campaign stats).
 *
 * Multi-tenant: every request is authenticated, resolved to a tenant, and
 * handed to that tenant's own runtime (config, transport, campaign engine,
 * auto-replies, SSE clients, scoped database).  Nothing is shared between
 * tenants except the SQLite connection, and that is reached only through
 * `db.forTenant(id)`.
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
    APP_DIR,
    SESSION_DIR,
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
import { DEFAULT_TENANT_ID, Database } from './db.js';
import {
    buildPaymentReminderMessage,
    importPaymentReminders,
    remindersToContacts,
} from './paymentReminders.js';
import { importContacts } from './contacts.js';
import { PhoneError, normalizePhone, personalize } from './protocol.js';
import {
    CAPABILITIES,
    ChannelError,
    Channels,
    publicChannel,
    withinSendingWindow,
} from './channels.js';
import { ROLES, Tenancy, TenancyError, roleRank } from './tenancy.js';
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

/** Which capability each sending route needs. Everything else is read or admin. */
const SEND_ROUTES = Object.freeze({
    '/messages': 'transactional_messages',
    '/campaign/start': 'campaigns',
    '/payment-reminders/send': 'transactional_messages',
});

/**
 * One channel's engine and routes: its transport, campaign manager, auto-reply
 * engine and SSE subscribers.  The router is mounted under /api by the tenant
 * dispatcher, so paths here carry no /api prefix.  `app` is a Router.
 *
 * `config` is the channel's `settings`; `save` persists an edited copy back to
 * the channel row.  Nothing here knows about other channels.
 */
function createChannelRuntime({ db, channel, config, save, sessionDir, deps }) {
    const app = express.Router();
    deps = { ...deps, sessionDir };

    const state = {
        db,
        config,
        channel,
        save,
        transport: null,
        info: null,
        qr: null,
        connecting: false,
        manager: null,
        clients: new Set(), // SSE subscribers
        media: new Map(),
        webhookConnect: null,
    };

    /**
     * Rule 2 enforcement.  A send is refused unless this channel is active, is
     * enabled for that kind of traffic, and is inside its sending window.  The
     * channel is already resolved by the time we are here, so this is the last
     * gate rather than a lookup.
     */
    app.use((req, res, next) => {
        const capability = SEND_ROUTES[req.path];
        if (!capability || req.method === 'GET' || req.method === 'HEAD') return next();
        const channel = state.channel;
        if (channel.status !== 'active') {
            return res.status(409).json({ errors: [`channel ${channel.id} is disabled`] });
        }
        if (!channel.capabilities.includes(capability)) {
            return res.status(409).json({ errors: [`channel ${channel.id} is not enabled for ${capability}`] });
        }
        if (!withinSendingWindow(channel)) {
            return res.status(409).json({
                errors: [`channel ${channel.id} is outside its sending window (${channel.timezone})`],
            });
        }
        return next();
    });

    const manager = new CampaignManager(db, new NullTransport(), config);
    const autoReply = new AutoReplyEngine(db, new NullTransport());
    state.manager = manager;
    state.autoReply = autoReply;
    manager.on('event', (event) => broadcast(state, event));
    manager.start();

    // ------------------------------------------------------------ config --
    app.get('/config', (req, res) => {
        res.json({
            config: publicConfig(state.config),
            transports: TRANSPORTS,
            warnings: { [TRANSPORT_WEB_JS]: TOS_WARNING },
        });
    });

    app.put('/config', (req, res) => {
        const merged = mergeConfig(state.config, req.body);
        const problems = validateConfig(merged);
        if (problems.length) return res.status(400).json({ errors: problems });
        state.config = state.save(merged);
        manager.applyConfig(state.config);
        return res.json({ config: publicConfig(state.config) });
    });

    // --------------------------------------------------------- connection --
    app.get('/connection', (req, res) => res.json(connectionState(state)));

    app.post('/connection/connect', async (req, res) => {
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
        transport.events?.on('state', (payload) => {
            if (['disconnected', 'error', 'reconnecting', 'reconnect_failed', 'auth_failure'].includes(payload.state)) {
                state.info = {
                    connected: false,
                    account: state.info?.account ?? '',
                    detail: payload.detail ?? '',
                    error: ['error', 'reconnect_failed', 'auth_failure'].includes(payload.state)
                        ? payload.detail ?? ''
                        : null,
                    code: payload.state === 'auth_failure' ? 'WHATSAPP_WEB_AUTH_FAILURE' : null,
                    realDelivery: Boolean(transport.realDelivery),
                };
                state.connecting = payload.state === 'reconnecting';
                state.qr = null;
                if (payload.state === 'auth_failure') {
                    manager.setTransport(new NullTransport());
                    autoReply.setTransport(new NullTransport());
                }
                broadcast(state, { type: 'connection', ...connectionState(state) });
            }
            broadcast(state, { type: 'transportState', ...payload });
        });
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
            state.transport = transport;
            state.info = {
                connected: false,
                account: '',
                detail: err.message,
                error: err.message,
                code: err.code ?? null,
                realDelivery: Boolean(transport.realDelivery),
            };
            state.qr = null;
            const status = err.code === 'WHATSAPP_WEB_PROFILE_LOCKED'
                ? 409
                : (err instanceof TransportError ? 502 : 500);
            broadcast(state, { type: 'connection', ...connectionState(state) });
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

    app.post('/connection/disconnect', async (req, res) => {
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

    app.post('/connection/logout', async (req, res) => {
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
    app.post('/messages', (req, res) => {
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
    app.post('/contacts/import', upload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ errors: ['no file uploaded'] });
        try {
            const result = await importContacts(
                req.file.originalname, req.file.buffer, state.config.defaultCountryCode);
            return res.json(result);
        } catch (err) {
            return res.status(400).json({ errors: [`Import failed: ${err.message}`] });
        }
    });

    app.post('/contacts/preview', (req, res) => {
        const { template = '', contact = {} } = req.body ?? {};
        const context = {
            name: contact.name ?? '', phone: contact.phone ?? '', ...(contact.extra ?? {}),
        };
        res.json({
            preview: personalize(template, context),
            previews: Array.from({ length: 3 }, () => personalize(template, context)),
        });
    });

    // --------------------------------------------------- payment reminders --
    app.post('/payment-reminders/import', upload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ errors: ['no file uploaded'] });
        try {
            const result = await importPaymentReminders(
                req.file.originalname, req.file.buffer, state.config.defaultCountryCode);
            return res.json(result);
        } catch (err) {
            return res.status(400).json({ errors: [`Payment reminder import failed: ${err.message}`] });
        }
    });

    app.post('/payment-reminders/send', (req, res) => {
        const { reminders = [] } = req.body ?? {};
        if (!Array.isArray(reminders) || reminders.length === 0) {
            return res.status(400).json({ errors: ['no payment reminders'] });
        }
        if (!state.transport?.isConnected?.()) {
            return res.status(409).json({ errors: ['Connect a transport first.'] });
        }

        const contacts = [];
        const errors = [];
        reminders.forEach((input, index) => {
            const row = Number(input?.rowNumber) || index + 1;
            let phone;
            try {
                phone = normalizePhone(input?.phone, state.config.defaultCountryCode);
            } catch (err) {
                if (!(err instanceof PhoneError)) throw err;
                errors.push(`Row ${row}: ${err.message}`);
                return;
            }
            if (input?.remaining === undefined || input?.remaining === null || String(input.remaining).trim() === '') {
                errors.push(`Row ${row}: missing remaining payment amount`);
                return;
            }
            const reminder = {
                rowNumber: row,
                name: String(input?.name ?? '').trim(),
                phone,
                remaining: String(input.remaining).trim(),
                dueDate: String(input?.dueDate ?? '').trim(),
                message: String(input?.message ?? '').trim(),
                finalMessage: String(input?.finalMessage ?? '').trim() || buildPaymentReminderMessage({
                    name: input?.name,
                    phone,
                    remaining: input.remaining,
                    dueDate: input?.dueDate,
                    message: input?.message,
                }),
            };
            contacts.push(remindersToContacts([reminder])[0]);
        });
        if (errors.length) return res.status(400).json({ errors });
        if (!contacts.length) return res.status(400).json({ errors: ['no valid payment reminders'] });

        manager.resetStats();
        manager.queue.reset();
        manager.pausedByQuota = false;
        const result = manager.enqueueContacts(contacts, '{final_message}', { onePerNumber: true });
        manager.start();
        return res.json(result);
    });

    // -------------------------------------------------------------- media --
    app.post('/media/upload', mediaUpload.single('file'), async (req, res) => {
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

    app.get('/media/:mediaId', (req, res) => {
        const media = state.media.get(req.params.mediaId);
        if (!media) return res.status(404).json({ errors: ['media not found'] });
        return res.type(media.mimetype).download(media.filePath, media.filename);
    });

    // ----------------------------------------------------------- campaign --
    app.post('/campaign/start', (req, res) => {
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

    app.post('/campaign/:action', (req, res) => {
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

    app.get('/campaign/stats', (req, res) => res.json({ stats: manager.statsSnapshot() }));

    // ------------------------------------------------------------- inbox --
    app.get('/inbox/messages', (req, res) => {
        res.json({ messages: db.getInboundMessages({
            sender: req.query.sender || null,
            limit: Number(req.query.limit) || 100,
        }) });
    });

    app.get('/inbox/conversations', (req, res) => {
        res.json({ conversations: db.getConversations() });
    });

    app.post('/inbox/mark-read', (req, res) => {
        const { sender } = req.body ?? {};
        if (!sender) return res.status(400).json({ errors: ['sender is required'] });
        return res.json({ updated: db.markInboundRead(sender) });
    });

    // ------------------------------------------------------ auto-replies --
    app.get('/auto-replies', (req, res) => {
        res.json({ rules: db.getAutoReplies() });
    });

    app.post('/auto-replies', (req, res) => {
        const rule = validateAutoReply(req.body);
        if (rule.errors) return res.status(400).json({ errors: rule.errors });
        return res.status(201).json({ rule: db.saveAutoReply(rule) });
    });

    app.put('/auto-replies/:id', (req, res) => {
        const current = db.getAutoReplies().find((rule) => rule.id === Number(req.params.id));
        if (!current) return res.status(404).json({ errors: ['rule not found'] });
        const rule = validateAutoReply({ ...current, ...req.body, id: current.id });
        if (rule.errors) return res.status(400).json({ errors: rule.errors });
        return res.json({ rule: db.saveAutoReply(rule) });
    });

    app.delete('/auto-replies/:id', (req, res) => {
        return res.json({ deleted: db.deleteAutoReply(Number(req.params.id)) });
    });

    app.post('/auto-replies/preview', (req, res) => {
        const { template = '', sender = '15551234567', senderName = 'Valued Customer' } = req.body ?? {};
        res.json({
            preview: autoReply.formatResponse(template, { sender, senderName, body: '' }),
        });
    });

    // ---------------------------------------------------------- opt-outs --
    app.get('/optouts', (req, res) => {
        res.json({ optouts: db.getOptOuts() });
    });

    app.post('/optouts', (req, res) => {
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

    app.delete('/optouts/:phone', (req, res) => {
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
    app.get('/safety', (req, res) => {
        const batch = Number(req.query.contacts) || 0;
        res.json({ safety: manager.safetyStatus(batch) });
    });

    // ------------------------------------------------------------ history --
    app.get('/history', (req, res) => {
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
    app.get('/webhook', (req, res) => {
        // Meta's verification handshake.
        if (req.query['hub.mode'] === 'subscribe'
            && req.query['hub.verify_token'] === state.config.webhookVerifyToken) {
            return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
        }
        return res.status(403).send('verification failed');
    });

    app.post('/webhook', (req, res) => {
        for (const receipt of parseStatusPayload(req.body)) {
            if (state.transport instanceof CloudApiTransport) {
                state.transport.recordReceipt(receipt.providerId, receipt.status);
            }
            manager.handleReceipt(receipt.providerId, receipt.status, receipt.error);
        }
        const inbounds = parseInboundPayload(req.body);
        if (inbounds.length) {
            void handleWebhookInbounds(state, deps, inbounds);
        }
        res.sendStatus(200);
    });

    // ---------------------------------------------------------------- SSE --
    app.get('/events', (req, res) => {
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

    return { router: app, state };
}

/**
 * One tenant's channels, and the dispatcher in front of them.
 *
 * This mirrors `createApp`'s tenant dispatch one level down: resolve the
 * channel, then hand the request to that channel's runtime.  Channel runtimes
 * are lazy and cached, so a tenant with six numbers pays only for the ones it
 * actually uses.
 */
function createTenantRuntime({ db, config, tenantDir, sessionDir, deps, audit }) {
    const app = express.Router();
    const channels = new Channels(db);
    const runtimes = new Map();

    // First run for this tenant: its config file becomes channel #1, so an
    // existing single-number install comes up already configured.
    channels.seed(config);

    const runtimeFor = (channel) => {
        let runtime = runtimes.get(channel.id);
        if (!runtime) {
            runtime = createChannelRuntime({
                db: db.forChannel(channel.id),
                channel,
                config: channel.settings,
                save: (settings) => channels.update(channel.id, { settings }).settings,
                // Each number needs its own browser profile, or they fight over the lock.
                sessionDir: channel.isDefault
                    ? sessionDir
                    : path.join(tenantDir, 'channels', String(channel.id), 'wwebjs_auth'),
                deps,
            });
            runtimes.set(channel.id, runtime);
        }
        // The row is the source of truth: a PATCH elsewhere must be visible here.
        runtime.state.channel = channel;
        return runtime;
    };

    const fail = (res, err) => {
        if (err instanceof ChannelError) return res.status(err.status).json({ errors: [err.message] });
        throw err;
    };

    /** Drop a channel's engine, e.g. after it is disabled or deleted. */
    const release = async (channelId) => {
        const runtime = runtimes.get(channelId);
        if (!runtime) return;
        runtimes.delete(channelId);
        await closeState(runtime.state);
    };

    // --------------------------------------------------------- channels --
    app.get('/channels', (req, res) => res.json({
        channels: channels.list().map((channel) => ({
            ...publicChannel(channel),
            health: channelHealth(channel, runtimes.get(channel.id)),
        })),
        capabilities: CAPABILITIES,
        transports: TRANSPORTS,
        warnings: { [TRANSPORT_WEB_JS]: TOS_WARNING },
    }));

    app.post('/channels', (req, res) => {
        try {
            const channel = channels.create(req.body ?? {});
            audit?.(req, 'channel.create', channel.id, channel.displayName);
            return res.status(201).json({ channel: publicChannel(channel) });
        } catch (err) {
            return fail(res, err);
        }
    });

    app.get('/channels/:id', (req, res) => {
        const channel = channels.get(req.params.id);
        if (!channel) return res.status(404).json({ errors: ['channel not found'] });
        return res.json({
            channel: publicChannel(channel),
            health: channelHealth(channel, runtimes.get(channel.id)),
        });
    });

    app.patch('/channels/:id', async (req, res) => {
        try {
            const before = channels.get(req.params.id);
            const channel = channels.update(req.params.id, req.body ?? {});
            // A disabled channel must stop sending now, not at the next restart.
            // Swapping provider rebuilds the transport for the same reason.
            if (channel.status !== 'active' || before?.provider !== channel.provider) await release(channel.id);
            audit?.(req, 'channel.update', channel.id, channel.status);
            return res.json({ channel: publicChannel(channel) });
        } catch (err) {
            return fail(res, err);
        }
    });

    app.post('/channels/:id/default', (req, res) => {
        try {
            const channel = channels.setDefault(req.params.id);
            audit?.(req, 'channel.default', channel.id, channel.displayName);
            return res.json({ channel: publicChannel(channel) });
        } catch (err) {
            return fail(res, err);
        }
    });

    app.delete('/channels/:id', async (req, res) => {
        try {
            const channel = channels.remove(req.params.id);
            await release(channel.id);
            audit?.(req, 'channel.delete', channel.id, channel.displayName);
            return res.json({ deleted: channel.id });
        } catch (err) {
            return fail(res, err);
        }
    });

    // -------------------------------------------------- channel routes --
    app.use((req, res, next) => {
        const named = req.get('x-channel-id') ?? req.query.channel;
        try {
            const channel = named == null || named === ''
                ? channels.route({})
                : channels.route({ channelId: Number(named) });
            req.channel = channel;
            return runtimeFor(channel).router(req, res, next);
        } catch (err) {
            return fail(res, err);
        }
    });

    return { router: app, channels, runtimes, runtimeFor };
}

/** What an operator needs at a glance, without opening the channel. */
function channelHealth(channel, runtime) {
    const state = runtime?.state;
    return {
        connected: Boolean(state?.transport?.isConnected?.()),
        connecting: Boolean(state?.connecting),
        running: Boolean(state),
        account: state?.info?.account ?? '',
        detail: state?.info?.detail ?? '',
        error: state?.info?.error ?? null,
        withinSendingWindow: withinSendingWindow(channel),
    };
}

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
// Agents may send and triage, but not change how the account behaves.
const AGENT_WRITES = new Set(['/messages', '/inbox/mark-read']);

export function createApp({
    db = new Database(), config = loadConfig(), deps = {}, dataDir = APP_DIR,
} = {}) {
    const app = express();
    app.use(express.json({ limit: '1mb' }));

    const tenancy = new Tenancy(db);
    const runtimes = new Map();
    const logins = new Map(); // email -> { fails, until }  ponytail: in-memory, per process

    const runtimeFor = (tenantId) => {
        let runtime = runtimes.get(tenantId);
        if (!runtime) {
            const isDefault = tenantId === DEFAULT_TENANT_ID;
            const tenantDir = isDefault ? dataDir : path.join(dataDir, 'tenants', String(tenantId));
            const scoped = db.forTenant(tenantId);
            scoped.seedAutoReplies();
            runtime = createTenantRuntime({
                db: scoped,
                config: isDefault ? config : loadConfig(path.join(tenantDir, 'config.json')),
                tenantDir,
                sessionDir: isDefault ? SESSION_DIR : path.join(tenantDir, 'wwebjs_auth'),
                deps,
                audit,
            });
            runtimes.set(tenantId, runtime);
        }
        return runtime;
    };

    const audit = (req, action, target = '', detail = '') => tenancy.audit({
        tenantId: req.tenantId ?? req.user?.tenantId ?? null, userId: req.user?.id ?? null,
        action, target, detail,
    });
    const fail = (res, err) => {
        if (err instanceof TenancyError) return res.status(err.status).json({ errors: [err.message] });
        throw err;
    };

    // --------------------------------------------------------- public --
    app.get('/api/health', (req, res) => res.json({ ok: true, status: 'ready' }));

    // Meta cannot send a bearer token, so the webhook is public and per tenant.
    app.all(['/api/webhook', '/api/webhook/:tenantId'], (req, res, next) => {
        const id = req.params.tenantId === undefined ? DEFAULT_TENANT_ID : Number(req.params.tenantId);
        if (tenancy.getTenant(id)?.status !== 'active') return res.sendStatus(404);
        const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        req.url = `/webhook${query}`;
        return runtimeFor(id).router(req, res, next);
    });

    app.post('/api/auth/login', async (req, res) => {
        const { email = '', password = '' } = req.body ?? {};
        const key = String(email).trim().toLowerCase();
        const entry = logins.get(key);
        if (entry && entry.fails >= LOGIN_MAX_FAILS && entry.until > Date.now()) {
            return res.status(429).json({ errors: ['Too many failed attempts. Try again in a few minutes.'] });
        }
        const user = await tenancy.authenticate(email, password);
        const tenant = user?.tenantId == null ? null : tenancy.getTenant(user.tenantId);
        if (!user || (tenant && tenant.status !== 'active')) {
            logins.set(key, { fails: (entry?.until > Date.now() ? entry.fails : 0) + 1, until: Date.now() + LOGIN_WINDOW_MS });
            return res.status(401).json({ errors: ['Wrong email or password.'] });
        }
        logins.delete(key);
        tenancy.audit({ tenantId: user.tenantId, userId: user.id, action: 'auth.login' });
        return res.json({ token: tenancy.createSession(user.id), user, tenant });
    });

    // ----------------------------------------------------------- auth --
    app.use('/api', (req, res, next) => {
        const header = req.get('authorization') ?? '';
        // EventSource cannot set headers, so the stream alone takes ?token=.
        const token = header.startsWith('Bearer ') ? header.slice(7)
            : (req.path === '/events' ? req.query.token : null);
        const user = tenancy.resolveSession(token);
        if (!user) return res.status(401).json({ errors: ['Sign in to continue.'] });
        req.user = user;
        req.token = token;
        return next();
    });

    const requireRole = (min) => (req, res, next) => (roleRank(req.user.role) >= roleRank(min)
        ? next() : res.status(403).json({ errors: ['You do not have permission to do that.'] }));

    /** Resolve the tenant a request acts on. Super admins pick one with X-Tenant-Id. */
    const withTenant = (req, res, next) => {
        let id = req.user.tenantId;
        if (req.user.role === 'super_admin') {
            id = Number(req.get('x-tenant-id') || req.query.tenant);
            if (!Number.isInteger(id) || !tenancy.getTenant(id)) {
                return res.status(400).json({ errors: ['Choose a tenant (X-Tenant-Id).'] });
            }
        }
        req.tenantId = id;
        return next();
    };

    app.get('/api/auth/me', (req, res) => res.json({
        user: req.user,
        tenant: req.user.tenantId == null ? null : tenancy.getTenant(req.user.tenantId),
    }));

    app.post('/api/auth/logout', (req, res) => {
        tenancy.deleteSession(req.token);
        res.json({ ok: true });
    });

    // ---------------------------------------------------- super admin --
    const admin = express.Router();
    admin.use(requireRole('super_admin'));
    app.use('/api/admin', admin);

    admin.get('/tenants', (req, res) => res.json({
        tenants: tenancy.listTenants().map((t) => ({ ...t, users: tenancy.listUsers(t.id).length })),
    }));

    admin.post('/tenants', async (req, res) => {
        const { name, slug, owner = {} } = req.body ?? {};
        try {
            const tenant = tenancy.createTenant(name, slug);
            const user = await tenancy.createUser({ ...owner, tenantId: tenant.id, role: 'owner' });
            audit(req, 'tenant.create', tenant.id, tenant.slug);
            return res.status(201).json({ tenant, owner: user });
        } catch (err) {
            return fail(res, err);
        }
    });

    admin.patch('/tenants/:id', (req, res) => {
        try {
            const tenant = tenancy.setTenantStatus(req.params.id, req.body?.status);
            audit(req, `tenant.${tenant.status}`, tenant.id);
            return res.json({ tenant });
        } catch (err) {
            return fail(res, err);
        }
    });

    admin.get('/audit-logs', (req, res) => res.json({
        logs: tenancy.listAudit({
            tenantId: req.query.tenant ? Number(req.query.tenant) : null,
            limit: Math.min(Number(req.query.limit) || 200, 1000),
        }),
    }));

    // ---------------------------------------------------------- team --
    const team = express.Router();
    team.use(withTenant, requireRole('admin'));
    app.use('/api/users', team);

    team.get('/', (req, res) => res.json({ users: tenancy.listUsers(req.tenantId), roles: ROLES.filter((r) => r !== 'super_admin') }));

    team.post('/', async (req, res) => {
        const role = req.body?.role ?? 'agent';
        // You can only create people below you; owners come from the platform admin.
        if (roleRank(role) >= roleRank(req.user.role) && req.user.role !== 'super_admin') {
            return res.status(403).json({ errors: ['You can only add users with a lower role than yours.'] });
        }
        try {
            const user = await tenancy.createUser({ ...req.body, role, tenantId: req.tenantId });
            audit(req, 'user.create', user.id, `${user.email} (${user.role})`);
            return res.status(201).json({ user });
        } catch (err) {
            return fail(res, err);
        }
    });

    team.patch('/:id', (req, res) => {
        const target = tenancy.listUsers(req.tenantId).find((u) => u.id === Number(req.params.id));
        if (!target) return res.status(404).json({ errors: ['user not found'] });
        if (target.id === req.user.id) return res.status(400).json({ errors: ['You cannot disable yourself.'] });
        if (roleRank(target.role) >= roleRank(req.user.role) && req.user.role !== 'super_admin') {
            return res.status(403).json({ errors: ['You cannot change a user at or above your role.'] });
        }
        try {
            const user = tenancy.setUserDisabled(req.tenantId, target.id, Boolean(req.body?.disabled));
            audit(req, user.disabled ? 'user.disable' : 'user.enable', user.id, user.email);
            return res.json({ user });
        } catch (err) {
            return fail(res, err);
        }
    });

    // ------------------------------------------------- tenant routes --
    app.use('/api', withTenant, (req, res, next) => {
        const write = req.method !== 'GET' && req.method !== 'HEAD';
        if (write && roleRank(req.user.role) < roleRank('admin') && !AGENT_WRITES.has(req.path)) {
            return res.status(403).json({ errors: ['You do not have permission to do that.'] });
        }
        if (write) {
            const action = `${req.method} ${req.path}`; // the router rewrites req.url later
            res.on('finish', () => {
                if (res.statusCode < 400) audit(req, action);
            });
        }
        return runtimeFor(req.tenantId).router(req, res, next);
    });

    app.locals.runtimes = runtimes;
    app.locals.tenancy = tenancy;
    app.locals.runtimeFor = runtimeFor;
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
        // Opt-out is always honoured; auto-replies are a capability the
        // channel can be switched out of without going dark on STOP.
        if (!state.channel.capabilities.includes('auto_replies')) return saved;
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

async function handleWebhookInbounds(state, deps, inbounds) {
    try {
        await ensureWebhookTransport(state, deps);
    } catch (err) {
        broadcast(state, {
            type: 'inbound_error',
            sender: null,
            error: `Webhook transport unavailable: ${err.message ?? String(err)}`,
        });
    }
    for (const inbound of inbounds) {
        await handleInbound(state, inbound);
    }
}

async function ensureWebhookTransport(state, deps) {
    if (state.transport?.isConnected?.()) return state.transport;
    if (state.config.transport !== TRANSPORT_CLOUD_API) return null;

    if (!state.webhookConnect) {
        state.webhookConnect = (async () => {
            const problems = validateConfig(state.config);
            if (problems.length) throw new Error(problems.join(' '));

            const transport = createTransport(state.config, deps);
            const info = await transport.connect();
            state.transport = transport;
            state.info = info;
            state.qr = null;
            state.connecting = false;
            state.manager.setTransport(transport);
            state.autoReply.setTransport(transport);
            state.manager.start();
            broadcast(state, { type: 'connection', ...connectionState(state) });
            return transport;
        })().finally(() => {
            state.webhookConnect = null;
        });
    }
    return state.webhookConnect;
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
    for (const tenant of app.locals.runtimes?.values() ?? []) {
        for (const { state } of tenant.runtimes.values()) await closeState(state);
    }
}

async function closeState(state) {
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
        connecting: Boolean(state.connecting),
        transport: state.config.transport,
        name: transport?.name ?? null,
        account: state.info?.account ?? '',
        detail: state.info?.detail ?? '',
        error: state.info?.error ?? null,
        code: state.info?.code ?? null,
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
