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
import { COMPLAINT_WORDS } from './campaign/humanize.js';
import { CampaignManager, NOT_ON_WHATSAPP_TEXT } from './campaign/manager.js';
import { auditRows, cleanCountryCode, guessMapping, parseSheet } from './campaign/importer.js';
import { channelInputProblems, channelUsage } from './channelUsage.js';
import {
    APP_DIR,
    SESSION_DIR,
    TRANSPORTS,
    TRANSPORT_SANDBOX,
    TRANSPORT_BAILEYS,
    QR_TRANSPORTS,
    DEFAULTS,
    loadConfig,
    mergeConfig,
    publicConfig,
    saveConfig,
    validateConfig,
    ADMIN_CHANNEL_KEYS,
    POLICY_KEYS,
    POLICY_SPEC,
} from './config.js';
import { DEFAULT_TENANT_ID, Database } from './db.js';
import {
    buildPaymentReminderMessage,
    importPaymentReminders,
    remindersToContacts,
} from './paymentReminders.js';
import {
    PREVIEW_ROWS, columnQuality, contactsToCsv, csvCell, importContacts, mappedRowsToContacts, parseTable, resolveMapping, suggestMapping,
} from './contacts.js';
import { PhoneError, contactContext, normalizePhone, personalize, utcNow } from './protocol.js';
import {
    CAPABILITIES,
    ChannelError,
    Channels,
    publicChannel,
    withinSendingWindow,
} from './channels.js';
import { BULK_ACTIONS, ContactError, ContactStore, MAX_BULK } from './contactStore.js';
import { createInboxRouter } from './inbox/routes.js';
import { createAnalyticsRouter } from './analytics/routes.js';
import { ConversationStore } from './inbox/store.js';
import { createKnowledgeRouter } from './knowledge/routes.js';
import { createAutoReplyRouter } from './autoreply/routes.js';
import { KnowledgeStore } from './knowledge/store.js';
import { createObjectRouter } from './objects/routes.js';
import { createTicketRouter } from './tickets/routes.js';
import { TicketStore } from './tickets/store.js';
import { JobStore } from './scheduler/store.js';
import { SchedulerWorker } from './scheduler/worker.js';
import { TemplateError, TemplateStore, validate as validateTemplate } from './templates/store.js';
import { needsReview, reviewBlock, spamScore, stricterCap, templateRuleProblem } from './templates/policy.js';
import { getLibraryEntry, listLibrary } from './templates/library.js';
import { registerTemplateAdmin } from './templates/admin.js';
import { WorkflowEngine } from './workflows/engine.js';
import { WorkflowError } from './workflows/definition.js';
import { WorkflowStore, dueRuns } from './workflows/store.js';
import { MessageJobError, messageJob, uniqueKey } from './messaging/job.js';
import { friendlyError } from './messaging/errors.js';
import { MessageService } from './messaging/service.js';
import { InteractiveError, normalizeInteractive, personalizeInteractive } from './messaging/interactive.js';
import { InteractiveStore, createInteractiveRouter, handleInteractiveReply, normalizeReplyRules } from './messaging/replies.js';
import { MediaStore, mediaMetadata } from './mediaStore.js';
import { createStorageRouter } from './storage/routes.js';
import { StorageError, safeName, sha256Of, uploadInfo } from './storage/store.js';
import { createBillingRouter } from './billing/routes.js';
import { createCampaignRouter } from './campaigns/routes.js';
import { dueCampaigns, openCampaigns, recurringTenants, runningSpreadCampaigns } from './campaigns/store.js';
import { LinkStore, followLink } from './links/store.js';
import { DEFAULT_PLANS } from './billing/plans.js';
import { BillingError, BillingStore } from './billing/store.js';
import { POLICY_FIELDS, PolicyError, PolicyStore, fillTables } from './policy/index.js';
import { attachCampaignPolicy, bulkKillReason, createCampaignOpsRouter, retentionSweep } from './policy/campaignOps.js';
import { bindContext, logger, requestContext } from './observability/logger.js';
import { createOpsAlerts } from './observability/alerts.js';
import { registerQueue, snapshot, unregisterQueue } from './observability/metrics.js';
import { ApiKeyStore } from './publicapi/keys.js';
import { createPublicApiRouter } from './publicapi/routes.js';
import { WEBHOOK_JOB_KIND, createWebhookDeliveryHandler } from './publicapi/webhooks.js';
import { RECIPES, getRecipe, installRecipe } from './recipes/index.js';
import { seedTenant } from './seed/index.js';
import { SCHOOL_TEMPLATES, STUDENT_CSV_COLUMNS } from './school/templates.js';
import { handleSchoolCommand } from './school/commands.js';
import { helpText, isHelp } from './help.js';
import { createSchoolRouter, schoolSweep } from './school/routes.js';
import { ipAllowed } from './security/ip.js';
import { rateLimit } from './security/signature.js';
import { checkImport, fileTypeError } from './security/filetype.js';
import { securityHeaders } from './security/headers.js';
import {
    CONSENT_TEXT, CONSENT_VERSION, NUMBER_SKIP_TEXT, NUMBER_SKIP_VERSION, SAFETY_EXIT_TEXT, SAFETY_EXIT_VERSION, ROLES, TENANT_SERVICES, Tenancy, TenancyError,
    blockedWordIn, roleRank,
} from './tenancy.js';
import { sendingTables, skipStartLevel, startLevelFor, suggestStart } from './policy/levels.js';
import { PACING_PRESETS, bulkWindowOpen } from './campaign/safety.js';
import { auditCsv, createAdminOps } from './adminOps.js';
import { lastBackup, runBackupIfDue } from './backup.js';
import { encryptionStatus } from './security/keyGate.js';
import { capMessage, createChannelOps, newNumberSafety, numberCap, overCap, providerBlocked, quotaLeft } from './policy/channelOps.js';
import { TransportError } from './transports/base.js';
import { SandboxTransport } from './transports/sandbox.js';
import { BAN_TEXT, BaileysTransport, TOS_WARNING } from './transports/baileys.js';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024 },
});
// WhatsApp's own caps: 64 MB for video, 16 MB for images and documents.
// Multer stops at the larger one; the route applies the per-type cap.
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
/** Opt-outs per 100 sent in a week that count as a danger sign (the health panel's line). */
const OPT_OUT_WARN_PERCENT = 2;
const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_VIDEO_BYTES },
});

/** Media: the bytes must be the type the browser claimed (jpeg/png/pdf/doc/docx/mp4/3gp). */
const mediaContentError = (file) => fileTypeError(file.buffer, { mimetype: file.mimetype, filename: file.originalname });

const UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');
const ALLOWED_MEDIA_TYPES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
    'video/mp4',
    'video/3gpp',
]);

export function createTransport(config, deps = {}) {
    switch (config.transport) {
        case TRANSPORT_SANDBOX:
            return new SandboxTransport(config);
        case TRANSPORT_BAILEYS:
            return new BaileysTransport(config, deps);
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
    createAutoReplyRouter,
    createObjectRouter,
    createBillingRouter,
    createAnalyticsRouter,
    createPublicApiRouter,
    createCampaignRouter,
    createStorageRouter,
    createInteractiveRouter,
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
    ['/faq', 'faq'],
    // The objects router takes the singular type name: /objects/order/:id.
    ['/objects/appointment', 'appointments'],
    ['/objects/order', 'orders'],
    ['/objects/lead', 'leads'],
    ['/objects/payment', 'payment_reminders'],
    ['/objects/subscription', 'subscriptions'],
    ['/objects/event', 'events'],
    ['/objects/student', 'school_whatsapp_bot'],
    ['/school', 'school_whatsapp_bot'],
    ['/objects', 'workflows'],
    ['/workflow-runs', 'workflows'],
    ['/recipes', 'workflows'],
    ['/api-keys', 'api'],
    ['/webhook-endpoints', 'api'],
    ['/billing', 'analytics'],
    ['/analytics', 'analytics'],
]);

/** Express matches routes case-insensitively and ignores a trailing slash; the gates must too. */
const routeKey = (path) => path.toLowerCase().replace(/\/+$/, '') || '/';

/** The capability a write needs, by path. Null when the route does not send. */
function capabilityForPath(path) {
    path = routeKey(path);
    if (SEND_ROUTES[path]) return SEND_ROUTES[path];
    for (const [pattern, capability] of SEND_ROUTE_PATTERNS) {
        if (pattern.test(path)) return capability;
    }
    return null;
}

function serviceForPath(path) {
    path = routeKey(path);
    if (path === '/messages') return 'bulk_messages';
    return SERVICE_ROUTE_PREFIXES.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1] ?? null;
}

function tenantAccessError(tenant, req) {
    const p = routeKey(req.path);
    const service = serviceForPath(p);
    if (service && !tenant.services.includes(service)) return `${service.replaceAll('_', ' ')} is disabled for this tenant`;
    const controls = tenant.controls ?? {};
    const sendCapability = capabilityForPath(p);
    if (sendCapability && controls.sendingEnabled === false) return 'sending is disabled for this tenant';
    if (sendCapability === 'campaigns' && controls.campaignsEnabled === false) {
        return 'campaign sending is disabled for this tenant';
    }
    if (['/auto-replies', '/workflows'].some((prefix) => p === prefix || p.startsWith(`${prefix}/`))
        && controls.automationsEnabled === false) {
        return 'automations are disabled for this tenant';
    }
    // Object creates/updates and /events dispatch workflows, as /api/v1 gates them.
    const write = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
    if (write && (p === '/events' || p.startsWith('/objects/')) && controls.automationsEnabled === false) {
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
function createChannelRuntime({ db, channel, config, save, linked = () => channel, sessionDir, deps }) {
    const app = express.Router();
    deps = { ...deps, sessionDir, messageStore: db }; // messageStore: Baileys answers retry requests from sent_protos

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
        media: new MediaStore(UPLOAD_DIR, db.tenantId ?? null),
        imports: new Map(), // importId -> { sheet, createdAt } for the campaign import wizard
        tenancy: deps.tenancy ?? null,
    };
    // Feature routers push to the browser through this rather than importing
    // `broadcast` and the client set.
    state.broadcast = (event) => broadcast(state, event);
    state.paused = () => deps.channelPaused?.(state.channel?.id) ?? null; // channel_ops row, written by pause()
    state.announce = () => broadcast(state, { type: 'connection', ...connectionState(state) });

    // Live UI: after any successful write, tell every open browser on this number
    // what changed, so pages reload that data without anyone pressing refresh.
    app.use((req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') return next();
        res.on('finish', () => {
            if (res.statusCode >= 400) return;
            const topic = req.path.split('/').filter(Boolean)[0] ?? '';
            broadcast(state, { type: 'changed', topic, path: req.path });
        });
        return next();
    });

    // Plan limits set by the platform admin. Read per call so a change applies at once.
    const limits = () => deps.limits?.() ?? {};
    state.limits = limits; // campaigns/routes.js enforces maxContactsPerCampaign on saved lists
    // Tenant limits and channels.* policy both apply; stricter wins (policy/channelOps.js).
    const transportBlocked = (cfg) => providerBlocked(cfg.transport, limits(), deps.platformPolicy?.() ?? {});
    const bannedIn = (text) => {
        const word = blockedWordIn(limits(), text);
        return word ? `Your message uses "${word}", which is not allowed on this platform.` : null;
    };

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
    // Ops alerts (observability/alerts.js), tagged with this number. Never throws into the caller.
    const opsAlert = (alert) => {
        void Promise.resolve(deps.opsAlert?.({
            tenantId: state.channel?.tenantId ?? db.tenantId ?? null, channelId: state.channel?.id ?? null,
            number: state.channel?.providerAccountId || state.info?.account || null, ...alert,
        })).catch((err) => logger.warn('ops alert failed', { error: err.message }));
    };
    manager.opsAlert = opsAlert;
    // Bulk waits out the sending window / quiet hours instead of failing.
    // A super admin's skipQuietTime drops the quiet hours; the channel's own sending window stays.
    manager.bulkWindowOpen = () => bulkWindowOpen(state.channel,
        manager.quota.tables?.().skipQuiet ? { ...state.config, quietHoursStart: 0, quietHoursEnd: 0 } : state.config);
    manager.timezone = () => state.channel?.timezone;
    // Tracked links need an address the recipient's phone can reach; without one, text goes as written.
    if (deps.publicBaseUrl) manager.links = new LinkStore(db, deps.publicBaseUrl);
    const autoReply = new AutoReplyEngine(db, new NullTransport());
    // Phase 3: one way out. Everything that sends goes through the service,
    // which reads the live channel row so a capability switched off mid-flight
    // takes effect on the next job rather than the next restart.
    const messages = new MessageService(db, manager, () => state.channel, {
        isBotPaused: (phone, channelId) => conversations.isBotPaused(phone, channelId),
        // The admin's tenant controls and the plan's message quota refuse every new send (attachCampaignPolicy sets both).
        guard: (job) => manager.sendBlock?.(job.messageType) ?? manager.capBlock?.() ?? null,
    });
    // Contacts belong to the tenant, not to one number, but the store needs the
    // channel's country code to normalise what people type.
    const contacts = new ContactStore(db, config.defaultCountryCode);
    const templates = new TemplateStore(db);
    const conversations = new ConversationStore(db);
    const tickets = new TicketStore(db);
    const knowledge = new KnowledgeStore(db);
    const billing = new BillingStore(db, { overrides: () => deps.platformPolicy?.() ?? {} });
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
            const blocked = templates.sendBlock(found);
            if (blocked) throw new Error(blocked);
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
    autoReply.attach({
        contacts,
        conversations,
        channel: () => state.channel,
        media: (mediaId) => state.media?.get(mediaId) ?? null,
        businessName: () => state.tenancy?.getTenant(db.tenantId)?.name ?? '',
        platformPolicy: () => deps.platformPolicy?.() ?? {},
    });
    state.platformPolicy = () => deps.platformPolicy?.() ?? {};
    state.manager = manager;
    attachCampaignPolicy(state, deps); // bulk.* caps, opt-in, speed, window, kill switch
    // Interactive sends are remembered so a later "1" / button tap can be
    // matched back to the menu (messaging/replies.js).
    state.interactions = new InteractiveStore(db);
    manager.onSent = (item) => {
        // Auto-reply menus answer themselves (autoreply/engine.js handlePre).
        if (!item.interactive || item.messageType === 'auto_reply') return;
        state.interactions.recordSend({
            channelId: state.channel.id, recipient: item.recipient, campaignId: item.campaignId,
            messageId: item.messageId, interactive: item.interactive,
        });
    };
    state.autoReply = autoReply;
    state.messages = messages;
    state.contacts = contacts;
    state.templates = templates;
    templates.sendGate = (template) => reviewBlock(template, state.platformPolicy(), state.channel);
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
            warnings: { [TRANSPORT_BAILEYS]: TOS_WARNING },
        });
    });

    app.put('/config', async (req, res) => {
        // Anti-ban limits belong to the platform admin (PUT /api/admin/tenants/:id/safety).
        const body = { ...req.body };
        // Nor the server-set keys (ADMIN_CHANNEL_KEYS): linkedAt, humanTiming, requestTimeout.
        for (const key of [...POLICY_KEYS, ...ADMIN_CHANNEL_KEYS]) delete body[key];
        const merged = mergeConfig(state.config, body);
        const problems = validateConfig(merged);
        if (problems.length) return res.status(400).json({ errors: problems });
        const blocked = transportBlocked(merged);
        if (blocked) return res.status(403).json({ errors: [blocked] });
        if (merged.transport !== state.config.transport && state.transport) {
            // The sending rules follow config.transport: a live socket must not outlive a transport change.
            try {
                await state.transport.disconnect();
            } catch {
                // a failed teardown must not block the save
            }
            state.transport = null;
            state.info = null;
            state.qr = null;
            manager.setTransport(new NullTransport());
            autoReply.setTransport(new NullTransport());
            broadcast(state, { type: 'connection', connected: false });
        }
        state.config = state.save(merged);
        manager.applyConfig(state.config);
        contacts.defaultCountryCode = state.config.defaultCountryCode;
        return res.json({ config: publicConfig(state.config) });
    });

    // --------------------------------------------------------- connection --
    /** WhatsApp never says why it bans; this is the app's own evidence from the last 7 days. */
    const banText = (detail) => {
        const at = (ms) => new Date(Date.now() - ms).toISOString().replace(/.d{3}Z$/, '+00:00');
        const { reports, blocks } = manager.healthRates();
        const q = db.channelQuality(at(7 * 86_400_000), at(86_400_000));
        const done = q.sent7 + q.failed7;
        const parts = [`${reports} report${reports === 1 ? '' : 's'}`, `${blocks} likely block${blocks === 1 ? '' : 's'}`];
        if (done) parts.push(`${Math.round((q.failed7 / done) * 100)}% failed`);
        if (q.optOuts7) parts.push(`${q.optOuts7} opt-out${q.optOuts7 === 1 ? '' : 's'}`);
        return `${detail} In the last 7 days: ${parts.join(', ')}.`;
    };

    app.get('/connection', (req, res) => res.json(connectionState(state)));

    /**
     * Open the transport. A route and the boot/watchdog reconnect both call this,
     * so a restart brings back every connection a user had up.
     * Single-flight: a watchdog tick and a Connect click used to overlap across the
     * disconnect await, each opening a socket on the same login; the two kicked each
     * other off (440) forever. Overlapping callers now share one attempt.
     * @returns {Promise<{ status: number, body: object }>}
     */
    const connectChannel = () => (state.connectRun ??= openChannel().finally(() => { state.connectRun = null; }));
    const openChannel = async () => {
        if (state.connecting) {
            return { status: 200, body: connectionState(state) };
        }
        if (state.transport?.isConnected?.()) {
            return { status: 200, body: connectionState(state) };
        }
        const problems = validateConfig(state.config);
        if (problems.length) return { status: 400, body: { errors: problems } };
        const blocked = transportBlocked(state.config)
            ?? overCap(db, state.channel, limits(), deps.platformPolicy?.() ?? {});
        if (blocked) return { status: 403, body: { errors: [blocked] } };

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
            return { status: 400, body: { errors: [err.message] } };
        }
        // The WhatsApp Web transport talks back while it connects: QR codes,
        // loading progress, and the ACKs that become DELIVERED / READ.
        transport.events?.on('qr', async (qr) => {
            state.scanned = true; // the next 'ready' is a fresh link: the number rests before bulk
            state.qr = await toQrDataUrl(qr);
            // expiresAt: when this code stops working (the countdown); after QR_MAX_CODES unscanned, 'qr_expired'.
            broadcast(state, { type: 'qr', qr, image: state.qr, expiresAt: transport.qrExpiresAt ?? null });
        });
        transport.events?.on('state', (payload) => {
            if (['disconnected', 'error', 'reconnecting', 'reconnect_failed', 'auth_failure', 'banned', 'qr_expired'].includes(payload.state)) {
                state.info = {
                    connected: false,
                    account: state.info?.account ?? '',
                    detail: payload.detail ?? '',
                    error: payload.state === 'banned' ? banText(payload.detail)
                        : ['error', 'reconnect_failed', 'auth_failure', 'qr_expired'].includes(payload.state)
                            ? payload.detail ?? ''
                            : null,
                    code: payload.state === 'auth_failure' ? 'WHATSAPP_WEB_AUTH_FAILURE'
                        : (payload.state === 'banned' ? 'WHATSAPP_BANNED' : (payload.state === 'qr_expired' ? 'QR_EXPIRED' : null)),
                    realDelivery: Boolean(transport.realDelivery),
                };
                state.connecting = payload.state === 'reconnecting';
                state.qr = null;
                if (payload.state === 'banned') {
                    // A ban restarts the number's sending level (campaign/humanize.js levelFor). Keyed by the day:
                    // the 403 a restart or reconnect repeats is the same ban.
                    const phone = digitsOf(state.channel?.providerAccountId || state.info.account) || `channel-${state.channel?.id}`;
                    // What the number looked like just before (the history restarts with the ban), to see later which
                    // thresholds to tighten. Its own kind, so nothing that reads 'ban' rows changes.
                    if (manager.quota.qr) {
                        const al = manager.quota.allowance();
                        db.addSafetyEvent({
                            kind: 'ban_snapshot', phone, messageId: utcNow().slice(0, 10),
                            detail: JSON.stringify({
                                level: al.level.level, brakes: al.brakes.map((b) => b.code), budgets: al.budgets,
                                replies48h: al.replies, delivery: al.delivery, health: al.level.health, lastSentAt: al.lastSentAt,
                            }),
                        });
                    }
                    const fresh = db.addSafetyEvent({ kind: 'ban', phone, messageId: utcNow().slice(0, 10), detail: payload.detail ?? '' });
                    const hold = fresh ? db.tenantBanHold?.() : null;
                    if (hold) {
                        opsAlert({
                            kind: 'tenant_bans', text: 'A 2nd number of this business was banned within 30 days. Its numbers cannot level up for 14 days.',
                            detail: hold,
                        });
                    }
                    manager.quota.invalidate();
                    opsAlert({ kind: 'ban', text: 'WhatsApp banned this number.', detail: payload.detail ?? '' });
                }
                if (payload.state === 'auth_failure' || payload.state === 'banned') {
                    // Hold the rest QUEUED instead of failing each row on the NullTransport; relinking resumes it.
                    if (!manager.queue.isPaused && !manager.queue.isStopped) {
                        manager.pause();
                        manager.heldForLink = true;
                    }
                    manager.setTransport(new NullTransport());
                    autoReply.setTransport(new NullTransport());
                }
                broadcast(state, { type: 'connection', ...connectionState(state) });
            }
            broadcast(state, { type: 'transportState', ...payload });
        });
        transport.events?.on('ready', (info) => {
            // Remember which number scanned in, so linking a different one resets the sending level and inbox.
            if (info?.account) {
                const before = state.channel?.numberSince;
                state.channel = linked(info.account);
                if (state.scanned || state.channel.numberSince !== before) {
                    // A fresh QR link: bulk rests first (unless the number's history says it is an old one).
                    state.scanned = false;
                    const { linkedAt } = state.save({ linkedAt: utcNow() });
                    state.config = { ...state.config, linkedAt };
                    manager.applyConfig(state.config);
                    broadcast(state, { type: 'changed', topic: 'config' });
                }
            }
            state.info = info;
            state.qr = null;
            state.connecting = false;
            manager.setTransport(transport);
            autoReply.setTransport(transport);
            manager.start();
            resumeHeld();
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
        // WhatsApp capped messages to strangers (463 / 475, or a reach-out timelock): new chats and lookups
        // wait until `until` (the restricted brake). The end is the event's message_id.
        // shortcut: kept in memory only; the questions are asked right after a link, so a restart before then loses the hint.
        transport.events?.on('history', ({ chats } = {}) => {
            state.historyChats = chats;
        });
        transport.events?.on('restricted', ({ code, until } = {}) => {
            const end = new Date(until);
            db.addSafetyEvent({
                kind: 'restrict', phone: digitsOf(state.channel?.providerAccountId || state.info?.account) || `channel-${state.channel?.id}`,
                messageId: (Number.isNaN(end.getTime()) ? new Date(Date.now() + 86_400_000) : end).toISOString(), detail: String(code ?? ''),
            });
            manager.quota.invalidate();
            broadcast(state, { type: 'safetyEvent', kind: 'restrict' });
        });
        // Over 8 socket drops in an hour (this process): the 8h `unstable` pause (shadow-logged until enforced;
        // recordBrake raises the ops alert).
        transport.events?.on('unstable', ({ reconnects } = {}) => {
            manager.recordBrake('unstable', `The connection dropped ${reconnects} times in the last hour. Bulk and new chats wait 8 hours.`);
        });
        // The device was unlinked from the phone or WhatsApp ended the session, not a logout from here.
        transport.events?.on('logged_out', ({ detail } = {}) => {
            opsAlert({ kind: 'logout', text: 'The number was logged out unexpectedly.', detail: detail ?? '' });
        });
        transport.events?.on('inbound', (message) => {
            void handleInbound(state, message);
        });
        // Only people in the contact list get a read receipt, not every stranger who writes in.
        transport.shouldRead = (phone) => Boolean(contacts.getByPhone(contacts.normalize(phone)));

        state.connecting = true;
        state.transport = transport;
        try {
            state.info = await transport.connect();
        } catch (err) {
            state.connecting = false;
            state.transport = transport;
            const banned = transport.banned; // the 'banned' state event fired first; keep its evidence text
            state.info = {
                connected: false,
                account: '',
                detail: err.message,
                error: banned ? banText(BAN_TEXT) : err.message,
                code: banned ? 'WHATSAPP_BANNED' : (err.code ?? null),
                realDelivery: Boolean(transport.realDelivery),
            };
            state.qr = null;
            const status = err.code === 'WHATSAPP_WEB_PROFILE_LOCKED'
                ? 409
                : (err instanceof TransportError ? 502 : 500);
            broadcast(state, { type: 'connection', ...connectionState(state) });
            return { status: status, body: { errors: [err.message] } };
        }

        if (state.info?.connected) {
            state.connecting = false;
            state.qr = null;
            manager.setTransport(transport);
            autoReply.setTransport(transport);
            manager.start();
            resumeHeld();
        } else if (state.info?.qr) {
            state.qr = await toQrDataUrl(state.info.qr);
        }

        broadcast(state, { type: 'connection', ...connectionState(state) });
        return { status: 200, body: connectionState(state) };
    };
    state.connect = connectChannel;
    // Only the hold a ban / logged-out session put on; an operator's pause since then (it clears the flag) stays.
    const resumeHeld = () => {
        if (manager.heldForLink) manager.resume();
    };

    app.post('/connection/connect', async (req, res) => {
        const result = await connectChannel();
        // Remember that this number should stay up: restarts and the watchdog honour it.
        if (result.status < 400) setWanted(true);
        return res.status(result.status).json(result.body);
    });

    /** The user's intent, stored with the channel so it survives a restart. */
    const setWanted = (wanted) => {
        if (Boolean(state.config.autoConnect) === wanted) return;
        state.config = state.save({ ...state.config, autoConnect: wanted });
    };

    /**
     * A manual disconnect logs the number out: the linked device is removed and
     * the saved QR session deleted, so the next Connect shows a fresh QR code.
     * The session is deleted even when no transport is running (after a restart),
     * or Connect would quietly log back in with the old one.
     */
    const logout = async (req, res) => {
        setWanted(false);
        state.connecting = false;
        try {
            if (state.transport?.logout) await state.transport.logout();
            else await state.transport?.disconnect?.();
        } catch {
            // a failed teardown must not block the UI
        }
        if (deps.sessionDir) fs.rmSync(path.join(deps.sessionDir, 'baileys'), { recursive: true, force: true });
        state.transport = null;
        state.info = null;
        state.qr = null;
        manager.setTransport(new NullTransport());
        autoReply.setTransport(new NullTransport());
        broadcast(state, { type: 'connection', connected: false, qr: null });
        res.json(connectionState(state));
    };
    app.post('/connection/disconnect', logout);
    app.post('/connection/logout', logout);

    // ----------------------------------------------------------- messages --
    app.post('/messages', async (req, res) => {
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
        const levels = manager.quota.qr && state.config.safetyEnabled && state.transport?.realDelivery;
        if (levels) {
            // A QR number: only a message to someone it never talked to waits on a budget (new chats);
            // the queue would hold it anyway, so say so now. Its lookup is the queue's too (budgeted there).
            const { newChats } = manager.quota.allowance().budgets;
            if (newChats.left <= 0 && db.isCold(normalized)) {
                const when = new Intl.DateTimeFormat('en-GB', {
                    ...(state.channel?.timezone ? { timeZone: state.channel.timezone } : {}), dateStyle: 'medium', timeStyle: 'short',
                }).format(new Date(newChats.opensAt));
                return res.status(429).json({
                    errors: [`This number has no new chats left today, and ${normalized} has never chatted with it. `
                        + `Messages to new people open again on ${when}. People who wrote to you still get your messages.`],
                    reason: 'new_chats',
                    opensAt: newChats.opensAt,
                    safety: manager.safetyStatus(),
                });
            }
        } else if (state.config.safetyEnabled && state.transport?.realDelivery
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
        let interactive;
        try {
            interactive = personalizeInteractive(normalizeInteractive(req.body?.interactive), { name, phone: normalized });
        } catch (err) {
            if (err instanceof InteractiveError) return res.status(400).json({ errors: [err.message] });
            throw err;
        }
        // Said up front, not as a failed row later; an unknown answer sends as before. A QR number answers
        // only from an earlier lookup: a fresh one here would skip the gap and the new-chat budget (manager #notOnWhatsapp).
        const registered = levels ? manager.knownRegistered(normalized) : (await manager.checkRegistered([normalized])).get(normalized);
        if (registered === false) {
            return res.status(422).json({ errors: [NOT_ON_WHATSAPP_TEXT], reason: 'not_on_whatsapp' });
        }

        let outcome;
        try {
            outcome = messages.send({
                messageType: 'transactional',
                recipient: normalized,
                text: body,
                name,
                media,
                interactive,
                // A caller retrying a timed-out POST sends the same key and
                // gets the original message id back, not a second message.
                // Without one, every send is its own: the content-derived key
                // would refuse the same text to the same number forever.
                idempotencyKey: req.get('idempotency-key') || uniqueKey('single'),
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
    app.post('/contacts/import', upload.single('file'), checkImport, async (req, res) => {
        if (!req.file) return res.status(400).json({ errors: ['no file uploaded'] });
        try {
            // An explicit column mapping comes from the contacts import wizard;
            // without one, the header-guessing importer runs exactly as before.
            const mapping = req.body?.mapping ?? req.query.mapping;
            let result;
            if (mapping !== undefined && mapping !== '') {
                const table = await parseTable(req.file.originalname, req.file.buffer);
                let targets;
                try {
                    targets = resolveMapping(table.headers, mapping);
                } catch (err) {
                    return res.status(400).json({ errors: [err.message] });
                }
                result = mappedRowsToContacts(table.rows, targets, state.config.defaultCountryCode);
            } else {
                result = await importContacts(
                    req.file.originalname, req.file.buffer, state.config.defaultCountryCode);
            }
            // Campaign preview just wants the parsed rows, so saving is opt-in
            // and the existing contract is unchanged.
            if (req.query.save === 'true' || req.body?.save === 'true') {
                const tags = String(req.query.tags ?? req.body?.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
                // importContacts already normalised every number.
                result.saved = contacts.importMany(result.contacts, { source: 'import', tags, normalized: true });
            }
            return res.json(result);
        } catch (err) {
            return res.status(400).json({ errors: [`Import failed: ${err.message}`] });
        }
    });

    // Contacts import wizard, step 1: what is in the file and how we would map it.
    // Stateless: the wizard sends the file again with its mapping to commit.
    app.post('/contacts/import/preview', upload.single('file'), checkImport, async (req, res) => {
        if (!req.file) return res.status(400).json({ errors: ['no file uploaded'] });
        let table;
        try {
            table = await parseTable(req.file.originalname, req.file.buffer);
        } catch (err) {
            return res.status(400).json({ errors: [`Import failed: ${err.message}`] });
        }
        if (!table.headers.length) return res.status(400).json({ errors: ['the file has no header row'] });
        return res.json({
            filename: req.file.originalname,
            headers: table.headers,
            rows: table.rows.slice(0, PREVIEW_ROWS),
            rowCount: table.rows.length,
            mapping: suggestMapping(table.headers),
            fieldKeys: contacts.fieldKeys(),
            quality: columnQuality(table.headers, table.rows, state.config.defaultCountryCode),
        });
    });

    // ------------------------------------------------ campaign import wizard --
    const BAD_CC = 'default country code must be 1-4 digits';
    const ccProblem = (value) => value !== undefined && value !== null && String(value).trim() !== ''
        && !cleanCountryCode(value);

    /** Opens an import session for a parsed sheet and returns what the wizard shows. */
    const sheetPreview = (sheet, filename) => {
        const importId = `imp_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        state.imports.set(importId, { sheet, createdAt: Date.now() });
        // Map keeps insertion order, so the first key is the oldest session.
        while (state.imports.size > 8) state.imports.delete(state.imports.keys().next().value);
        return {
            importId,
            filename,
            headers: sheet.headers,
            columns: sheet.columns,
            rows: sheet.rows,
            total: sheet.total,
            truncated: sheet.truncated,
            guess: guessMapping(sheet.columns, sheet.rows),
        };
    };
    state.sheetPreview = sheetPreview; // storage/routes.js re-opens a stored sheet the same way

    app.post('/campaign/import/preview', upload.single('file'), checkImport, async (req, res) => {
        if (!req.file) return res.status(400).json({ errors: ['no file uploaded'] });
        if (ccProblem(req.body?.countryCode)) return res.status(400).json({ errors: [BAD_CC] });
        let sheet;
        try {
            sheet = await parseSheet(req.file.originalname, req.file.buffer);
        } catch (err) {
            return res.status(400).json({ errors: [`Import failed: ${err.message}`] });
        }
        if (!sheet.headers.length || !sheet.rows.length) {
            return res.status(400).json({ errors: ['the file has no header row or no data rows'] });
        }
        // After validation, so a rejected file is never stored. A repeat is parsed
        // again: the wizard needs a fresh importId, not a second copy on disk.
        let saved;
        try {
            saved = state.storage.saveSheet(req.file, sheet.total);
        } catch (err) {
            if (err instanceof StorageError) return res.status(err.status).json({ errors: [err.message] });
            throw err;
        }
        const { row, duplicate } = saved;
        return res.json({
            ...sheetPreview(sheet, req.file.originalname),
            ...uploadInfo(row, duplicate),
        });
    });

    app.post('/campaign/import/audit', (req, res) => {
        const { importId, mapping, countryCode, autoClean } = req.body ?? {};
        const session = state.imports.get(importId);
        if (!session) return res.status(404).json({ errors: ['import not found - upload the file again'] });
        if (ccProblem(countryCode)) return res.status(400).json({ errors: [BAD_CC] });
        const dedupeDays = Math.max(0, Number(req.body?.dedupeDays) || 0);
        const since = new Date(Date.now() - dedupeDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
        const recent = dedupeDays > 0 ? new Set(db.bulkCountsSince(since).keys()) : new Set();
        try {
            const { contacts: valid, issues, counts } = auditRows(session.sheet.rows, session.sheet.columns, mapping, {
                countryCode: countryCode ?? '',
                autoClean: Boolean(autoClean),
                optOuts: new Set(db.getAllOptOuts()),
                recent,
                skipDuplicates: req.body?.skipDuplicates !== false,
            });
            // Every valid number in the sheet goes into the contact book (upsert: re-uploading
            // the same file updates, never duplicates).
            const saved = contacts.importMany(valid, { source: 'import', normalized: true });
            return res.json({ counts, issues, saved: { created: saved.created, updated: saved.updated },
                valid: valid.map(({ row, phone, name }) => ({ row, phone, name })) });
        } catch (err) {
            if (err instanceof RangeError) return res.status(400).json({ errors: [err.message] });
            throw err;
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
            contacts: contacts.find(filter, {
                limit: req.query.limit, offset: req.query.offset, sort: req.query.sort, dir: req.query.dir,
            }),
            total: contacts.count(filter),
            tags: contacts.tags(),
            fieldKeys: contacts.fieldKeys(),
        });
    });

    // Static paths below must stay above `/contacts/:id`, or ':id' swallows them.
    /** CSV of the given ids, or of everything matching the filter. */
    app.get('/contacts/export', (req, res) => {
        const ids = String(req.query.ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
        // `ids` present means "exactly these", even when none of them parse.
        const list = req.query.ids !== undefined
            ? ids.slice(0, MAX_BULK).map((id) => contacts.get(id)).filter(Boolean)
            : contacts.find(filterFromQuery(req.query), { limit: 5000, sort: req.query.sort, dir: req.query.dir });
        const stamp = new Date().toISOString().slice(0, 10);
        res.set('content-type', 'text/csv; charset=utf-8');
        res.set('content-disposition', `attachment; filename="contacts-${stamp}.csv"`);
        res.set('cache-control', 'no-store');
        return res.send(contactsToCsv(list));
    });

    // ------------------------------------------------- WhatsApp groups --
    // The members of the groups and communities the linked QR number is in.
    // Only Baileys can read them; the sandbox has no groups.
    const GROUPS_TTL_MS = 60_000;
    /** The groups, fetched at most once a minute per connection: listing then exporting is one call to WhatsApp. */
    const whatsappGroups = async () => {
        const transport = state.transport;
        if (!transport?.isConnected?.() || !transport.supportsGroups) return null;
        const cached = state.groupsCache;
        if (cached?.transport === transport && Date.now() - cached.at < GROUPS_TTL_MS) return cached.groups;
        const groups = await transport.listGroups();
        state.groupsCache = { transport, at: Date.now(), groups };
        return groups;
    };
    const notLinked = (res) => res.status(409).json({ errors: ['Connect a WhatsApp QR number first.'] });
    /** `all`, or ids picked from the listing; [] when nothing was picked. */
    const pickGroups = (groups, ids, all) => {
        if (all || ids === 'all') return groups;
        const wanted = new Set((Array.isArray(ids) ? ids : String(ids ?? '').split(',')).map((id) => String(id).trim()).filter(Boolean));
        return groups.filter((g) => wanted.has(g.id));
    };
    const communityName = (groups, g) => (g.community ? groups.find((c) => c.id === g.community)?.name ?? '' : '');

    app.get('/contacts/whatsapp-groups', async (req, res) => {
        const groups = await whatsappGroups();
        if (!groups) return notLinked(res);
        // Counts only: the numbers themselves leave through export/import.
        return res.json({
            groups: groups.map((g) => ({
                id: g.id, name: g.name, size: g.size, isCommunity: g.isCommunity,
                community: g.community, communityName: communityName(groups, g),
                members: g.members.length, hidden: g.hidden,
            })),
        });
    });

    app.get('/contacts/whatsapp-groups/export', async (req, res) => {
        const groups = await whatsappGroups();
        if (!groups) return notLinked(res);
        const picked = pickGroups(groups, req.query.ids);
        if (!picked.length) return res.status(400).json({ errors: ['Pick at least one group.'] });
        const lines = [['phone', 'name', 'group', 'community', 'admin'].map(csvCell).join(',')];
        // WhatsApp gives no member names; a number already in contacts brings its own.
        const nameOf = (phone) => {
            try {
                return contacts.getByPhone(contacts.normalize(phone, true))?.name ?? '';
            } catch {
                return '';
            }
        };
        for (const g of picked) {
            const community = communityName(groups, g);
            for (const m of g.members) {
                lines.push([m.phone, nameOf(m.phone), g.name, community, m.admin ? 'yes' : 'no'].map(csvCell).join(','));
            }
        }
        const stamp = new Date().toISOString().slice(0, 10);
        res.set('content-type', 'text/csv; charset=utf-8');
        res.set('content-disposition', `attachment; filename="whatsapp-groups-${stamp}.csv"`);
        res.set('cache-control', 'no-store');
        // BOM so Excel opens UTF-8 names correctly, as contactsToCsv does.
        return res.send(`﻿${lines.join('\r\n')}\r\n`);
    });

    app.post('/contacts/whatsapp-groups/import', async (req, res) => {
        const groups = await whatsappGroups();
        if (!groups) return notLinked(res);
        const picked = pickGroups(groups, req.body?.ids, req.body?.all === true);
        if (!picked.length) return res.status(400).json({ errors: ['Pick at least one group.'] });
        // One row per number, tagged with every picked group it is in.
        const rows = new Map();
        for (const g of picked) {
            for (const m of g.members) {
                const row = rows.get(m.phone) ?? { phone: m.phone, tags: [] };
                if (g.name && !row.tags.includes(g.name)) row.tags.push(g.name);
                rows.set(m.phone, row);
            }
        }
        // WhatsApp numbers are already international digits.
        const saved = contacts.importMany([...rows.values()], { source: 'whatsapp_group', normalized: true });
        return res.json({
            created: saved.created, updated: saved.updated, failed: saved.failed.length,
            hidden: picked.reduce((n, g) => n + g.hidden, 0),
        });
    });

    app.get('/contacts/duplicates', (req, res) => res.json(contacts.duplicates({ limit: req.query.limit })));

    app.post('/contacts/merge', (req, res) => {
        try {
            const { keepId, mergeIds } = req.body ?? {};
            if (!Number.isInteger(Number(keepId)) || Number(keepId) < 1) {
                return res.status(400).json({ errors: ['keepId must be a contact id'] });
            }
            return res.json(contacts.merge(Number(keepId), mergeIds));
        } catch (err) {
            return contactFail(res, err);
        }
    });

    /** One action over many contacts: `ids`, or a `filter` meaning every match. */
    app.post('/contacts/bulk', (req, res) => {
        try {
            const { ids, filter, action, tags, reason } = req.body ?? {};
            if (reason !== undefined && typeof reason !== 'string') {
                return res.status(400).json({ errors: ['reason must be text'] });
            }
            if (tags !== undefined && !Array.isArray(tags)) {
                return res.status(400).json({ errors: ['tags must be a list'] });
            }
            let list = ids;
            if (list === undefined && filter && typeof filter === 'object' && !Array.isArray(filter)) {
                list = contacts.idsFor(filter);
                if (!list.length && BULK_ACTIONS.includes(action)) return res.json({ action, affected: 0, missing: [] });
            }
            if (!Array.isArray(list)) return res.status(400).json({ errors: ['ids must be a list of contact ids'] });
            return res.json(contacts.bulk(list, action, { tags, reason }));
        } catch (err) {
            return contactFail(res, err);
        }
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

    /** Opt out or back in: writes `opt_outs` and `opt_in_status` together. */
    app.post('/contacts/:id/consent', (req, res) => {
        const { optedOut, reason } = req.body ?? {};
        if (typeof optedOut !== 'boolean') return res.status(400).json({ errors: ['optedOut must be true or false'] });
        if (reason !== undefined && typeof reason !== 'string') return res.status(400).json({ errors: ['reason must be text'] });
        try {
            return res.json({ contact: contacts.setOptOut(req.params.id, optedOut, reason) });
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
        templates: templates.list({ type: req.query.type, channelId: req.query.channel, category: req.query.category }),
    }));

    // A header media id must name an upload we can actually attach; one that
    // was already on the template is left alone so an unrelated edit still saves.
    const templateMediaMissing = (body, current = null) => {
        const id = body?.headerMediaId;
        return Boolean(id) && id !== current?.headerMediaId && !state.media.get(id);
    };

    // Platform template rules (templates/policy.js). Legacy limits.maxTemplates and
    // templates.maxTemplates both apply: the lower cap wins.
    const templateCapError = () => {
        const cap = stricterCap(limits().maxTemplates, state.platformPolicy()['templates.maxTemplates']);
        return cap && templates.list().length >= cap
            ? `Your plan allows ${cap} templates. Delete one or ask the platform admin to raise it.` : null;
    };
    const templateRuleFail = (res, draft) => {
        const problem = templateRuleProblem(draft, {
            policy: state.platformPolicy(), limits: limits(), media: (id) => state.media.get(id),
        });
        return problem ? res.status(400).json({ errors: [problem.message], rule: problem.rule }) : null;
    };
    // New or reworded templates go (back) to the review queue when the policy asks for one.
    const queueForReview = (template) => (needsReview(state.platformPolicy(), template)
        ? templates.setReview(template.id, 'pending') : template);

    app.post('/templates', (req, res) => {
        const capError = templateCapError();
        if (capError) return res.status(403).json({ errors: [capError], rule: 'maxTemplates' });
        if (templateRuleFail(res, req.body ?? {})) return undefined;
        if (templateMediaMissing(req.body)) return res.status(400).json({ errors: ['header media not found - upload it again'] });
        // The store saves half-written drafts on purpose; the API is the gate.
        const problems = validateTemplate(req.body ?? {});
        if (problems.length && req.query.draft !== 'true') return res.status(400).json({ errors: problems });
        try {
            return res.status(201).json({ template: queueForReview(templates.create(req.body ?? {})), warnings: problems });
        } catch (err) {
            return templateFail(res, err);
        }
    });

    /** Live spam score for the editor, with the limit it is judged against. */
    app.post('/templates/spam-score', (req, res) => res.json({
        ...spamScore(req.body ?? {}), limit: state.platformPolicy()['templates.maxSpamScore'] ?? 100,
    }));

    // Starter library (templates/library.js): read-only here, curated by super admins.
    app.get('/templates/library', (req, res) => res.json({ starters: listLibrary(db.db) }));

    app.post('/templates/library/:entryId/copy', (req, res) => {
        try {
            const entry = getLibraryEntry(db.db, req.params.entryId);
            const draft = { name: String(req.body?.name ?? '').trim() || entry.name, body: entry.body, category: entry.category };
            const capError = templateCapError();
            if (capError) return res.status(403).json({ errors: [capError], rule: 'maxTemplates' });
            if (templateRuleFail(res, draft)) return undefined;
            return res.status(201).json({ template: queueForReview(templates.create(draft)) });
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
        const current = templates.get(req.params.id);
        if (templateRuleFail(res, { ...current, ...req.body })) return undefined;
        if (templateMediaMissing(req.body, current)) return res.status(400).json({ errors: ['header media not found - upload it again'] });
        // Variables follow the body unless the caller sends them: an edit that adds a
        // placeholder must not be checked against the old declared list.
        const problems = validateTemplate({ ...current, ...req.body, variables: req.body?.variables });
        if (problems.length && req.query.draft !== 'true') return res.status(400).json({ errors: problems });
        try {
            const updated = templates.update(req.params.id, req.body ?? {});
            const changed = ['body', 'interactive', 'headerMediaId', 'templateType']
                .some((key) => JSON.stringify(updated[key]) !== JSON.stringify(current?.[key]));
            return res.json({ template: changed ? queueForReview(updated) : updated });
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
    app.post('/payment-reminders/import', upload.single('file'), checkImport, async (req, res) => {
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

        const result = manager.enqueueContacts(contacts, '{final_message}', { onePerNumber: true, reset: {} });
        manager.start();
        return res.json(result);
    });

    // -------------------------------------------------------------- media --
    app.post('/media/upload', mediaUpload.single('file'), async (req, res) => {
        if (!req.file) return res.status(400).json({ errors: ['no file uploaded'] });
        const badContent = mediaContentError(req.file);
        if (badContent) return res.status(400).json({ errors: [badContent] });
        // Policy templates.maxMediaMb vs legacy limits.maxMediaMb: the lower wins.
        const maxMb = stricterCap(state.platformPolicy()['templates.maxMediaMb'], limits().maxMediaMb);
        if (maxMb && req.file.size > maxMb * 1024 * 1024) {
            return res.status(413).json({ errors: [`Files can be up to ${maxMb} MB on your plan.`] });
        }
        if (!ALLOWED_MEDIA_TYPES.has(req.file.mimetype)) {
            return res.status(400).json({ errors: [`unsupported media type: ${req.file.mimetype}`] });
        }
        if (!req.file.mimetype.startsWith('video/') && req.file.size > MAX_MEDIA_BYTES) {
            return res.status(413).json({ errors: ['Images and documents can be up to 16 MB (videos up to 64 MB).'] });
        }
        // After validation, so a rejected file is never stored. The same bytes
        // again hand back the earlier upload instead of writing another copy.
        const sha256 = sha256Of(req.file.buffer);
        const reused = state.storage.reuseMedia(sha256);
        if (reused) {
            return res.status(200).json({ ...mediaMetadata(reused.media), ...uploadInfo(reused.row, true) });
        }
        let release;
        try {
            release = state.storage.reserve(req.file.size); // the plan's storage quota, held until the row is in
        } catch (err) {
            if (err instanceof StorageError) return res.status(err.status).json({ errors: [err.message] });
            throw err;
        }
        const mediaId = `med_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        const filename = safeName(req.file.originalname);
        const storedName = `${mediaId}_${filename}`;
        const filePath = path.join(UPLOAD_DIR, storedName);
        let stored;
        try {
            await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
            await fs.promises.writeFile(filePath, req.file.buffer);
            state.media.claim(mediaId);
            stored = state.storage.add({
                kind: 'media', sha256, name: filename, mimetype: req.file.mimetype, size: req.file.size, storedName, mediaId,
            });
        } catch (err) {
            return res.status(500).json({ errors: [`Media upload failed: ${err.message}`] });
        } finally {
            release();
        }
        // An identical upload finished while this one was writing: keep theirs, drop ours.
        const winner = !stored.created && stored.row.kind === 'media' ? state.storage.reuseMedia(sha256) : null;
        if (winner) {
            await fs.promises.rm(filePath, { force: true });
            fs.rmSync(path.join(UPLOAD_DIR, `${mediaId}.tenant`), { force: true });
            return res.status(200).json({ ...mediaMetadata(winner.media), ...uploadInfo(winner.row, true) });
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
        return res.status(201).json({ ...mediaMetadata(media), ...uploadInfo(stored.row, false) });
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
        const ownText = (c) => String(c?.extra?.message ?? c?.extra?.custom_message ?? '').trim();
        if (!template
            && !(Array.isArray(audience) && audience.length && audience.every(ownText))) {
            return res.status(400).json({ errors: ['message is required'] });
        }

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
        const cap = limits().maxContactsPerCampaign;
        if (cap && list.length > cap) {
            return res.status(403).json({ errors: [`A campaign can reach ${cap} contacts on your plan; this one has ${list.length}.`] });
        }
        const banned = bannedIn([template, ...list.map(ownText)].join(' '));
        if (banned) return res.status(400).json({ errors: [banned] });
        let interactive;
        let replyRules;
        try {
            interactive = normalizeInteractive(req.body?.interactive);
            replyRules = normalizeReplyRules(req.body?.replyRules);
        } catch (err) {
            if (err instanceof InteractiveError) return res.status(400).json({ errors: [err.message] });
            throw err;
        }
        if (!state.transport?.isConnected?.()) {
            return res.status(409).json({ errors: ['Connect a transport first.'] });
        }
        const media = mediaId ? state.media.get(mediaId) : null;
        if (mediaId && !media) return res.status(404).json({ errors: ['media not found'] });
        // `reset` lands after enqueueContacts' own refusals: a refused start keeps whatever is queued.
        const result = manager.enqueueContacts(list, template, {
            reset: {}, onePerNumber, media, interactive,
            // Bulk Campaigns v2: per-variable fallback text and the speed preset.
            fallbacks: req.body?.fallbacks ?? null, pacing: req.body?.pacing ?? 'balanced',
        });
        // Reply rules are keyed by the id the manager just generated.
        if (replyRules.length) state.interactions.setRules(result.campaignId, replyRules);
        manager.start();
        return res.json({ ...result, segmentId, audience: list.length, replyRules });
    });

    /** Bulk Campaigns v2: change the live run's speed preset (safe / balanced / fast). */
    app.post('/campaign/speed', (req, res) => {
        const pacing = req.body?.pacing;
        if (!PACING_PRESETS.includes(pacing)) {
            return res.status(400).json({ errors: [`pacing must be one of ${PACING_PRESETS.join(', ')}`] });
        }
        manager.setPace(pacing);
        return res.json({ stats: manager.statsSnapshot() });
    });

    app.post('/campaign/:action', (req, res) => {
        const { action } = req.params;
        if (!['pause', 'resume', 'stop'].includes(action)) {
            return res.status(404).json({ errors: [`unknown action: ${action}`] });
        }
        // The run belongs to a saved campaign ('camp-7'): act through its record, so the
        // Campaigns page shows the same paused / running / cancelled state as the engine.
        const id = Number(String(manager.campaignId ?? '').replace(/^camp-/, ''));
        const record = Number.isInteger(id) && id > 0 ? state.campaigns?.get(id) : null;
        if (record && ['running', 'paused'].includes(record.status)) {
            const store = state.campaigns;
            try {
                if (action === 'stop') store.cancel(id);
                else if (action === 'pause' && record.status === 'running') store.pause(id);
                else if (action === 'resume' && record.status === 'paused') store.resume(id);
                else manager[action]();
            } catch (err) {
                if (!err.status) throw err;
                return res.status(err.status).json({ errors: [err.message], stats: manager.statsSnapshot() });
            }
            return res.json({ stats: manager.statsSnapshot() });
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

    /** Today's limit and rest window, and the block / report rate with who and when. */
    app.get('/safety/health', (req, res) => {
        const health = manager.healthStatus();
        const safety = manager.safetyStatus();
        return res.json({ health, safety, causes: banCauses(health, safety) });
    });

    /** What gets numbers banned, each against its line: bad at or above it, warn from half of it. */
    const banCauses = (health, safety) => {
        const p = deps.platformPolicy?.() ?? {};
        const at = (ms) => new Date(Date.now() - ms).toISOString().replace(/.d{3}Z$/, '+00:00');
        const q = db.channelQuality(at(7 * 86_400_000), at(86_400_000));
        const level = (value, limit) => (!limit ? 'ok' : value >= limit ? 'bad' : value >= limit / 2 ? 'warn' : 'ok');
        const reportLimit = p['channels.banGuardReports'] ?? 0;
        const sent24 = q.sent24 + q.failed24;
        const failPct = sent24 ? Math.round((q.failed24 / sent24) * 100) : 0;
        const optOutPct = q.sent7 ? Math.round((q.optOuts7 / q.sent7) * 1000) / 10 : 0;
        const optIn = Boolean(manager.bulkPolicy?.().requireOptIn);
        // A QR number's level also watches messages to strangers and the reply rate (campaign/humanize.js levelFor).
        const levels = [];
        if (safety.budgets) {
            const { newChats } = safety.budgets;
            const { reached, replied } = manager.quota.allowance().replies;
            const replyPct = reached ? Math.round((replied / reached) * 1000) / 10 : 0;
            levels.push(
                { key: 'newchats', label: 'New chats today', level: level(newChats.used, newChats.limit),
                  value: `${newChats.used} of ${newChats.limit}`,
                  hint: 'People who never chatted with this number. WhatsApp watches messages to strangers most closely.' },
                { key: 'replies', label: 'Replies (48h)',
                  level: reached < 40 ? 'ok' : replyPct < 15 ? 'bad' : replyPct < 30 ? 'warn' : 'ok',
                  value: `${replied} of ${reached} people replied (${replyPct}%)`,
                  hint: 'Below 15% once 40 or more people were reached halves bulk sending. Replies show WhatsApp the messages are wanted.' },
            );
        }
        return [
            { key: 'reports', label: 'Spam reports', level: level(health.reports, reportLimit),
              value: reportLimit ? `${health.reports} of ${reportLimit} this week` : `${health.reports} this week`,
              hint: 'People who replied that your message was spam. Reaching the limit pauses the number.' },
            { key: 'blocks', label: 'Likely blocks', level: level(health.blockRatePercent, health.pauseAtPercent),
              value: `${health.blocks} this week (${health.blockRatePercent}% of sent)`,
              hint: 'Messages that stayed on one tick for a day. Blocks and reports together pause a running campaign.' },
            { key: 'optouts', label: 'Opt-outs', level: level(optOutPct, OPT_OUT_WARN_PERCENT),
              value: `${q.optOuts7} this week (${optOutPct}% of sent)`,
              hint: 'People who asked to stop. Many opt-outs mean the list is not wanted.' },
            { key: 'failed', label: 'Failed sends (24h)',
              level: sent24 < (p['channels.banGuardMinSample'] ?? 0) ? 'ok' : level(failPct, p['channels.banGuardFailurePct'] ?? 0),
              value: `${q.failed24} of ${sent24} (${failPct}%)`,
              hint: 'Many failures to numbers that are not on WhatsApp look like guessing numbers.' },
            { key: 'volume', label: 'Sent today', level: level(safety.used, safety.limit),
              value: safety.limit ? `${safety.used} of ${safety.limit}` : `${safety.used}`,
              hint: 'Sending more than the daily limit is a common reason for a ban.' },
            { key: 'optin', label: 'Opt-in required', level: optIn ? 'ok' : 'warn', value: optIn ? 'On' : 'Off',
              hint: 'Messaging only people who agreed to hear from you is the best protection.' },
            ...levels,
        ];
    };

    app.get('/campaign/stats', (req, res) => res.json({ stats: manager.statsSnapshot() }));

    /** Who goes out next, in the worker's own order (the progress card's "up next"). */
    app.get('/campaign/queue', (req, res) => res.json({
        next: manager.upNext(Math.min(20, Math.max(1, Number(req.query.limit) || 5))),
        pending: manager.queue.pending,
    }));

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

    // Auto-replies: autoreply/routes.js (mounted with FEATURE_ROUTERS).

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
        const preset = PACING_PRESETS.includes(req.query.pacing) ? req.query.pacing : undefined;
        res.json({ safety: manager.safetyStatus(batch, preset) });
    });

    // ------------------------------------------------------------ history --
    app.get('/history', (req, res) => {
        const status = req.query.status && req.query.status !== 'ALL' ? req.query.status : null;
        const recipient = req.query.recipient || null;
        const sig = db.historySignature({ status, recipient });
        const signature = `${sig.count}:${sig.last}:${sig.mix}`;
        // The browser sends back the signature it already has: same answer
        // means no rows are shipped at all.
        if (req.query.signature === signature) {
            return res.status(204).end();
        }
        return res.json({
            // Rows written before errors were made readable still hold raw text.
            records: db.history({ limit: Number(req.query.limit) || 1000, status, recipient })
                .map((r) => (r.error ? { ...r, error: friendlyError(r.error) } : r)),
            counts: db.countsByStatus(),
            signature,
        });
    });

    // ---------------------------------------------------------------- SSE --
    app.get('/events', (req, res) => {
        // No idle timeout and TCP keep-alive: the stream is meant to sit quiet for minutes.
        req.socket.setTimeout(0);
        req.socket.setKeepAlive(true, 30000);
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
 * Move the tenant's root login folder (`root`, shared by the default number before each number had its
 * own) into the default number's folder, once. Returns the folder to use: `own`, or `root` when the move
 * failed, so the number keeps its login rather than asking for a new QR scan.
 */
export function adoptRootSession(root, own) {
    if (!root || root === own || fs.existsSync(own) || !fs.existsSync(root)) return own;
    try {
        fs.mkdirSync(path.dirname(own), { recursive: true });
        fs.renameSync(root, own);
        logger.info('moved the default number login into its own folder', { to: own });
        return own;
    } catch (err) {
        logger.warn('could not move the default number login folder; using the shared one', { error: err.message });
        return root;
    }
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
    // existing single-number install comes up already configured. A QR number
    // gets the platform's starting values, as POST /channels gives one. The file's dailyLimit is the
    // config default, not a day the tenant asked for, so it does not hold the number under its plan.
    channels.seed(config, undefined, mergeConfig(DEFAULTS, config).transport === TRANSPORT_BAILEYS
        ? newNumberSafety(deps.platformPolicy?.() ?? {}, { ...config, dailyLimit: 0 }) : {});

    const runtimeFor = (channel) => {
        let runtime = runtimes.get(channel.id);
        if (!runtime) {
            // One login folder per number. The default number used to share the tenant's root folder: it is
            // moved into the number's own folder once (adoptRootSession). A number that already has its own
            // keeps it when it becomes the default (a deleted default, the Cloud migration).
            const own = path.join(tenantDir, 'channels', String(channel.id), 'wwebjs_auth');
            runtime = createChannelRuntime({
                db: db.forChannel(channel.id),
                channel,
                // humanTiming is the deployment's switch (config.js): one a tenant saved before it was stripped is ignored.
                config: { ...channel.settings, humanTiming: DEFAULTS.humanTiming },
                save: (settings) => channels.update(channel.id, { settings }).settings,
                linked: (account) => channels.update(channel.id, { providerAccountId: account }),
                sessionDir: channel.isDefault ? adoptRootSession(sessionDir, own) : own,
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
    // `reset`: values to put back for keys the policy no longer names (custom limits removed).
    // A reset key goes back to the number's own stored value (its newNumberSafety start), as a restart would.
    const enforcePolicy = ({ state }, reset = {}) => {
        const stored = Object.keys(reset).length ? channels.get(state.channel.id)?.settings ?? {} : {};
        const back = Object.fromEntries(Object.entries(reset).map(([key, value]) => [key, stored[key] ?? value]));
        const wanted = { ...back, ...policy() };
        if (!POLICY_KEYS.some((key) => key in wanted && state.config[key] !== wanted[key])) return;
        Object.assign(state.config, wanted);
        state.manager.applyConfig(state.config);
    };
    const applyPolicy = (reset) => runtimes.forEach((runtime) => enforcePolicy(runtime, reset));
    // A business's channel settings never carry anti-ban keys; enforcePolicy only overrides the ones the admin set.
    // Nor the server-set ADMIN_CHANNEL_KEYS (linkedAt, humanTiming, ...): see config.js.
    const ownSettings = (settings) => settings && Object.fromEntries(
        Object.entries(settings).filter(([key]) => !POLICY_KEYS.includes(key) && !ADMIN_CHANNEL_KEYS.includes(key)));

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
    /** Live state plus today's budget and delivery quality. */
    const fullHealth = (channel) => {
        const runtime = runtimes.get(channel.id);
        const enforced = policy();
        // A running runtime already carries the policy; a cold one gets it applied here.
        const config = { ...(runtime?.state.config ?? channel.settings), ...enforced };
        return {
            ...channelHealth(channel, runtime),
            ...channelUsage(channel, {
                db: db.forChannel(channel.id), config,
                sending: deps.platformPolicy?.() ?? {}, pin: () => deps.channelPin?.(channel.id),
                start: deps.channelStart && (() => deps.channelStart(channel.id)),
                paused: deps.channelPaused?.(channel.id)?.reason ?? null,
            }),
        };
    };

    app.get('/channels', (req, res) => res.json({
        channels: channels.list().map((channel) => ({
            ...publicChannel(channel),
            health: fullHealth(channel),
        })),
        capabilities: CAPABILITIES,
        transports: TRANSPORTS,
        warnings: { [TRANSPORT_BAILEYS]: TOS_WARNING },
    }));

    app.post('/channels', (req, res) => {
        const platform = deps.platformPolicy?.() ?? {};
        const cap = numberCap(deps.limits?.() ?? {}, platform);
        if (cap && channels.list().length >= cap) return res.status(403).json({ errors: [capMessage(cap)] });
        const body = req.body ?? {};
        const blocked = providerBlocked(mergeConfig(DEFAULTS, body.settings).transport, deps.limits?.() ?? {}, platform);
        if (blocked) return res.status(403).json({ errors: [blocked] });
        try {
            const problems = channelInputProblems(body);
            if (problems.length) return res.status(400).json({ errors: problems });
            // newNumberSafety bounds what was asked for, so a tighter dailyLimit etc. still lands.
            const channel = channels.create({
                ...body, settings: ownSettings(body.settings), safety: newNumberSafety(platform, body.settings ?? {}),
            });
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
            health: fullHealth(channel),
        });
    });

    app.patch('/channels/:id', async (req, res) => {
        try {
            const problems = channelInputProblems(req.body ?? {});
            if (problems.length) return res.status(400).json({ errors: problems });
            const swapped = req.body?.settings?.transport;
            const blocked = swapped && providerBlocked(mergeConfig(DEFAULTS, { transport: swapped }).transport, deps.limits?.() ?? {}, deps.platformPolicy?.() ?? {});
            if (blocked) return res.status(403).json({ errors: [blocked] });
            const before = channels.get(req.params.id);
            // A scanned QR number is the one WhatsApp reported (linked()): a typed number must not restart its history
            // (number_since), which would drop its bans and reports and ask its questions again.
            const { phoneNumber, providerAccountId, ...kept } = req.body ?? {};
            const body = before && QR_TRANSPORTS.includes(before.provider) && before.providerAccountId ? kept : req.body;
            const channel = channels.update(req.params.id, { ...body, settings: ownSettings(req.body?.settings) });
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

    // ------------------------------------------------ number questions --
    // A QR number's 2 questions (policy/levels.js startLevelFor) set the day it starts at; bulk waits until they are
    // answered, and again after a ban or a different number (campaign/safety.js allowance). `asked` false = ask them.
    const startView = (channel) => {
        const { usage } = fullHealth(channel);
        // `suggested`: answers pre-selected from the chats the number already has (null when too few or unknown).
        const chats = runtimes.get(channel.id)?.state.historyChats ?? null;
        const suggested = chats == null ? null : suggestStart(chats);
        return {
            asked: usage.asked !== false, todayLimit: usage.todayLimit, planLimit: usage.planLimit,
            suggested: suggested && { ...suggested, chats },
        };
    };

    app.get('/channels/:id/start', (req, res) => {
        const channel = channels.get(req.params.id);
        if (!channel) return res.status(404).json({ errors: ['channel not found'] });
        return res.json({ ...startView(channel), skipWarning: { version: NUMBER_SKIP_VERSION, text: NUMBER_SKIP_TEXT } });
    });

    /** `{ age, usage }` (0-3 each), or `{ skip: true, accept: true }` to start at the plan's day, recorded as a consent. */
    app.post('/channels/:id/start', (req, res) => {
        const channel = channels.get(req.params.id);
        if (!channel) return res.status(404).json({ errors: ['channel not found'] });
        const asked = fullHealth(channel).usage.asked;
        if (asked === undefined || !deps.setChannelStart) return res.status(400).json({ errors: ['Only QR-login numbers with sending safety on are asked these questions.'] });
        if (asked) return res.status(409).json({ errors: ["This number's questions are already answered."] });
        const body = req.body ?? {};
        const skip = body.skip === true;
        let level;
        let answers;
        if (skip) {
            if (body.accept !== true) return res.status(400).json({ errors: ['Tick "I understand and accept" to skip the questions.'] });
            const tables = sendingTables(deps.platformPolicy?.() ?? {});
            level = skipStartLevel(tables.levels, tables.planDaily);
            answers = { skipped: true };
            // Before the start is saved: no skipped start without its consent row.
            deps.tenancy.recordConsent({
                tenantId: db.tenantId ?? req.tenantId, user: req.user, fullName: req.user?.name ?? '', ip: req.ip,
                userAgent: req.get('user-agent') ?? '', kind: 'number_skip_questions', channelId: channel.id,
            });
        } else {
            level = startLevelFor({ age: body.age, usage: body.usage });
            if (level == null) return res.status(400).json({ errors: ['Answer both questions: age and usage, each 0 to 3.'] });
            answers = { age: body.age, usage: body.usage };
        }
        deps.setChannelStart(channel.id, level, answers);
        runtimes.get(channel.id)?.state.manager?.quota.invalidate(); // a held run picks up within its 30s recheck
        audit?.(req, skip ? 'channel.start_skip' : 'channel.start', channel.id,
            skip ? `skipped the questions (version ${NUMBER_SKIP_VERSION}), start level ${level}` : `age ${body.age}, usage ${body.usage}, start level ${level}`);
        const { todayLimit, planLimit } = startView(channel);
        return res.json({ todayLimit, planLimit });
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

    /** The business resumes a number the ban guard paused, after confirming; an admin pause stays (403). */
    const resumePaused = async (channel, res) => {
        if (!deps.channelResume?.(channel.id)) return res.status(403).json({ errors: ['This number can only be resumed by your platform admin.'] });
        const result = await runtimeFor(channels.get(channel.id)).state.connect(); // fresh row: it is active again
        return res.status(result.status).json(result.body);
    };

    // -------------------------------------------------- channel routes --
    // A paused number must still show why: these reads (and the ban_guard resume) reach it, nothing else does.
    const pausedPages = (req) => (req.method === 'GET' && (req.path === '/connection' || req.path === '/events'))
        || (req.method === 'POST' && req.path === '/connection/resume');
    app.use((req, res, next) => {
        const named = req.get('x-channel-id') ?? req.query.channel;
        try {
            // Sender rule (channels.routing) for an unnamed send; reads and other writes keep the default.
            const sending = req.method === 'POST' && SEND_ROUTES[routeKey(req.path)];
            const channel = named == null || named === ''
                ? channels.route(sending ? {
                    rule: deps.platformPolicy?.()['channels.routing'],
                    remaining: (ch) => quotaLeft(db, ch, runtimes.get(ch.id), policy(), deps.platformPolicy?.() ?? {}, () => deps.channelPin?.(ch.id), deps.channelStart && (() => deps.channelStart(ch.id))),
                } : { any: pausedPages(req) })
                : channels.route({ channelId: Number(named), any: pausedPages(req) });
            req.channel = channel;
            bindContext({ channelId: channel.id });
            if (req.method === 'POST' && req.path === '/connection/resume') return resumePaused(channel, res);
            return runtimeFor(channel).router(req, res, next);
        } catch (err) {
            return fail(res, err);
        }
    });

    return { router: app, channels, runtimes, runtimeFor, applyPolicy, release };
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
        transport: channel.provider || channel.settings?.transport || '',
    };
}

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_MAX_IP_FAILS = 20;
// Agents may send and triage, but not change how the account behaves.
// '/media/upload': attaching a file to an inbox reply is agent work.
const AGENT_WRITES = new Set(['/messages', '/inbox/mark-read', '/media/upload']);
/**
 * An agent talks to customers and works the queue, so inbox and ticket writes
 * are theirs. Anything that changes how the account behaves still is not.
 */
// `/school` checks each staff title's areas itself (class teachers mark attendance).
const AGENT_WRITE_PREFIXES = ['/conversations', '/tickets', '/school'];

/** An http(s) origin (and optional path) without its trailing slash, or null. */
function cleanBaseUrl(value) {
    const text = String(value ?? '').trim().replace(/\/+$/, '');
    if (!text) return null;
    try {
        const url = new URL(text);
        if (url.protocol === 'http:' || url.protocol === 'https:') return text;
    } catch { /* fall through */ }
    console.warn(`[links] PUBLIC_BASE_URL "${text}" is not an http(s) URL; link tracking is off`);
    return null;
}

export function createApp({
    db = new Database(), config = loadConfig(), deps = {}, dataDir = APP_DIR,
    // Off by default: a test that builds an app should not start a timer it
    // never asked for. `index.js` turns it on for the real server.
    scheduler = false, sweepMs = 5000,
    // Where this server is reachable from the internet (PUBLIC_BASE_URL); tracked links need it.
    publicBaseUrl = null,
    // Overrides for createOpsAlerts (url, secret, fetch, now): tests point the webhook at a stub.
    opsAlertOptions = {},
} = {}) {
    const app = express();
    app.disable('x-powered-by');
    // Behind a reverse proxy, req.ip (the /v1 IP allow-list, per-address throttles) is the proxy's
    // address unless this names it: a hop count, "true", or proxy addresses as Express takes them.
    const trustProxy = process.env.TRUST_PROXY;
    if (trustProxy) app.set('trust proxy', trustProxy === 'true' ? true : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
    publicBaseUrl = cleanBaseUrl(publicBaseUrl);
    // Before the body parser, so a malformed body is still logged with an id.
    app.use(requestContext());
    app.use(securityHeaders());
    app.use(express.json({ limit: '1mb' }));

    const tenancy = new Tenancy(db);
    // One platform-wide ops alert channel (OPS_ALERT_WEBHOOK); its limits span every tenant and number.
    const opsAlerts = createOpsAlerts({ audit: (entry) => tenancy.audit(entry), ...opsAlertOptions });
    const opsAlert = deps.opsAlert ?? opsAlerts.raise;
    // Super-admin rules per plan; every tenant runtime reads its effective values through deps.platformPolicy.
    const policyStore = new PolicyStore(db);
    // Each tenant's security.* values (policy/security.js), read on every request by the rate
    // limits and the session check, so cached for 5s. An admin policy save clears it.
    const securityCache = new Map();
    const securityFor = (tenantId) => {
        const hit = securityCache.get(tenantId);
        if (hit && Date.now() - hit.at < 5000) return hit.values;
        const { values } = policyStore.resolve(tenantId);
        securityCache.set(tenantId, { at: Date.now(), values });
        return values;
    };
    tenancy.idleMsFor = (tenantId) => securityFor(tenantId)['security.sessionIdleMinutes'] * 60000;
    // The public API's budget is per key, not per tenant: one runaway integration cannot starve another.
    const v1Limit = rateLimit({
        keyFor: (req) => `v1:${req.apiKey.id}`,
        limitsFor: (req) => {
            const sec = securityFor(req.apiKey.tenantId);
            return { ratePerSecond: sec['security.publicApiRatePerSecond'], burst: sec['security.publicApiBurst'] };
        },
    });
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
                deps: {
                    ...deps,
                    tenancy,
                    opsAlert,
                    limits: () => tenancy.getTenant(tenantId)?.limits ?? {},
                    platformPolicy: () => policyStore.resolve(tenantId).values,
                    bulkKill: () => bulkKillReason(policyStore, tenantId, tenancy.getTenant(tenantId)?.controls),
                    controls: () => tenancy.getTenant(tenantId)?.controls ?? {},
                    channelPaused: (channelId) => app.locals.channelOps?.pausedOf(channelId),
                    channelResume: (channelId) => app.locals.channelOps?.resumeBanGuard(channelId),
                    channelPin: (channelId) => app.locals.channelOps?.pinOf(channelId) ?? null,
                    channelStart: (channelId) => app.locals.channelOps?.startOf(channelId) ?? null,
                    setChannelStart: (channelId, level, answers) => app.locals.channelOps?.setStart(channelId, level, answers),
                    publicBaseUrl,
                },
                audit,
                policy: () => tenancy.enforcedSafety(tenancy.getTenant(tenantId)),
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
        const sub = new BillingStore(scoped).subscription();
        return {
            ...tenant,
            subscription: sub && {
                planKey: sub.planKey,
                planName: sub.plan.name,
                price: sub.plan.price,
                currency: sub.plan.currency,
                interval: sub.plan.interval,
                state: sub.state,
                status: sub.status,
                trialEndsAt: sub.trialEndsAt,
                currentPeriodEnd: sub.currentPeriodEnd,
                cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
                graceEndsAt: sub.graceEndsAt,
            },
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
        if (err instanceof TenancyError || err instanceof BillingError) {
            return res.status(err.status).json({ errors: [err.message] });
        }
        throw err;
    };

    // --------------------------------------------------------- public --
    app.get('/api/health', (req, res) => res.json({ ok: true, status: 'ready' }));

    /**
     * A tracked campaign link (links/store.js): count the tap, then send the
     * browser on. Public - the recipient has no session - and it only ever
     * redirects to a URL a campaign stored, so it is no open redirect. The
     * code is all it takes and all it reveals: no tenant, campaign or number.
     * Link-preview fetchers are redirected but not counted as taps.
     */
    // Per address, and roomy: behind a reverse proxy every tap shares one address.
    const linkLimit = rateLimit({ ratePerSecond: 10, burst: 50, keyFor: (req) => `link:${req.ip}` });
    app.get('/l/:code', linkLimit, (req, res) => {
        const preview = /WhatsApp\/|facebookexternalhit|bot\b|crawler|spider|preview/i.test(req.get('user-agent') ?? '');
        const url = followLink(db.db, req.params.code, { count: !preview });
        res.set('Cache-Control', 'no-store');
        if (!url) return res.status(404).type('text/plain').send('This link is not valid or has expired.');
        return res.redirect(302, url);
    });

    app.post('/api/auth/login', async (req, res) => {
        const { email = '', password = '' } = req.body ?? {};
        const key = String(email).trim().toLowerCase();
        // Two throttles: per account (stops guessing one password) and per
        // address (stops one client spraying many accounts).
        const ipKey = `ip:${req.ip}`;
        const now = Date.now();
        const locked = (k, max) => (logins.get(k)?.until > now && logins.get(k).fails >= max);
        if (locked(key, LOGIN_MAX_FAILS) || locked(ipKey, LOGIN_MAX_IP_FAILS)) {
            return res.status(429).json({ errors: ['Too many failed attempts. Try again in a few minutes.'] });
        }
        const user = await tenancy.authenticate(email, password);
        const tenant = user?.tenantId == null ? null : tenancy.getTenant(user.tenantId);
        if (!user || (tenant && tenant.status !== 'active')) {
            if (logins.size > 10000) for (const [k, v] of logins) if (v.until <= now) logins.delete(k);
            for (const k of [key, ipKey]) {
                const entry = logins.get(k);
                logins.set(k, { fails: (entry?.until > now ? entry.fails : 0) + 1, until: now + LOGIN_WINDOW_MS });
            }
            return res.status(401).json({ errors: ['Wrong email or password.'] });
        }
        logins.delete(key);
        tenancy.audit({ tenantId: user.tenantId, userId: user.id, action: 'auth.login' });
        return res.json({ token: tenancy.createSession(user.id), user, tenant });
    });

    /**
     * The public API authenticates with an API key, so it must sit above the
     * session middleware below - that one 401s anything without a bearer
     * *session*. The key selects the tenant.
     */
    app.all('/api/v1/*splat', (req, res, next) => {
        const header = req.get('authorization') ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-key');
        const key = new ApiKeyStore(db, {
            maxAgeDays: (tenantId) => securityFor(tenantId)['security.apiKeyMaxAgeDays'] ?? 0,
        }).verify(presented);
        if (!key) return res.status(401).json({ error: 'invalid_api_key' });
        const tenant = tenancy.getTenant(key.tenantId);
        if (tenant?.status !== 'active') return res.sendStatus(404);
        if (!ipAllowed(securityFor(key.tenantId)['security.ipAllowList'], req.ip)) {
            return res.status(403).json({ error: 'ip_not_allowed', message: 'This address may not use the API for this account.' });
        }
        // The admin's tenant controls, as tenantAccessError applies them to the session API.
        const p = routeKey(req.path);
        const write = req.method !== 'GET' && req.method !== 'HEAD';
        const under = (prefix) => p === prefix || p.startsWith(`${prefix}/`);
        // Events and object writes start workflows. v1 never sends directly; a
        // workflow send while sending is off waits in the engine instead.
        const startsWorkflow = ['/api/v1/events', '/api/v1/appointments', '/api/v1/orders', '/api/v1/payments'].some(under);
        if (write && startsWorkflow && tenant.controls.automationsEnabled === false) {
            return res.status(403).json({ error: 'tenant_blocked', message: 'Automations are disabled for this account.' });
        }
        const billing = new BillingStore(db.forTenant(key.tenantId), { overrides: () => policyStore.resolve(key.tenantId).values });
        if (billing.subscription()?.state === 'expired') {
            return res.status(402).json({ error: 'subscription_expired', message: 'The subscription has ended. Contact your provider to renew.' });
        }
        // The plan's api_requests quota (or the admin's billing.apiRequestsPerMonth); a refused call
        // is not counted, and neither is one the per-key rate limit turns away.
        const quota = billing.check('api_requests');
        if (!quota.allowed) {
            const message = quota.limit === 0
                ? "This account's plan does not include API access."
                : `This account has used its ${quota.limit} API requests for this month.`;
            return res.status(429).json({ error: 'quota_exceeded', message });
        }
        req.apiKey = key;
        return v1Limit(req, res, () => {
            billing.record('api_requests');
            bindContext({ tenantId: key.tenantId });
            req.url = req.url.slice('/api'.length);
            return runtimeFor(key.tenantId).router(req, res, next);
        });
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
    // A business's own limits (security.apiRatePerSecond/apiBurst); super admins keep the defaults.
    app.use('/api', rateLimit({
        ratePerSecond: 20, burst: 40,
        limitsFor: (req) => {
            if (req.user.tenantId == null) return null;
            const sec = securityFor(req.user.tenantId);
            return { ratePerSecond: sec['security.apiRatePerSecond'], burst: sec['security.apiBurst'] };
        },
    }));

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
    // Platform actions on a tenant land in that tenant's audit trail, not under "no tenant".
    admin.param('id', (req, res, next, id) => {
        if (Number.isInteger(Number(id))) req.tenantId = Number(id);
        next();
    });
    app.use('/api/admin', admin);
    admin.use(createCampaignOpsRouter({ db, runtimes, runtimeFor, tenancy, policyStore, audit }));
    registerTemplateAdmin(admin, { db, tenancy, policy: policyStore, audit }); // review queue, starter library

    admin.get('/tenants', (req, res) => res.json({
        tenants: tenancy.listTenants().map(tenantOverview),
        services: TENANT_SERVICES,
    }));

    // Plans are platform-wide, so any tenant's handle reads the same catalogue.
    const catalogue = () => new BillingStore(db.forTenant(DEFAULT_TENANT_ID));
    /** Businesses on each plan key, archived ones excluded. */
    const subscriberCounts = () => new Map(db.db.prepare(
        `SELECT s.plan_key AS key, COUNT(*) AS n FROM subscriptions s
         JOIN tenants t ON t.id = s.tenant_id WHERE t.status != 'archived' GROUP BY s.plan_key`)
        .all().map((r) => [r.key, r.n]));
    /** An archived plan stays with whoever has it (renewals work) but is not handed out again. */
    const planOr404 = (key, currentKey = null) => {
        const plan = catalogue().getPlan(key);
        if (!plan) throw new BillingError('unknown plan', 404);
        if (plan.active === false && plan.key !== currentKey) throw new BillingError('that plan is archived', 409);
        return plan;
    };

    /**
     * Put a business on a plan now: subscription first, then the plan's
     * services and tenant limits, so what the business can do follows what it
     * is on.  `setLimits` merges, so the operator's blockedWords and custom
     * safety switch survive a plan change. On a change, a limit moves only
     * while it still equals the old plan's value: an admin override stays.
     */
    const applyPlan = (tenantId, plan, trialDays, services = plan.services) => {
        const days = Math.max(0, Math.min(365, Math.floor(Number(trialDays) || 0)));
        const store = new BillingStore(db.forTenant(tenantId));
        const old = store.subscription()?.plan.tenantLimits ?? null;
        const subscription = store.subscribe(tenantId, plan.key, {
            trialEndsAt: days ? new Date(Date.now() + days * 24 * 3600 * 1000) : null,
        });
        tenancy.updateTenant(tenantId, { services });
        followPlanLimits(tenantId, old, plan.tenantLimits);
        return subscription;
    };
    const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    /** Move a business's limits from `from` to `to`, keeping any an admin changed (no longer equal to `from`). */
    const followPlanLimits = (tenantId, from, to) => {
        const current = tenancy.getTenant(tenantId)?.limits ?? {};
        tenancy.setLimits(tenantId, Object.fromEntries(Object.entries(to ?? {})
            .filter(([key]) => !from || sameJson(current[key], from[key]))));
        runtimes.get(tenantId)?.applyPolicy();
    };

    admin.get('/billing/plans', (req, res) => {
        const counts = subscriberCounts();
        return res.json({
            plans: catalogue().plans().map((plan) => ({ ...plan, subscribers: counts.get(plan.key) ?? 0 })),
            services: TENANT_SERVICES,
        });
    });

    admin.put('/billing/plans/:key', (req, res) => {
        try {
            // Merge over what is in force, so a partial PUT (say, active: false)
            // does not reset everything else to defaults.
            const before = catalogue().getPlan(req.params.key) ?? {};
            const plan = catalogue().savePlan({ ...before, ...(req.body ?? {}), key: req.params.key });
            // Subscribers follow edited limits, so applyPlan's "still the old plan's value" test reads the live plan.
            if (before.key && !sameJson(before.tenantLimits ?? {}, plan.tenantLimits ?? {})) {
                db.db.prepare(`SELECT s.tenant_id AS id FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
                               WHERE s.plan_key = ? AND t.status != 'archived'`).all(plan.key)
                    .forEach(({ id }) => followPlanLimits(id, before.tenantLimits ?? {}, plan.tenantLimits));
            }
            audit(req, 'plan.save', plan.key, plan.name);
            return res.json({ plan });
        } catch (err) {
            return fail(res, err);
        }
    });

    admin.delete('/billing/plans/:key', (req, res) => {
        try {
            const { key } = req.params;
            const custom = !DEFAULT_PLANS[key];
            if (custom && subscriberCounts().get(key)) {
                return res.status(409).json({ errors: ["Move this plan's businesses to another plan first."] });
            }
            const plan = catalogue().removePlan(key);
            audit(req, 'plan.remove', key);
            return res.json(custom ? { removed: true } : { plan });
        } catch (err) {
            return fail(res, err);
        }
    });

    admin.put('/tenants/:id/subscription', (req, res) => {
        try {
            const tenant = tenancy.getTenant(req.params.id);
            if (!tenant || tenant.status === 'archived') return res.status(404).json({ errors: ['tenant not found'] });
            const plan = planOr404(req.body?.planKey, new BillingStore(db.forTenant(tenant.id)).subscription()?.planKey);
            // A first assignment gets the plan's trial; a change or renewal is
            // paid-for, so no fresh trial unless the admin asks for one.
            const hadOne = new BillingStore(db.forTenant(tenant.id)).subscription() !== null;
            const subscription = applyPlan(tenant.id, plan, req.body?.trialDays ?? (hadOne ? 0 : plan.trialDays));
            audit(req, 'tenant.subscription', tenant.id, { planKey: plan.key, state: subscription.state });
            return res.json({ subscription, tenant: tenantOverview(tenancy.getTenant(tenant.id)) });
        } catch (err) {
            return fail(res, err);
        }
    });

    admin.delete('/tenants/:id/subscription', (req, res) => {
        try {
            const immediate = req.query.immediate === 'true';
            const subscription = new BillingStore(db.forTenant(Number(req.params.id))).cancel({ atPeriodEnd: !immediate });
            audit(req, 'tenant.subscription.cancel', Number(req.params.id), { immediate });
            return res.json({ subscription });
        } catch (err) {
            return fail(res, err);
        }
    });

    admin.post('/tenants', async (req, res) => {
        try {
            const body = req.body ?? {};
            // Resolved before the tenant exists, so a bad key creates nothing.
            const plan = body.planKey ? planOr404(body.planKey) : null;
            // The admin may hand-pick services on top of a plan; omitted = the plan's own.
            const services = Array.isArray(body.services) ? body.services : plan?.services;
            const { tenant: created, owner: user } = await tenancy.createTenantWithOwner(
                plan ? { ...body, services } : body);
            if (plan) applyPlan(created.id, plan, body.trialDays ?? plan.trialDays, services);
            const tenant = tenancy.getTenant(created.id);
            audit(req, 'tenant.create', tenant.id, plan ? `${tenant.slug} on ${plan.key}` : tenant.slug);
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

    // Demo content for the tenant's enabled services. Idempotent; never sends.
    admin.post('/tenants/:id/seed', async (req, res) => {
        const tenant = tenancy.getTenant(req.params.id);
        if (!tenant) return res.status(404).json({ errors: ['tenant not found'] });
        const rt = runtimeFor(tenant.id);
        const channel = rt.channels.getDefault();
        if (!channel) return res.status(409).json({ errors: ['tenant has no channel yet'] });
        const result = await seedTenant(rt.runtimeFor(channel).state, { services: tenant.services, tenantName: tenant.name });
        audit(req, 'tenant.seed', tenant.id, result.created);
        return res.json(result);
    });

    // Anti-ban policy (pacing, daily cap, rate, retries): effective values = defaults + overrides.
    // `safety` stays the platform's own values; `custom` is what the tenant layered on top.
    const customSafetyView = (tenant) => ({
        allowed: tenant.limits.allowCustomSafety,
        active: tenancy.customSafetyActive(tenant),
        overrides: tenant.customSafety,
        consent: tenancy.currentConsent(tenant.id),
        consentVersion: CONSENT_VERSION,
        exited: tenant.safetyExit,
    });
    const safetyView = (tenant) => ({
        safety: tenancy.platformSafety(tenant),
        custom: customSafetyView(tenant),
    });
    /** Put platform values back on running channels for keys the tenant had overridden. */
    const revertCustomSafety = (before) => {
        const platform = tenancy.platformSafety(before);
        runtimes.get(before.id)?.applyPolicy(Object.fromEntries(Object.keys(before.customSafety)
            .map((key) => [key, platform[key]])));
    };
    /** Keys a safety PUT reset to null, with the value running channels go back to (after the save). */
    const resetValues = (tenant, body) => {
        const platform = tenancy.platformSafety(tenant);
        return Object.fromEntries(Object.keys(POLICY_SPEC).filter((key) => body?.[key] === null)
            .map((key) => [key, platform[key]]));
    };

    // Accounts: a super admin sees a business's sign-ins and can reset a password.
    admin.get('/tenants/:id/users', (req, res) => (tenancy.getTenant(req.params.id)
        ? res.json({ users: tenancy.listUsers(req.params.id) })
        : res.status(404).json({ errors: ['tenant not found'] })));

    admin.put('/tenants/:id/users/:userId/password', async (req, res) => {
        try {
            const user = await tenancy.setPassword(req.params.id, req.params.userId, req.body?.password);
            audit(req, 'user.password_reset', user.id, user.email);
            return res.json({ user });
        } catch (err) {
            return fail(res, err);
        }
    });

    admin.get('/tenants/:id/safety', (req, res) => {
        const tenant = tenancy.getTenant(req.params.id);
        return tenant ? res.json(safetyView(tenant)) : res.status(404).json({ errors: ['tenant not found'] });
    });

    admin.put('/tenants/:id/safety', (req, res) => {
        try {
            const tenant = tenancy.setSafety(req.params.id, req.body ?? {});
            runtimes.get(tenant.id)?.applyPolicy(resetValues(tenant, req.body)); // null: back to the default
            audit(req, 'tenant.safety', tenant.id, tenant.safety);
            return res.json(safetyView(tenant));
        } catch (err) {
            return fail(res, err);
        }
    });

    admin.put('/tenants/:id/limits', (req, res) => {
        try {
            const tenant = tenancy.setLimits(req.params.id, req.body ?? {});
            runtimes.get(tenant.id)?.applyPolicy(); // allowCustomSafety may have switched custom limits on/off
            audit(req, 'tenant.limits', tenant.id, tenant.limits);
            return res.json({ limits: tenant.limits });
        } catch (err) {
            return fail(res, err);
        }
    });

    // Revoke: drop the tenant's own limits and take the permission back.
    admin.delete('/tenants/:id/custom-safety', (req, res) => {
        try {
            const before = tenancy.getTenant(req.params.id);
            if (!before) return res.status(404).json({ errors: ['tenant not found'] });
            tenancy.clearCustomSafety(before.id);
            const tenant = tenancy.setLimits(before.id, { allowCustomSafety: false });
            revertCustomSafety(before);
            audit(req, 'tenant.custom_safety.revoke', tenant.id, before.customSafety);
            return res.json(safetyView(tenant));
        } catch (err) {
            return fail(res, err);
        }
    });

    // Security buttons: end every session of the business, or revoke all its API keys.
    admin.post('/tenants/:id/sessions/revoke', (req, res) => {
        const tenant = tenancy.getTenant(req.params.id);
        if (!tenant) return res.status(404).json({ errors: ['tenant not found'] });
        const count = tenancy.revokeTenantSessions(tenant.id);
        audit(req, 'tenant.sessions.revoke', tenant.id, { count });
        return res.json({ count });
    });

    admin.post('/tenants/:id/api-keys/revoke', (req, res) => {
        const tenant = tenancy.getTenant(req.params.id);
        if (!tenant) return res.status(404).json({ errors: ['tenant not found'] });
        const count = new ApiKeyStore(db.forTenant(tenant.id)).revokeAll();
        audit(req, 'tenant.api_keys.revoke', tenant.id, { count });
        return res.json({ count });
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

    // Platform policy: per-plan rules for every service (see src/policy). Scope is
    // `global`, `plan:<key>` or `tenant:<id>`; a null value removes an override.
    const policyFail = (res, err) => {
        if (err instanceof PolicyError) return res.status(err.status).json({ errors: [err.message] });
        throw err;
    };
    admin.get('/policy', (req, res) => res.json({
        fields: POLICY_FIELDS,
        global: fillTables(policyStore.values('global')),
        plans: Object.fromEntries(Object.entries(policyStore.planValues()).map(([plan, values]) => [plan, fillTables(values)])),
        planList: new BillingStore(db.forTenant(DEFAULT_TENANT_ID)).plans().map((p) => ({ key: p.key, name: p.name, tier: p.tier })),
        // Tables saved with an old row count: sending holds numbers at their old top until the admin saves them again.
        stale: policyStore.staleTables(),
    }));
    admin.get('/policy/tenant/:id', (req, res) => {
        const resolved = policyStore.resolve(Number(req.params.id));
        return res.json({
            overrides: fillTables(policyStore.values(`tenant:${Number(req.params.id)}`)),
            ...resolved,
            values: fillTables(resolved.values),
        });
    });
    admin.put('/policy/:scope', (req, res) => {
        try {
            const values = policyStore.set(req.params.scope, req.body?.values ?? {});
            securityCache.clear();
            audit(req, 'policy.change', req.params.scope, Object.keys(req.body?.values ?? {}).join(', '));
            return res.json({ values });
        } catch (err) {
            return policyFail(res, err);
        }
    });

    // Ops pages (read only): plans vs usage, message volume, live channel health, audit search.
    const ops = createAdminOps({ db, tenancy, runtimes });
    const channelOps = createChannelOps({ db, tenancy, runtimes, policy: policyStore });
    channelOps.register(admin, audit); // /api/admin/numbers/:channelId/{pause,resume,disconnect,move,level}
    app.locals.channelOps = channelOps;
    admin.get('/plans', (req, res) => res.json(ops.plans()));
    admin.get('/usage-summary', (req, res) => res.json(ops.usage({ days: req.query.days })));
    // `backup`: the last daily backup attempt (backup.js lastBackup), null before the first.
    // `encryption`: key ids and the last re-encryption (security/keyGate.js encryptionStatus), never a key.
    admin.get('/health-detail', (req, res) => res.json({
        ...ops.health(), backup: lastBackup(dataDir), encryption: encryptionStatus(dataDir),
    }));
    admin.get('/shadow-review', (req, res) => res.json(ops.shadowReview({ days: req.query.days })));
    admin.get('/audit-logs', (req, res) => (req.query.format === 'csv'
        ? res.type('text/csv').attachment('audit-logs.csv').send(auditCsv(ops.audit(req.query, { maxLimit: 10000 }).logs))
        : res.json(ops.audit(req.query))));

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
        const cap = tenancy.getTenant(req.tenantId)?.limits.maxUsers;
        if (cap && tenancy.listUsers(req.tenantId).length >= cap) {
            return res.status(403).json({ errors: [`Your plan allows ${cap} team member${cap === 1 ? '' : 's'}.`] });
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

    // ------------------------------------------- tenant-owned safety --
    // A business changing its own anti-ban limits: only when the platform admin
    // allows it, and only after someone accepted the risk (CONSENT_VERSION).
    const custom = express.Router();
    custom.use(withTenant, requireRole('admin'));
    app.use('/api/safety/custom', custom);

    const tenantSafetyView = (tenant) => ({
        ...customSafetyView(tenant),
        consentText: CONSENT_TEXT,
        exitText: SAFETY_EXIT_TEXT,
        exitVersion: SAFETY_EXIT_VERSION,
        policy: tenancy.effectiveSafety(tenant),
        platform: tenancy.platformSafety(tenant),
        ranges: POLICY_SPEC,
    });
    const tenantOr404 = (req, res) => {
        const tenant = tenancy.getTenant(req.tenantId);
        if (!tenant) res.status(404).json({ errors: ['tenant not found'] });
        return tenant;
    };

    custom.get('/', (req, res) => {
        const tenant = tenantOr404(req, res);
        return tenant && res.json(tenantSafetyView(tenant));
    });

    custom.post('/consent', (req, res) => {
        const tenant = tenantOr404(req, res);
        if (!tenant) return undefined;
        if (!tenant.limits.allowCustomSafety) {
            return res.status(403).json({ errors: ['Your platform admin has not enabled custom sending limits.'] });
        }
        const { accept, version, fullName, confirmation } = req.body ?? {};
        if (accept !== true) return res.status(400).json({ errors: ['Tick the box to accept the risk.'] });
        if (version !== CONSENT_VERSION) {
            return res.status(409).json({ errors: ['The terms changed. Reload and read them again.'] });
        }
        if (!String(fullName ?? '').trim()) return res.status(400).json({ errors: ['Type your full name.'] });
        const typed = String(confirmation ?? '').trim().toLowerCase();
        if (typed !== 'i accept' && typed !== tenant.name.trim().toLowerCase()) {
            return res.status(400).json({ errors: ['Type I ACCEPT (or your business name) to confirm.'] });
        }
        const consent = tenancy.recordConsent({
            tenantId: tenant.id, user: req.user, fullName, ip: req.ip, userAgent: req.get('user-agent') ?? '',
        });
        audit(req, 'safety.consent', consent.id, { version: consent.version, fullName: consent.fullName });
        return res.status(201).json(tenantSafetyView(tenancy.getTenant(tenant.id)));
    });

    custom.put('/', (req, res) => {
        const tenant = tenantOr404(req, res);
        if (!tenant) return undefined;
        if (!tenant.limits.allowCustomSafety) {
            return res.status(403).json({ errors: ['Your platform admin has not enabled custom sending limits.'] });
        }
        if (!tenancy.currentConsent(tenant.id)) {
            return res.status(403).json({ errors: ['Accept the sending-risk terms before changing limits.'] });
        }
        try {
            // requestTimeout stays the platform admin's even with custom limits on.
            const body = { ...req.body };
            for (const key of ADMIN_CHANNEL_KEYS) delete body[key];
            const next = tenancy.setCustomSafety(tenant.id, body);
            runtimes.get(tenant.id)?.applyPolicy(resetValues(next, body));
            audit(req, 'safety.custom', tenant.id, next.customSafety);
            return res.json(tenantSafetyView(next));
        } catch (err) {
            return fail(res, err);
        }
    });

    // Leaving sending safety is the business's own call, not gated by allowCustomSafety; the warning is
    // accepted again on every exit. Rejoining needs no consent.
    custom.post('/exit', (req, res) => {
        const tenant = tenantOr404(req, res);
        if (!tenant) return undefined;
        const { accept, version, fullName, confirmation } = req.body ?? {};
        if (accept !== true) return res.status(400).json({ errors: ['Tick the box to accept the risk.'] });
        if (version !== SAFETY_EXIT_VERSION) {
            return res.status(409).json({ errors: ['The terms changed. Reload and read them again.'] });
        }
        if (!String(fullName ?? '').trim()) return res.status(400).json({ errors: ['Type your full name.'] });
        if (String(confirmation ?? '').trim().toLowerCase() !== 'i accept') {
            return res.status(400).json({ errors: ['Type I ACCEPT to confirm.'] });
        }
        const consent = tenancy.recordConsent({
            tenantId: tenant.id, user: req.user, fullName, ip: req.ip, userAgent: req.get('user-agent') ?? '', kind: 'safety_exit',
        });
        const next = tenancy.setSafetyExit(tenant.id, { at: consent.acceptedAt, by: consent.email, fullName: consent.fullName });
        runtimes.get(tenant.id)?.applyPolicy();
        audit(req, 'safety.exit', consent.id, { version: consent.version, fullName: consent.fullName });
        return res.status(201).json(tenantSafetyView(next));
    });

    custom.delete('/exit', (req, res) => {
        const before = tenantOr404(req, res);
        if (!before) return undefined;
        const tenant = tenancy.setSafetyExit(before.id, null);
        runtimes.get(tenant.id)?.applyPolicy({ safetyEnabled: tenancy.platformSafety(tenant).safetyEnabled });
        audit(req, 'safety.rejoin', tenant.id, before.safetyExit);
        return res.json(tenantSafetyView(tenant));
    });

    custom.delete('/', (req, res) => {
        const before = tenantOr404(req, res);
        if (!before) return undefined;
        const tenant = tenancy.clearCustomSafety(before.id);
        revertCustomSafety(before);
        audit(req, 'safety.custom.reset', tenant.id, before.customSafety);
        return res.json(tenantSafetyView(tenant));
    });

    // ------------------------------------------------- tenant routes --
    // What the platform allows this business, so its own screens can show limits before refusing.
    // `linkTracking`: whether the composer can offer "Track link clicks" (PUBLIC_BASE_URL is set).
    // security.* is the admin's business only: an allow-list or rate limit is not shown to the account it binds.
    app.get('/api/policy', withTenant, (req, res) => {
        const { planKey, values, sources } = policyStore.resolve(req.tenantId);
        const visible = (map) => Object.fromEntries(Object.entries(map).filter(([key]) => !key.startsWith('security.')));
        return res.json({ planKey, values: visible(values), sources: visible(sources), linkTracking: Boolean(publicBaseUrl) });
    });

    app.use('/api', withTenant, (req, res, next) => {
        const tenant = tenancy.getTenant(req.tenantId);
        const accessError = tenant ? tenantAccessError(tenant, req) : 'tenant not found';
        if (accessError) return res.status(403).json({ errors: [accessError] });
        // Auth and /me sit above this, so an expired business can still sign in
        // and see why. The super admin is never locked out of a business.
        if (req.user.role !== 'super_admin'
            && new BillingStore(db.forTenant(req.tenantId)).subscription()?.state === 'expired') {
            return res.status(402).json({ errors: ['Your subscription has ended. Contact your provider to renew.'] });
        }
        const write = req.method !== 'GET' && req.method !== 'HEAD';
        const p = routeKey(req.path);
        const agentMayWrite = AGENT_WRITES.has(p) || AGENT_WRITE_PREFIXES.some((prefix) => p.startsWith(prefix));
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
    const sweepWarned = new Set(); // `${tenantId}:${campaignId}` already logged as not startable
    const sweep = async () => {
        await channelOps.guard().catch((err) => console.error('[channels] ban guard failed:', err.message));
        let due = [];
        try {
            due = dueRuns(db, new Date());
        } catch (err) {
            console.error('[workflows] sweep failed:', err.message);
            return;
        }
        // A campaign runs on the number it was made for; the default only when it names none (or that one is gone).
        const campaignsOn = (tenantId, channelId) => {
            const tenant = runtimeFor(tenantId);
            const channel = (channelId != null && tenant.channels.get(channelId)) || tenant.channels.getDefault();
            return channel ? tenant.runtimeFor(channel).state.campaigns : null;
        };
        // A campaign with `scheduled_at` holds no timer either, for the same
        // reason: the row is the state and must survive a restart.
        try {
            for (const { id, tenantId, channelId } of dueCampaigns(db, new Date())) {
                try {
                    const store = campaignsOn(tenantId, channelId);
                    // Starting resets the queue: wait while this number is still sending another run.
                    if (store?.manager?.queue.pending || store?.manager?.inFlight) continue;
                    store?.start(id);
                } catch (err) {
                    // An empty audience, a deleted template or a disconnected
                    // number must not stop the sweep for every other tenant. The
                    // campaign stays `scheduled` and is retried next tick, so
                    // say so once per campaign rather than every tick.
                    const key = `${tenantId}:${id}`;
                    if (!sweepWarned.has(key)) {
                        sweepWarned.add(key);
                        console.error(`[campaigns] ${id} failed to start (will keep retrying):`, err.message);
                    }
                }
            }
            // After a restart the in-memory queue is empty but the campaigns still read running/paused:
            // queue their unsent rows again once the number is back online.
            for (const { id, tenantId, channelId } of openCampaigns(db)) {
                try {
                    campaignsOn(tenantId, channelId)?.recover(id);
                } catch (err) {
                    const key = `recover:${tenantId}:${id}`;
                    if (!sweepWarned.has(key)) {
                        sweepWarned.add(key);
                        console.error(`[campaigns] ${id} could not resume after restart (will keep retrying):`, err.message);
                    }
                }
            }
            // Spread campaigns: close out today's batch (books tomorrow) and lift a daily-cap pause.
            for (const { id, tenantId, channelId } of runningSpreadCampaigns(db)) {
                try {
                    campaignsOn(tenantId, channelId)?.tick(id);
                } catch (err) {
                    console.error(`[campaigns] spread tick ${id} failed:`, err.message);
                }
            }
            // Repeating campaigns: a finished run books the next one (once; see spawnRecurrences).
            for (const tenantId of recurringTenants(db)) {
                try {
                    const channel = runtimeFor(tenantId).channels.getDefault();
                    const state = channel ? runtimeFor(tenantId).runtimeFor(channel).state : null;
                    for (const campaign of state?.campaigns?.spawnRecurrences() ?? []) {
                        state.broadcast?.({ type: 'campaignCreated', campaign });
                    }
                } catch (err) {
                    console.error(`[campaigns] repeat booking for tenant ${tenantId} failed:`, err.message);
                }
            }
        } catch (err) {
            console.error('[campaigns] sweep failed:', err.message);
        }
        try {
            retentionSweep(db, policyStore); // campaigns.retentionDays, throttled to hourly
        } catch (err) {
            console.error('[campaigns] retention sweep failed:', err.message);
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

    /**
     * Bring back every connection a user left up. Runs once at boot and then as a
     * watchdog, so a restart or a dropped session never leaves a number offline
     * until someone opens the Connection page.
     */
    const reconnectAll = async () => {
        void opsAlerts.tick(); // the hourly "N alerts held back" summary
        for (const tenant of tenancy.listTenants()) {
            if (tenant.status !== 'active') continue;
            try {
                const runtime = runtimeFor(tenant.id);
                for (const channel of runtime.channels.list()) {
                    if (channel.status !== 'active' || !channel.settings.autoConnect) continue;
                    const { state } = runtime.runtimeFor(channel);
                    const t = state.transport;
                    // Block, delivery and stuck checks every 10 minutes per connected number, sending or not.
                    if (t?.isConnected?.()) {
                        try {
                            state.manager.scanHealthIfDue();
                        } catch (err) {
                            logger.warn('health scan failed', { tenantId: tenant.id, channelId: channel.id, error: err.message });
                        }
                    }
                    // Dead-man: messages waiting in sending hours, nothing sent for 6h.
                    try {
                        const idleMs = state.manager.deadManIdleMs();
                        if (idleMs) {
                            state.manager.opsAlert?.({
                                kind: 'dead_man',
                                text: `Messages are waiting but nothing was sent for ${Math.floor(idleMs / 3_600_000)} hours.`,
                            });
                        }
                    } catch (err) {
                        logger.warn('dead-man check failed', { tenantId: tenant.id, channelId: channel.id, error: err.message });
                    }
                    // A transport mid-reconnect has its own backoff: do not fight it.
                    // An unscanned QR that expired waits for the user to press Connect, or it would show codes forever.
                    if (state.connecting || t?.isConnected?.() || t?.reconnectTimer || t?.connecting || t?.replaced || t?.banned || t?.qrExpired) continue;
                    const result = await state.connect();
                    if (result.status >= 400) {
                        logger.warn('auto-reconnect failed', { tenantId: tenant.id, channelId: channel.id, error: result.body?.errors?.[0] });
                    }
                }
            } catch (err) {
                logger.warn('auto-reconnect error', { tenantId: tenant.id, error: err.message });
            }
        }
    };
    app.locals.reconnectAll = reconnectAll;

    if (scheduler) {
        const timer = setInterval(() => { void sweep(); }, sweepMs);
        timer.unref();
        const boot = setTimeout(() => { void reconnectAll(); }, 1500);
        const watchdog = setInterval(() => { void reconnectAll(); }, 30_000);
        boot.unref();
        watchdog.unref();
        // The daily encrypted backup (backup.js): checked hourly, runs once per UTC day.
        const backupCheck = () => { void runBackupIfDue({ db: db.db, dataDir, alert: opsAlert }); };
        const backupBoot = setTimeout(backupCheck, 60_000);
        const backupTimer = setInterval(backupCheck, 3_600_000);
        backupBoot.unref();
        backupTimer.unref();

        // Outbound webhooks are durable jobs, not a second retry loop.
        const jobs = new JobStore(db);
        const worker = new SchedulerWorker(jobs, { allTenants: true });
        worker.register(WEBHOOK_JOB_KIND, createWebhookDeliveryHandler({ db }));
        worker.start();
        app.locals.worker = worker;

        app.locals.stopScheduler = async () => {
            clearInterval(timer);
            clearInterval(watchdog);
            clearTimeout(boot);
            clearInterval(backupTimer);
            clearTimeout(backupBoot);
            await worker.shutdown();
        };
    }
    app.locals.sweep = sweep;

    app.locals.runtimes = runtimes;
    app.locals.tenancy = tenancy;
    // Section 4's backup and re-encryption jobs report failures here: opsAlert({ kind: 'backup_failed' |
    // 'reencrypt_failed', text, detail }).
    app.locals.opsAlert = opsAlert;
    app.locals.opsAlerts = opsAlerts;
    app.locals.policy = policyStore;
    app.locals.runtimeFor = runtimeFor;

    // A thrown error is logged with its stack and answered as JSON, so the UI
    // shows the cause instead of "500 Internal Server Error".
    app.use((err, req, res, next) => {
        if (res.headersSent) return next(err);
        // Multer errors carry a code, not a status: too big is 413, the rest the caller's fault.
        const multerStatus = err.name === 'MulterError' ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : null;
        const status = multerStatus ?? (Number(err.status ?? err.statusCode) || 500);
        if (status >= 500) logger.error('unhandled error', { path: req.path, error: err.message, stack: err.stack });
        return res.status(status).json({ errors: [status >= 500 ? `Server error: ${err.message}` : err.message] });
    });
    return app;
}

async function handleInbound(state, message) {
    const saved = state.db.insertInbound(message);
    // A message id we already have is a redelivery (webhook retry, reconnect
    // replay): it was counted and answered the first time.
    if (!saved.isNew) return saved;
    // Every inbound message belongs to a conversation, whether or not anyone is
    // watching the inbox. Created here because this is the one place every
    // transport's inbound converges.
    const conversation = state.conversations?.upsertForInbound({
        phone: saved.sender, channelId: state.channel.id, at: saved.receivedAt,
    });
    broadcast(state, { type: 'inbound_message', message: saved, conversationId: conversation?.id ?? null });
    // "spam" / "I will report you": a report in the making. Recorded with who and when; may pause the run.
    // Only from someone we really sent to: a stranger's text cannot be a report of us.
    if (COMPLAINT_WORDS.test(saved.body ?? '') && state.db.hasSentTo(saved.sender)) {
        const fresh = state.db.addSafetyEvent({
            kind: 'report', phone: saved.sender, messageId: saved.messageId ?? saved.id ?? '',
            detail: String(saved.body).slice(0, 160),
        });
        if (fresh) {
            broadcast(state, { type: 'safety_event', kind: 'report', phone: saved.sender });
            state.manager.checkBlockRate();
        }
    }
    try {
        const optOut = await processOptOut(state.db, state.transport, saved, state.platformPolicy()['autoReplies.optOutWords']);
        if (optOut.handled) {
            broadcast(state, { type: 'optout', sender: saved.sender, action: optOut.action });
            if (optOut.action === 'opted_out') state.manager.checkStopRate();
            return saved;
        }
        // An answer to a campaign's buttons/list (native tap or typed "1"):
        // counted, and the campaign's reply rules run. A rule that acted owns
        // the message; a click without a rule falls through to auto-replies.
        if ((await handleInteractiveReply(state, saved, message.replyId ?? null)).handled) return saved;
        // Opt-out is always honoured; auto-replies are a capability the
        // channel can be switched out of without going dark on STOP.
        if (!state.channel.capabilities.includes('auto_replies')) return saved;
        // The admin switched automations/sending off, or the message quota is used up: keep
        // the message, send nothing (the message service would refuse every reply, one inbound_error each).
        if (state.manager.sendBlock?.('auto_reply') ?? state.manager.capBlock?.()) return saved;
        // A human has the conversation: the bot does not talk over them. The
        // message service enforces this too, but returning early also skips the
        // typing delay and the FAQ lookup.
        if (state.conversations?.isBotPaused(saved.sender, state.channel.id)) return saved;

        // Menu answers, human handoff, welcome and away messages (autoreply/engine.js).
        // A text-only welcome/away comes back unsent as `early.greeting`: the
        // first stage below that answers puts it in front of its own text, so
        // the contact gets one message; handleInbound sends it alone otherwise.
        const early = await state.autoReply.handlePre({ ...saved, replyId: message.replyId ?? null });
        if (early.replies.some((r) => r.accepted)) {
            state.db.markInboundReplied(saved.messageId, early.replies.find((r) => r.accepted).source);
            broadcast(state, { type: 'auto_reply', sender: saved.sender, rule: early.replies.map((r) => r.ruleName).join(', ') });
        }
        if (early.handled) return saved;
        const { greeting } = early;
        const greet = (text) => state.autoReply.withGreeting(text, greeting);
        const greetingSent = () => state.autoReply.noteGreeting(saved, greeting);

        // HELP lists every keyword the customer can use, whichever engine owns it.
        if (isHelp(saved.body)) {
            const text = helpText(state);
            if (text) {
                const outcome = state.messages.send({
                    messageType: 'auto_reply', recipient: saved.sender, text: greet(text), idempotencyKey: `help.${saved.messageId}`,
                });
                if (outcome.accepted) {
                    greetingSent();
                    state.db.markInboundReplied(saved.messageId, 'help');
                    return saved;
                }
            }
        }

        // Parent keywords (ATTENDANCE, FEES, LEAVE...) before the FAQ; only a
        // number linked to a student is answered, everyone else falls through.
        const school = await handleSchoolCommand(state, saved, { greeting: greeting?.text ?? '' });
        if (school.handled) {
            if (school.sent) greetingSent();
            return saved;
        }

        // The knowledge base answers first and the keyword engine is the
        // fallback, so an operator migrates at their own pace: with no FAQ
        // items the match is always null and behaviour is unchanged.
        // Platform: FAQ answers need autoReplies.allowAi, and respect quiet hours.
        const faqOn = state.platformPolicy()['autoReplies.allowAi'] !== false && !state.autoReply.quiet();
        const hit = faqOn ? state.knowledge?.answer(saved.body, { channel: state.channel }) : null;
        if (hit?.item) {
            const outcome = state.messages.send({
                messageType: 'auto_reply',
                recipient: saved.sender,
                text: greet(hit.item.answer),
                idempotencyKey: `faq.${saved.messageId}.${hit.item.id}`,
            });
            if (outcome.accepted) {
                greetingSent();
                state.db.markInboundReplied(saved.messageId, `faq:${hit.item.id}`);
                broadcast(state, {
                    type: 'faq_reply', sender: saved.sender, itemId: hit.item.id, level: hit.level,
                });
                return saved;
            }
        }
        const reply = await state.autoReply.handleInbound(saved, { greeted: early.greeted, greeting });
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
        qrExpiresAt: state.qr ? transport?.qrExpiresAt ?? null : null,
        paused: state.paused?.() ?? null,
    };
}

const digitsOf = (phone) => String(phone ?? '').replace(/\D/g, '');

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
