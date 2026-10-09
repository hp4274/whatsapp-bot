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
    DEFAULTS,
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
    POLICY_KEYS,
} from './config.js';
import { DEFAULT_TENANT_ID, Database } from './db.js';
import {
    buildPaymentReminderMessage,
    importPaymentReminders,
    remindersToContacts,
} from './paymentReminders.js';
import { importContacts } from './contacts.js';
import { PhoneError, contactContext, normalizePhone, personalize } from './protocol.js';
import {
    CAPABILITIES,
    ChannelError,
    Channels,
    publicChannel,
    withinSendingWindow,
} from './channels.js';
import { ContactError, ContactStore } from './contactStore.js';
import { createInboxRouter } from './inbox/routes.js';
import { ConversationStore } from './inbox/store.js';
import { createKnowledgeRouter } from './knowledge/routes.js';
import { KnowledgeStore } from './knowledge/store.js';
import { createObjectRouter } from './objects/routes.js';
import { createTicketRouter } from './tickets/routes.js';
import { TicketStore } from './tickets/store.js';
import { JobStore } from './scheduler/store.js';
import { SchedulerWorker } from './scheduler/worker.js';
import { TemplateError, TemplateStore, validate as validateTemplate } from './templates/store.js';
import { WorkflowEngine } from './workflows/engine.js';
import { WorkflowError } from './workflows/definition.js';
import { WorkflowStore, dueRuns } from './workflows/store.js';
import { MessageJobError, messageJob } from './messaging/job.js';
import { MessageService } from './messaging/service.js';
import { createBillingRouter } from './billing/routes.js';
import { createCampaignRouter } from './campaigns/routes.js';
import { dueCampaigns } from './campaigns/store.js';
import { BillingStore } from './billing/store.js';
import { bindContext, requestContext } from './observability/logger.js';
import { registerQueue, snapshot, unregisterQueue } from './observability/metrics.js';
import { ApiKeyStore } from './publicapi/keys.js';
import { createPublicApiRouter } from './publicapi/routes.js';
import { WEBHOOK_JOB_KIND, createWebhookDeliveryHandler } from './publicapi/webhooks.js';
import { RECIPES, getRecipe, installRecipe } from './recipes/index.js';
import { SCHOOL_TEMPLATES, STUDENT_CSV_COLUMNS } from './school/templates.js';
import { handleSchoolCommand } from './school/commands.js';
import { createSchoolRouter, schoolSweep } from './school/routes.js';
import { rateLimit, webhookSignatureGuard } from './security/signature.js';
import { ROLES, TENANT_SERVICES, Tenancy, TenancyError, roleRank } from './tenancy.js';
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

/**
 * Routers contributed by feature modules, mounted into every channel runtime.
 * Each entry is `({ db, state }) => express.Router`.
 */
const FEATURE_ROUTERS = [
    createInboxRouter,
    createTicketRouter,
    createKnowledgeRouter,
    createObjectRouter,
    createBillingRouter,
    createPublicApiRouter,
    createCampaignRouter,
    // After createObjectRouter: it reads `state.objects`.
    createSchoolRouter,
];

/** Which capability each sending route needs. Everything else is read or admin. */
const SEND_ROUTES = Object.freeze({
    '/messages': 'transactional_messages',
    '/campaign/start': 'campaigns',
    '/payment-reminders/send': 'transactional_messages',
});

/**
 * Sending routes that carry an id, so an exact-path lookup can never match
 * them. `/campaigns/7/start` is a send and must pass the same gate as
 * `/campaign/start`; keying only on the literal path silently exempted it.
 */
const SEND_ROUTE_PATTERNS = Object.freeze([
    [/^\/campaigns\/[^/]+\/start$/, 'campaigns'],
]);

const SERVICE_ROUTE_PREFIXES = Object.freeze([
    ['/channels', 'whatsapp_channels'],
    ['/contacts', 'contacts'],
    ['/segments', 'contacts'],
    ['/templates', 'templates'],
    ['/inbox', 'inbox'],
    ['/conversations', 'inbox'],
    ['/auto-replies', 'auto_replies'],
    ['/campaign', 'campaigns'],
    ['/campaigns', 'campaigns'],
    ['/payment-reminders', 'payment_reminders'],
    ['/workflows', 'workflows'],
    ['/tickets', 'tickets'],
    ['/knowledge', 'faq'],
    ['/objects/appointments', 'appointments'],
    ['/objects/orders', 'orders'],
    ['/objects/leads', 'leads'],
    ['/objects/payments', 'payment_reminders'],
    ['/objects/subscriptions', 'subscriptions'],
    ['/objects/events', 'events'],
    ['/objects/students', 'school_whatsapp_bot'],
    ['/school', 'school_whatsapp_bot'],
    ['/objects', 'workflows'],
    ['/billing', 'analytics'],
]);

/** The capability a write needs, by path. Null when the route does not send. */
function capabilityForPath(path) {
    if (SEND_ROUTES[path]) return SEND_ROUTES[path];
    for (const [pattern, capability] of SEND_ROUTE_PATTERNS) {
        if (pattern.test(path)) return capability;
    }
    return null;
}

function serviceForPath(path) {
    if (path === '/messages') return 'bulk_messages';
    return SERVICE_ROUTE_PREFIXES.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1] ?? null;
}

function tenantAccessError(tenant, req) {
    const service = serviceForPath(req.path);
    if (service && !tenant.services.includes(service)) return `${service.replaceAll('_', ' ')} is disabled for this tenant`;
    const controls = tenant.controls ?? {};
    const sendCapability = capabilityForPath(req.path);
    if (sendCapability && controls.sendingEnabled === false) return 'sending is disabled for this tenant';
    if (sendCapability === 'campaigns' && controls.campaignsEnabled === false) {
        return 'campaign sending is disabled for this tenant';
    }
    if (['/auto-replies', '/workflows'].some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))
        && controls.automationsEnabled === false) {
        return 'automations are disabled for this tenant';
    }
    return null;
}

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
        tenancy: deps.tenancy ?? null,
    };
    // Feature routers push to the browser through this rather than importing
    // `broadcast` and the client set.
    state.broadcast = (event) => broadcast(state, event);

    /**
     * Rule 2 enforcement.  A send is refused unless this channel is active, is
     * enabled for that kind of traffic, and is inside its sending window.  The
     * channel is already resolved by the time we are here, so this is the last
     * gate rather than a lookup.
     */
    app.use((req, res, next) => {
        const capability = capabilityForPath(req.path);
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
    // Phase 3: one way out. Everything that sends goes through the service,
    // which reads the live channel row so a capability switched off mid-flight
    // takes effect on the next job rather than the next restart.
    const messages = new MessageService(db, manager, () => state.channel, {
        isBotPaused: (phone, channelId) => conversations.isBotPaused(phone, channelId),
    });
    // Contacts belong to the tenant, not to one number, but the store needs the
    // channel's country code to normalise what people type.
    const contacts = new ContactStore(db, config.defaultCountryCode);
    const templates = new TemplateStore(db);
    const conversations = new ConversationStore(db);
    const tickets = new TicketStore(db);
    const knowledge = new KnowledgeStore(db);
    const billing = new BillingStore(db);
    const workflows = new WorkflowStore(db);
    const jobs = new JobStore(db);
    // The engine takes its collaborators injected, which is what keeps it
    // testable and keeps templates/workflows from importing each other.
    const engine = new WorkflowEngine({
        store: workflows,
        messages,
        contacts,
        tickets,
        channels: new Channels(db),
        renderTemplate: ({ template, variables, context }) => {
            const found = Number.isInteger(Number(template))
                ? templates.get(template) : templates.getByName(template);
            if (!found) throw new Error(`template not found: ${template}`);
            // `personalize` reads flat keys, but a run context is nested
            // ({ event, contact, vars }). Flatten it, or every {name} in a
            // template survives into the message as literal text.
            const contact = context?.contact ?? {};
            const rendered = templates.render(found.id, {
                ...contactContext(contact),
                ...(contact.customFields ?? {}),
                ...(context?.event?.data ?? {}),
                ...(variables ?? {}),
            });
            templates.recordUse(found.id);
            return { text: rendered.body, templateId: found.id };
        },
    });
    autoReply.setService(messages);
    state.manager = manager;
    state.autoReply = autoReply;
    state.messages = messages;
    state.contacts = contacts;
    state.templates = templates;
    state.conversations = conversations;
    state.tickets = tickets;
    state.knowledge = knowledge;
    state.billing = billing;
    state.workflows = workflows;
    state.engine = engine;
    state.jobs = jobs;
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
        // Anti-ban limits belong to the platform admin (PUT /api/admin/tenants/:id/safety).
        const body = { ...req.body };
        for (const key of POLICY_KEYS) delete body[key];
        const merged = mergeConfig(state.config, body);
        const problems = validateConfig(merged);
        if (problems.length) return res.status(400).json({ errors: problems });
        state.config = state.save(merged);
        manager.applyConfig(state.config);
        contacts.defaultCountryCode = state.config.defaultCountryCode;
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

        let outcome;
        try {
            outcome = messages.send({
                messageType: 'transactional',
                recipient: normalized,
                text: body,
                name,
                media,
                // A caller retrying a timed-out POST sends the same key and
                // gets the original message id back, not a second message.
                idempotencyKey: req.get('idempotency-key') || undefined,
            });
        } catch (err) {
            if (err instanceof MessageJobError) return res.status(err.status).json({ errors: [err.message] });
            throw err;
        }
        if (!outcome.accepted) {
            const reason = outcome.reason === 'opted_out'
                ? 'That number has opted out.'
                : 'That exact message is already queued for this number.';
            return res.status(409).json({ errors: [reason], messageId: outcome.messageId, reason: outcome.reason });
        }
        manager.start();
        return res.json({ messageId: outcome.messageId, recipient: normalized, message: body });
    });

    // ----------------------------------------------------------- contacts --
    app.post('/contacts/import', upload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ errors: ['no file uploaded'] });
        try {
            const result = await importContacts(
                req.file.originalname, req.file.buffer, state.config.defaultCountryCode);
            // Campaign preview just wants the parsed rows, so saving is opt-in
            // and the existing contract is unchanged.
            if (req.query.save === 'true' || req.body?.save === 'true') {
                const tags = String(req.query.tags ?? '').split(',').filter(Boolean);
                // importContacts already normalised every number.
                result.saved = contacts.importMany(result.contacts, { source: 'import', tags, normalized: true });
            }
            return res.json(result);
        } catch (err) {
            return res.status(400).json({ errors: [`Import failed: ${err.message}`] });
        }
    });

    // ------------------------------------------------------- contact book --
    const contactFail = (res, err) => {
        if (err instanceof ContactError) return res.status(err.status).json({ errors: [err.message] });
        throw err;
    };

    /** A filter can arrive as query params or, for anything structured, as JSON. */
    const filterFromQuery = (query) => {
        const filter = {};
        if (query.tags) filter.tags = String(query.tags).split(',').filter(Boolean);
        if (query.anyTags) filter.anyTags = String(query.anyTags).split(',').filter(Boolean);
        if (query.notTags) filter.notTags = String(query.notTags).split(',').filter(Boolean);
        if (query.status) filter.status = query.status;
        if (query.optInStatus) filter.optInStatus = query.optInStatus;
        if (query.source) filter.source = query.source;
        if (query.search) filter.search = query.search;
        if (query.optedOut !== undefined) filter.optedOut = query.optedOut === 'true';
        if (query.filter) {
            try {
                Object.assign(filter, JSON.parse(query.filter));
            } catch {
                // A malformed filter narrows nothing rather than failing the read.
            }
        }
        return filter;
    };

    app.get('/contacts', (req, res) => {
        const filter = filterFromQuery(req.query);
        res.json({
            contacts: contacts.find(filter, { limit: req.query.limit, offset: req.query.offset }),
            total: contacts.count(filter),
            tags: contacts.tags(),
            fieldKeys: contacts.fieldKeys(),
        });
    });

    app.post('/contacts', (req, res) => {
        try {
            // Look up by the stored form, not by whatever the caller typed.
            const existed = req.body?.phone ? contacts.getByPhone(contacts.normalize(req.body.phone)) : null;
            const contact = contacts.upsert(req.body ?? {});
            return res.status(existed ? 200 : 201).json({ contact });
        } catch (err) {
            return contactFail(res, err);
        }
    });

    app.get('/contacts/:id', (req, res) => {
        const contact = contacts.get(req.params.id);
        if (!contact) return res.status(404).json({ errors: ['contact not found'] });
        return res.json({ contact });
    });

    app.put('/contacts/:id', (req, res) => {
        const existing = contacts.get(req.params.id);
        if (!existing) return res.status(404).json({ errors: ['contact not found'] });
        try {
            // Replace rather than merge: a PUT from an edit form means "this is
            // the contact now", including any tag the user removed.
            return res.json({ contact: contacts.upsert({ ...req.body, phone: existing.phone }, { merge: false }) });
        } catch (err) {
            return contactFail(res, err);
        }
    });

    app.delete('/contacts/:id', (req, res) => {
        try {
            return res.json({ deleted: contacts.remove(req.params.id).id });
        } catch (err) {
            return contactFail(res, err);
        }
    });

    app.post('/contacts/:id/tags', (req, res) => {
        try {
            const { add = [], remove = [] } = req.body ?? {};
            let contact = add.length ? contacts.addTags(req.params.id, add) : contacts.get(req.params.id);
            if (!contact) return res.status(404).json({ errors: ['contact not found'] });
            if (remove.length) contact = contacts.removeTags(req.params.id, remove);
            return res.json({ contact });
        } catch (err) {
            return contactFail(res, err);
        }
    });

    app.get('/contacts/:id/timeline', (req, res) => {
        try {
            return res.json({ timeline: contacts.timeline(req.params.id, { limit: Number(req.query.limit) || 100 }) });
        } catch (err) {
            return contactFail(res, err);
        }
    });

    // ------------------------------------------------------------ segments --
    app.get('/segments', (req, res) => res.json({ segments: contacts.listSegments() }));

    app.post('/segments', (req, res) => {
        try {
            const segment = contacts.saveSegment(req.body ?? {});
            return res.status(201).json({ segment, count: contacts.count(segment.filter) });
        } catch (err) {
            return contactFail(res, err);
        }
    });

    app.put('/segments/:id', (req, res) => {
        try {
            const segment = contacts.saveSegment({ ...req.body, id: req.params.id });
            return res.json({ segment, count: contacts.count(segment.filter) });
        } catch (err) {
            return contactFail(res, err);
        }
    });

    app.delete('/segments/:id', (req, res) => {
        try {
            contacts.deleteSegment(req.params.id);
            return res.json({ deleted: Number(req.params.id) });
        } catch (err) {
            return contactFail(res, err);
        }
    });

    app.get('/segments/:id/contacts', (req, res) => {
        try {
            return res.json({ contacts: contacts.segmentContacts(req.params.id, { limit: req.query.limit }) });
        } catch (err) {
            return contactFail(res, err);
        }
    });

    // ------------------------------------------------------------ templates --
    const templateFail = (res, err) => {
        if (err instanceof TemplateError) return res.status(err.status).json({ errors: [err.message] });
        throw err;
    };

    app.get('/templates', (req, res) => res.json({
        templates: templates.list({ type: req.query.type, channelId: req.query.channel }),
    }));

    app.post('/templates', (req, res) => {
        // The store saves half-written drafts on purpose; the API is the gate.
        const problems = validateTemplate(req.body ?? {});
        if (problems.length && req.query.draft !== 'true') return res.status(400).json({ errors: problems });
        try {
            return res.status(201).json({ template: templates.create(req.body ?? {}), warnings: problems });
        } catch (err) {
            return templateFail(res, err);
        }
    });

    app.get('/templates/:id', (req, res) => {
        const template = templates.get(req.params.id);
        if (!template) return res.status(404).json({ errors: ['template not found'] });
        return res.json({
            template,
            versions: templates.versions(template.id),
            compatibility: templates.compatibility(template, state.channel),
        });
    });

    app.put('/templates/:id', (req, res) => {
        const problems = validateTemplate({ ...templates.get(req.params.id), ...req.body });
        if (problems.length && req.query.draft !== 'true') return res.status(400).json({ errors: problems });
        try {
            return res.json({ template: templates.update(req.params.id, req.body ?? {}) });
        } catch (err) {
            return templateFail(res, err);
        }
    });

    app.delete('/templates/:id', (req, res) => {
        try {
            templates.remove(req.params.id);
            return res.json({ deleted: Number(req.params.id) });
        } catch (err) {
            return templateFail(res, err);
        }
    });

    app.post('/templates/:id/revert', (req, res) => {
        try {
            return res.json({ template: templates.revert(req.params.id, req.body?.version) });
        } catch (err) {
            return templateFail(res, err);
        }
    });

    app.post('/templates/:id/preview', (req, res) => {
        try {
            return res.json(templates.preview(req.params.id, req.body?.context ?? {}));
        } catch (err) {
            return templateFail(res, err);
        }
    });

    // ------------------------------------------------------------ workflows --
    const workflowFail = (res, err) => {
        if (err instanceof WorkflowError) return res.status(err.status ?? 400).json({ errors: [err.message] });
        throw err;
    };

    app.get('/workflows', (req, res) => res.json({ workflows: workflows.list({ status: req.query.status }) }));

    app.post('/workflows', (req, res) => {
        try {
            return res.status(201).json({ workflow: workflows.create(req.body ?? {}) });
        } catch (err) {
            return workflowFail(res, err);
        }
    });

    app.get('/workflows/:id', (req, res) => {
        const workflow = workflows.get(req.params.id);
        if (!workflow) return res.status(404).json({ errors: ['workflow not found'] });
        return res.json({ workflow, versions: workflows.versions(workflow.id) });
    });

    app.put('/workflows/:id', (req, res) => {
        try {
            return res.json({ workflow: workflows.update(req.params.id, req.body ?? {}) });
        } catch (err) {
            return workflowFail(res, err);
        }
    });

    app.delete('/workflows/:id', (req, res) => {
        try {
            workflows.remove(req.params.id);
            return res.json({ deleted: Number(req.params.id) });
        } catch (err) {
            return workflowFail(res, err);
        }
    });

    app.get('/workflows/:id/runs', (req, res) => res.json({
        runs: workflows.listRuns({ workflowId: Number(req.params.id), status: req.query.status, limit: 200 }),
    }));

    app.get('/workflow-runs/:runId', (req, res) => {
        const run = workflows.getRun(req.params.runId);
        if (!run) return res.status(404).json({ errors: ['run not found'] });
        return res.json({ run, steps: workflows.runSteps(run.runId ?? req.params.runId) });
    });

    app.post('/workflow-runs/:runId/retry', async (req, res) => {
        try {
            return res.json({ run: await engine.retry(req.params.runId) });
        } catch (err) {
            return workflowFail(res, err);
        }
    });

    app.post('/workflow-runs/:runId/stop', (req, res) => {
        try {
            return res.json({ run: engine.stop(req.params.runId) });
        } catch (err) {
            return workflowFail(res, err);
        }
    });

    /** The external event entry point: this is what starts a workflow. */
    app.post('/events', async (req, res) => {
        try {
            const runs = await engine.dispatch({ ...req.body, tenantId: db.tenantId, channelId: state.channel.id });
            return res.status(202).json({ runs: runs.map((r) => r.runId ?? r.run?.runId ?? null) });
        } catch (err) {
            return workflowFail(res, err);
        }
    });

    // ------------------------------------------------------------- jobs ------
    app.get('/jobs', (req, res) => res.json({
        jobs: jobs.list({ status: req.query.status, kind: req.query.kind, limit: 200 }),
        dead: jobs.listDead({ limit: 50 }),
        stats: jobs.stats(),
    }));

    app.post('/jobs/:id/retry', (req, res) => {
        const job = jobs.retryDead(req.params.id);
        if (!job) return res.status(404).json({ errors: ['job not found'] });
        return res.json({ job });
    });

    app.delete('/jobs/:id', (req, res) => {
        const job = jobs.cancel(req.params.id);
        if (!job) return res.status(404).json({ errors: ['job not found'] });
        return res.json({ cancelled: job.id });
    });

    // Feature routers. Each module owns its own routes and is mounted here, so
    // adding a feature is one import and one line rather than another thousand
    // lines in this file.
    for (const mount of FEATURE_ROUTERS) app.use(mount({ db, state }));

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
        // `audience` is the request's contact list; `contacts` is the store.
        const {
            contacts: audience = [], segmentId = null, template = '',
            onePerNumber = true, mediaId = null,
        } = req.body ?? {};
        if (!template) return res.status(400).json({ errors: ['message is required'] });

        // A segment is resolved at send time, so the audience is whoever
        // matches now rather than whoever matched when it was saved.
        let list = audience;
        if (segmentId) {
            try {
                list = contacts.segmentContacts(segmentId, { limit: 5000 })
                    .filter((contact) => contact.messageable)
                    .map((contact) => ({ name: contact.name, phone: contact.phone, extra: contact.customFields }));
            } catch (err) {
                return contactFail(res, err);
            }
        }
        if (!list.length) {
            return res.status(400).json({ errors: [segmentId ? 'that segment is empty' : 'no contacts'] });
        }
        if (!state.transport?.isConnected?.()) {
            return res.status(409).json({ errors: ['Connect a transport first.'] });
        }
        manager.resetStats();
        manager.queue.reset();
        manager.pausedByQuota = false;
        const media = mediaId ? state.media.get(mediaId) : null;
        if (mediaId && !media) return res.status(404).json({ errors: ['media not found'] });
        const result = manager.enqueueContacts(list, template, { onePerNumber, media });
        manager.start();
        return res.json({ ...result, segmentId, audience: list.length });
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

    /** Phase 3 queue observability: depth, what is in it, and how it is going. */
    app.get('/queue', (req, res) => res.json({ queue: messages.snapshot() }));

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

    // Verified against the channel's app secret when one is configured; see
    // `webhookSignatureGuard` for why "none configured" lets the request in.
    const webhookSecret = () => state.channel?.settings?.appSecret || state.config.appSecret;
    app.post('/webhook', webhookSignatureGuard(webhookSecret), (req, res) => {
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

    // Phase 18: the gauge reads the live queue rather than being pushed to.
    registerQueue(channel.id, () => manager.queue.pending);

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
function createTenantRuntime({ db, config, tenantDir, sessionDir, deps, audit, policy = () => ({}) }) {
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
        enforcePolicy(runtime);
        return runtime;
    };

    /** The platform's anti-ban limits win over whatever a channel's own settings say. */
    const enforcePolicy = ({ state }) => {
        const wanted = policy();
        if (!POLICY_KEYS.some((key) => key in wanted && state.config[key] !== wanted[key])) return;
        Object.assign(state.config, wanted);
        state.manager.applyConfig(state.config);
    };
    const applyPolicy = () => runtimes.forEach(enforcePolicy);

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
            bindContext({ channelId: channel.id });
            return runtimeFor(channel).router(req, res, next);
        } catch (err) {
            return fail(res, err);
        }
    });

    return { router: app, channels, runtimes, runtimeFor, applyPolicy };
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
/**
 * An agent talks to customers and works the queue, so inbox and ticket writes
 * are theirs. Anything that changes how the account behaves still is not.
 */
// `/school` checks each staff title's areas itself (class teachers mark attendance).
const AGENT_WRITE_PREFIXES = ['/conversations', '/tickets', '/school'];

export function createApp({
    db = new Database(), config = loadConfig(), deps = {}, dataDir = APP_DIR,
    // Off by default: a test that builds an app should not start a timer it
    // never asked for. `index.js` turns it on for the real server.
    scheduler = false, sweepMs = 5000,
} = {}) {
    const app = express();
    // Before the body parser, so a malformed body is still logged with an id.
    app.use(requestContext());
    app.use(express.json({
        limit: '1mb',
        // The webhook signature is over the raw bytes, which the parser
        // consumes; keep them for that route only.
        verify: (req, res, buf) => {
            if (req.url.startsWith('/api/webhook')) req.rawBody = buf;
        },
    }));

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
                // The school module needs the tenant's services and user list.
                deps: { ...deps, tenancy },
                audit,
                policy: () => tenancy.getTenant(tenantId)?.safety ?? {},
            });
            runtimes.set(tenantId, runtime);
        }
        return runtime;
    };

    const closeTenantRuntime = async (tenantId) => {
        const runtime = runtimes.get(Number(tenantId));
        if (!runtime) return;
        for (const { state } of runtime.runtimes.values()) await closeState(state);
        runtimes.delete(Number(tenantId));
    };

    const tenantOverview = (tenant) => {
        const runtime = runtimes.get(tenant.id);
        const scoped = db.forTenant(tenant.id);
        const channels = new Channels(scoped).list().map((channel) => {
            const health = channelHealth(channel, runtime?.runtimes.get(channel.id));
            return {
                id: channel.id,
                displayName: channel.displayName,
                provider: channel.provider,
                phoneNumber: channel.phoneNumber,
                status: channel.status,
                capabilities: channel.capabilities,
                isDefault: channel.isDefault,
                health,
            };
        });
        const counts = scoped.countsByStatus?.() ?? {};
        return {
            ...tenant,
            users: tenancy.listUsers(tenant.id).length,
            channels,
            health: {
                channels: channels.length,
                connected: channels.filter((channel) => channel.health.connected).length,
                running: channels.filter((channel) => channel.health.running).length,
                disabled: channels.filter((channel) => channel.status !== 'active').length,
                outsideWindow: channels.filter((channel) => !channel.health.withinSendingWindow).length,
                sent: Number(counts.SENT ?? 0) + Number(counts.DELIVERED ?? 0) + Number(counts.READ ?? 0),
                failed: Number(counts.FAILED ?? 0),
                queued: Number(counts.QUEUED ?? 0) + Number(counts.SENDING ?? 0),
            },
        };
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
        const tenant = tenancy.getTenant(id);
        if (tenant?.status !== 'active' || tenant.controls?.inboundEnabled === false) return res.sendStatus(404);
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

    /**
     * The public API authenticates with an API key, so it must sit above the
     * session middleware below - that one 401s anything without a bearer
     * *session*. The key selects the tenant, exactly as the webhook path does.
     */
    app.all('/api/v1/*splat', (req, res, next) => {
        const header = req.get('authorization') ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-key');
        const key = new ApiKeyStore(db).verify(presented);
        if (!key) return res.status(401).json({ error: 'invalid_api_key' });
        if (tenancy.getTenant(key.tenantId)?.status !== 'active') return res.sendStatus(404);
        bindContext({ tenantId: key.tenantId });
        req.url = req.url.slice('/api'.length);
        return runtimeFor(key.tenantId).router(req, res, next);
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

    // After auth so a bucket is per user/tenant rather than per IP, and after
    // login, which has its own throttle.
    app.use('/api', rateLimit({ ratePerSecond: 20, burst: 40 }));

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
        bindContext({ tenantId: id });
        return next();
    };

    app.get('/api/metrics', (req, res) => (roleRank(req.user.role) >= roleRank('super_admin')
        ? res.json(snapshot())
        : res.status(403).json({ errors: ['You do not have permission to do that.'] })));

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
        tenants: tenancy.listTenants().map(tenantOverview),
        services: TENANT_SERVICES,
    }));

    admin.post('/tenants', async (req, res) => {
        try {
            const { tenant, owner: user } = await tenancy.createTenantWithOwner(req.body ?? {});
            audit(req, 'tenant.create', tenant.id, tenant.slug);
            return res.status(201).json({ tenant: tenantOverview(tenant), owner: user });
        } catch (err) {
            return fail(res, err);
        }
    });

    admin.patch('/tenants/:id', async (req, res) => {
        try {
            const tenant = tenancy.updateTenant(req.params.id, req.body ?? {});
            if (tenant.status === 'suspended') await closeTenantRuntime(tenant.id);
            audit(req, `tenant.${tenant.status}`, tenant.id, {
                services: tenant.services,
                controls: tenant.controls,
            });
            return res.json({ tenant: tenantOverview(tenant) });
        } catch (err) {
            return fail(res, err);
        }
    });

    // ---- school pack: master catalogue + one-click provisioning per tenant ----
    const schoolRecipes = () => RECIPES.filter((r) => r.industry.includes('school'));

    admin.get('/school/catalog', (req, res) => res.json({
        recipes: schoolRecipes().map(({ key, name, description }) => ({ key, name, description })),
        templates: Object.entries(SCHOOL_TEMPLATES).map(([name, body]) => ({ name, body })),
        studentColumns: STUDENT_CSV_COLUMNS,
    }));

    admin.post('/tenants/:id/school/provision', (req, res) => {
        const tenant = tenancy.getTenant(req.params.id);
        if (!tenant) return res.status(404).json({ errors: ['tenant not found'] });
        if (!tenant.services.includes('school_whatsapp_bot')) {
            return res.status(409).json({ errors: ['tenant does not have the school_whatsapp_bot service enabled'] });
        }
        const body = req.body ?? {};
        const wanted = body.recipes === undefined ? schoolRecipes() : [];
        if (body.recipes !== undefined) {
            if (!Array.isArray(body.recipes)) return res.status(400).json({ errors: ['recipes must be an array of keys'] });
            for (const key of body.recipes) {
                const recipe = getRecipe(key);
                if (!recipe) return res.status(400).json({ errors: [`unknown recipe: ${key}`] });
                wanted.push(recipe);
            }
        }
        const status = body.status === 'active' ? 'active' : 'draft';
        const rt = runtimeFor(tenant.id);
        const channel = rt.channels.getDefault();
        if (!channel) return res.status(409).json({ errors: ['tenant has no channel yet'] });
        const { templates, workflows } = rt.runtimeFor(channel).state;

        const result = { templates: [], workflows: [], skipped: [] };
        if (body.templates !== false) {
            for (const [name, text] of Object.entries(SCHOOL_TEMPLATES)) {
                if (templates.getByName(name)) { result.skipped.push(`template:${name}`); continue; }
                templates.create({ name, body: text, channelId: channel.id });
                result.templates.push(name);
            }
        }
        const existing = new Set(workflows.list().map((w) => w.name));
        for (const recipe of wanted) {
            if (existing.has(recipe.build().name)) { result.skipped.push(recipe.key); continue; }
            const { workflow, templates: made } = installRecipe(recipe, { workflows, templates, channelId: channel.id, status });
            result.templates.push(...made);
            result.workflows.push({ id: workflow.id, name: workflow.name });
        }
        audit(req, 'tenant.school_provision', tenant.id, { templates: result.templates.length, workflows: result.workflows.length });
        return res.status(201).json(result);
    });

    // Anti-ban policy (pacing, daily cap, rate, retries): effective values = defaults + overrides.
    const safetyView = (tenant) => ({
        safety: Object.fromEntries(POLICY_KEYS.map((key) => [key, tenant.safety[key] ?? DEFAULTS[key]])),
    });

    admin.get('/tenants/:id/safety', (req, res) => {
        const tenant = tenancy.getTenant(req.params.id);
        return tenant ? res.json(safetyView(tenant)) : res.status(404).json({ errors: ['tenant not found'] });
    });

    admin.put('/tenants/:id/safety', (req, res) => {
        try {
            const tenant = tenancy.setSafety(req.params.id, req.body ?? {});
            runtimes.get(tenant.id)?.applyPolicy();
            audit(req, 'tenant.safety', tenant.id, tenant.safety);
            return res.json(safetyView(tenant));
        } catch (err) {
            return fail(res, err);
        }
    });

    admin.delete('/tenants/:id', async (req, res) => {
        try {
            const tenant = tenancy.archiveTenant(req.params.id);
            await closeTenantRuntime(tenant.id);
            audit(req, 'tenant.delete', tenant.id, tenant.slug);
            return res.json({ tenant: tenantOverview(tenant), deleted: 1 });
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
        const tenant = tenancy.getTenant(req.tenantId);
        const accessError = tenant ? tenantAccessError(tenant, req) : 'tenant not found';
        if (accessError) return res.status(403).json({ errors: [accessError] });
        const write = req.method !== 'GET' && req.method !== 'HEAD';
        const agentMayWrite = AGENT_WRITES.has(req.path)
            || AGENT_WRITE_PREFIXES.some((prefix) => req.path.startsWith(prefix));
        if (write && roleRank(req.user.role) < roleRank('admin') && !agentMayWrite) {
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

    /**
     * The bridge between a waiting workflow run and the clock.
     *
     * The engine deliberately holds no timer: hitting a `wait` writes
     * `resume_at` to the run row and returns, so a 24-hour wait survives a
     * restart. Something has to come back for it, and this is that something -
     * one sweep across every tenant, resolving each run's own engine.
     *
     * ponytail: a single in-process sweeper, so no lease is needed on resume.
     * Running two app processes against one database would double-execute a
     * run; the upgrade is a claim (`UPDATE ... WHERE status = 'waiting'`)
     * inside resume before that becomes possible.
     */
    const sweep = async () => {
        let due = [];
        try {
            due = dueRuns(db, new Date());
        } catch (err) {
            console.error('[workflows] sweep failed:', err.message);
            return;
        }
        // A campaign with `scheduled_at` holds no timer either, for the same
        // reason: the row is the state and must survive a restart.
        try {
            for (const { id, tenantId } of dueCampaigns(db, new Date())) {
                try {
                    const tenant = runtimeFor(tenantId);
                    const channel = tenant.channels.getDefault();
                    if (channel) tenant.runtimeFor(channel).state.campaigns?.start(id);
                } catch (err) {
                    // An empty audience or a deleted template must not stop the
                    // sweep for every other tenant.
                    console.error(`[campaigns] ${id} failed to start:`, err.message);
                }
            }
        } catch (err) {
            console.error('[campaigns] sweep failed:', err.message);
        }

        for (const { runId, tenantId } of due) {
            try {
                const tenant = runtimeFor(tenantId);
                const channel = tenant.channels.getDefault();
                if (!channel) continue;
                await tenant.runtimeFor(channel).state.engine.resume(runId);
            } catch (err) {
                // One bad run must not stop the sweep for every other tenant.
                console.error(`[workflows] run ${runId} failed to resume:`, err.message);
            }
        }

        // School clock: auto absent alerts, monthly summaries, overdue fees,
        // scheduled homework/notices. Only tenants that have used the school
        // portal have a settings row, so other tenants never get a runtime here.
        try {
            for (const { tenant_id: tenantId } of db.db.prepare('SELECT tenant_id FROM school_settings').all()) {
                try {
                    const tenant = tenancy.getTenant(tenantId);
                    if (tenant?.status !== 'active' || !tenant.services.includes('school_whatsapp_bot')) continue;
                    const runtime = runtimeFor(tenantId);
                    const channel = runtime.channels.getDefault();
                    if (channel) await schoolSweep(runtime.runtimeFor(channel).state);
                } catch (err) {
                    console.error(`[school] sweep for tenant ${tenantId} failed:`, err.message);
                }
            }
        } catch (err) {
            console.error('[school] sweep failed:', err.message);
        }
    };

    if (scheduler) {
        const timer = setInterval(() => { void sweep(); }, sweepMs);
        timer.unref();

        // Outbound webhooks are durable jobs, not a second retry loop.
        const jobs = new JobStore(db);
        const worker = new SchedulerWorker(jobs, { allTenants: true });
        worker.register(WEBHOOK_JOB_KIND, createWebhookDeliveryHandler({ db }));
        worker.start();
        app.locals.worker = worker;

        app.locals.stopScheduler = async () => {
            clearInterval(timer);
            await worker.shutdown();
        };
    }
    app.locals.sweep = sweep;

    app.locals.runtimes = runtimes;
    app.locals.tenancy = tenancy;
    app.locals.runtimeFor = runtimeFor;
    return app;
}

async function handleInbound(state, message) {
    const saved = state.db.insertInbound(message);
    // Every inbound message belongs to a conversation, whether or not anyone is
    // watching the inbox. Created here because this is the one place every
    // transport's inbound converges.
    const conversation = state.conversations?.upsertForInbound({
        phone: saved.sender, channelId: state.channel.id, at: saved.receivedAt,
    });
    broadcast(state, { type: 'inbound_message', message: saved, conversationId: conversation?.id ?? null });
    try {
        const optOut = await processOptOut(state.db, state.transport, saved);
        if (optOut.handled) {
            broadcast(state, { type: 'optout', sender: saved.sender, action: optOut.action });
            return saved;
        }
        // Opt-out is always honoured; auto-replies are a capability the
        // channel can be switched out of without going dark on STOP.
        if (!state.channel.capabilities.includes('auto_replies')) return saved;
        // A human has the conversation: the bot does not talk over them. The
        // message service enforces this too, but returning early also skips the
        // typing delay and the FAQ lookup.
        if (state.conversations?.isBotPaused(saved.sender, state.channel.id)) return saved;

        // Parent keywords (ATTENDANCE, FEES, LEAVE...) before the FAQ; only a
        // number linked to a student is answered, everyone else falls through.
        if ((await handleSchoolCommand(state, saved)).handled) return saved;

        // The knowledge base answers first and the keyword engine is the
        // fallback, so an operator migrates at their own pace: with no FAQ
        // items the match is always null and behaviour is unchanged.
        const hit = state.knowledge?.answer(saved.body, { channel: state.channel });
        if (hit?.item) {
            const outcome = state.messages.send({
                messageType: 'auto_reply',
                recipient: saved.sender,
                text: hit.item.answer,
                idempotencyKey: `faq.${saved.messageId}.${hit.item.id}`,
            });
            if (outcome.accepted) {
                state.db.markInboundReplied(saved.messageId, `faq:${hit.item.id}`);
                broadcast(state, {
                    type: 'faq_reply', sender: saved.sender, itemId: hit.item.id, level: hit.level,
                });
                return saved;
            }
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
    await app.locals.stopScheduler?.();
    for (const tenant of app.locals.runtimes?.values() ?? []) {
        for (const { state } of tenant.runtimes.values()) await closeState(state);
    }
}

async function closeState(state) {
    unregisterQueue(state.channel?.id);
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
