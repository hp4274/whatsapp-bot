/**
 * Campaign engine: contact -> personalise -> queue -> rate limit -> transport
 * -> status update.
 *
 * One worker drains the queue, so ordering stays FIFO and the rate limiter has
 * a single place to enforce the configured send rate.  Every state change is
 * written to SQLite and emitted for the browser.
 */

import { ErrorCode, FRIENDLY, friendlyError, normalizeError } from '../messaging/errors.js';
import { normalizeInteractive, personalizeInteractive } from '../messaging/interactive.js';
import { renderMessage, withFallbacks } from './importer.js';
import { EventEmitter } from 'node:events';

import {
    STATUS_RANK,
    SUCCESS_STATUSES,
    Status,
    contactContext,
    personalize,
} from '../protocol.js';
import { NOT_ON_WHATSAPP_CODE, TransportConnectionError, TransportError } from '../transports/base.js';
import { RateLimiter, RetryPolicy, interruptibleSleep } from './limits.js';
import { MessageQueue, QueueState, queueItem } from './queue.js';
import {
    DailyQuota, SafetyError, estimateSeconds, nextDelay, paceFor, pickPreset,
    qrVaryAbove, variationError,
} from './safety.js';
import { capReachedText } from '../policy/campaignOps.js';
import { logger, runDetached } from '../observability/logger.js';
import {
    BLOCK_SUSPECT_AFTER_SECONDS, HALTING_BRAKES, HALT_HOURS, HELD_TYPES, MEDIA_GAP_FACTOR,
    contactZone, contentError, dayPlan, deliveryBrakes, inQuiet, isDaytimeFor, quietExtraSeconds, quietStatus, shuffle, typingMs,
} from './humanize.js';
import { dayKey } from './spread.js';

const isoAgo = (ms) => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const between = (min, max) => min + Math.random() * (max - min);
/** opt_outs, bulk_mutes and recipients hold bare digits; a sheet's phone may carry '+' or spaces. */
const digits = (phone) => String(phone ?? '').replace(/\D/g, '');
/** Someone is waiting on these: the daily cap counts them but never pauses the queue for them. */
const QUOTA_EXEMPT = new Set(['auto_reply', 'transactional']);
/** Bulk: waits for the recipient's daytime, and on a QR number for the hourly and new-chat budgets. */
const HELD = new Set(HELD_TYPES);
/** How often a daily-cap pause looks whether the budget has room again (it lifts itself). */
const QUOTA_RECHECK_MS = 30_000;
/** HH:MM on the channel's clock, for "sending continues at ...". */
const clockAt = (iso, zone) => new Intl.DateTimeFormat('en-GB', {
    ...(zone ? { timeZone: zone } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(iso));
/**
 * Registration answers are kept a day (accounts come and go slowly); an
 * unknown one (the check failed) only 10 minutes, so a hiccup is retried soon
 * without asking again for every message in between.
 */
const REGISTERED_TTL_MS = 24 * 3600_000;
const UNKNOWN_TTL_MS = 10 * 60_000;
/** Numbers asked about in one go: this message's and the next unchecked ones in the queue. */
const CHECK_AHEAD = 50;
/** A campaign pauses itself past this STOP rate, judged from this many people reached (checkStopRate). */
const STOP_PAUSE = Object.freeze({ percent: 3, minDelivered: 50 });
/** How often a connected number's block, delivery and stuck checks run (scanHealthIfDue). */
const HEALTH_SCAN_MS = 600_000;
/** The dead-man ops alert: messages waiting in sending hours and nothing sent for this long. */
export const DEAD_MAN_MS = 6 * 3_600_000;
/** A message stuck at 48h counts as a block only while the number delivered at least this share then. */
const BLOCK_MIN_DELIVERED = 0.95;
/** WhatsApp said rate-overlimit (429): the next try waits at least this long (seconds). */
const RATE_LIMIT_WAIT = [90, 120];
export const NOT_ON_WHATSAPP_TEXT = FRIENDLY[ErrorCode.INVALID_RECIPIENT];
/** From this level a QR number has no one-a-day limit per recipient; nor does one whose questions were skipped. */
export const FREE_RECIPIENT_LEVEL = 5;

/**
 * Bulk messages one recipient may get in a rolling 24h (0 = no limit). `level`: allowance().level on a
 * QR number with sending safety on, else null (the business's recipientDailyCap applies).
 */
export const recipientCap = (config, level) => {
    if (config.safetyEnabled === false) return 0;
    if (!level) return Number(config.recipientDailyCap) || 0;
    return level.level >= FREE_RECIPIENT_LEVEL || level.start?.answers?.skipped ? 0 : 1;
};

export class CampaignManager extends EventEmitter {
    constructor(db, transport, config) {
        super();
        this.db = db;
        this.transport = transport;
        this.config = config;
        this.queue = new MessageQueue();
        this.rateLimiter = new RateLimiter(config.rateLimitPerSecond, config.rateLimitBurst);
        this.retryPolicy = RetryPolicy.fromConfig(config);
        this.campaignId = '';
        this.stats = { total: 0, successful: 0, failed: 0, processed: 0, skippedOptOut: 0, notOnWhatsapp: 0 };
        // phone -> { registered: true | false | null (unknown), at } (see checkRegistered).
        this.registry = new Map();
        this.worker = null;
        this.shuttingDown = false;
        this.inFlight = 0;

        // Sending safety: a daily ceiling, and a gap between messages that
        // varies with how many are going out.
        this.quota = new DailyQuota(db, config);
        this.restrictedCache = null; // #restricted()
        // The budget resets at midnight on the channel's clock (`timezone` is set by the channel runtime).
        this.quota.zone = () => this.timezone?.() || null;
        this.pacePreset = 'balanced';   // 'safe' | 'balanced' | 'fast'
        this.pace = paceFor(0, config, 'balanced', this.quota.tier());
        // Real sends since this number last rested, across runs (#restartRestCount): back-to-back small campaigns
        // must still take the long pause. Named for the run it once was.
        this.sentInRun = 0;
        this.nextRestAt = null;     // sentInRun at which the next long rest starts (jittered)
        this.restDay = null;        // the local day sentInRun counts in
        this.afterReconnect = false;
        this.lastHealthScan = 0;
        this.seed = `${db.tenantId ?? 1}:${db.channelId ?? 0}`;
        this.waitingUntil = null;   // when the next message may go (ms epoch)
        this.pausedByQuota = false;
        this.quotaCheckedAt = 0;    // last time a daily-cap pause looked for room (#pastQuotaPause)
        // Last send attempt or lookup (ms epoch). A QR number's gap counts from it, or the db's last send.
        this.lastActionAt = 0;
        // Set by the channel runtime: () => true while bulk may go out now
        // (sending window + quiet hours). Bulk outside it waits, it does not fail.
        this.bulkWindowOpen = null;
        // Set by the channel runtime: () => the channel's IANA timezone (rest windows follow its clock).
        this.timezone = null;
        this.holding = false;
        // Platform policy hooks, set by policy/campaignOps.js attachCampaignPolicy.
        this.bulkPolicy = null;        // () => rules (caps, opt-in, speed ceiling, ...)
        this.killSwitch = null;        // () => reason text while bulk must stop, else null
        this.sendBlock = null;         // (messageType) => reason while a tenant control holds that traffic, else null
        this.policyWindowOpen = null;  // () => false outside the platform's sending hours
        this.stopReason = 'Stopped by operator';
        this.resumeRefusal = null;     // why a policy hold cannot be resumed yet
        // Set by the channel runtime when PUBLIC_BASE_URL is known: a links/store.js LinkStore.
        this.links = null;
        this.current = null;
    }

    applyConfig(config) {
        this.config = config;
        this.rateLimiter.setRate(config.rateLimitPerSecond, config.rateLimitBurst);
        this.retryPolicy = RetryPolicy.fromConfig(config);
        this.quota.config = config;
        this.quota.invalidate();
        this.pace = this.#paceFor(this.pace.batchSize, this.pacePreset);
    }

    /** Whether WhatsApp restricts this number now; read at most every 30s (`restrictedCache = null` re-reads). */
    #restricted() {
        const t = Date.now();
        if (!this.restrictedCache || t - this.restrictedCache.at > 30_000) {
            this.restrictedCache = { at: t, until: this.db.restrictedUntil?.() ?? null };
        }
        return Date.parse(this.restrictedCache.until ?? '') > t;
    }

    /** A QR number with safety on and a real transport: sending levels govern every send. */
    #onLevels() {
        return this.quota.qr && this.config.safetyEnabled && Boolean(this.transport?.realDelivery);
    }

    #paceFor(batchSize, preset) {
        return paceFor(batchSize, this.config, preset, this.quota.tier());
    }

    /**
     * `pacingMode: 'fixed'` (rate limit only) applies off a level only. A QR number always runs on a level row
     * (its own, or its plan's after leaving safety), and safety comes from sending less, so the policy cannot
     * switch its gaps off. The one exception is the test run (humanTiming false, WHATSAPP_SENDER_FAST=1, which
     * no tenant or admin can set): its fake live numbers would otherwise wait real level gaps.
     */
    #fixedPace() {
        return this.config.pacingMode === 'fixed' && (!this.quota.qr || this.config.humanTiming === false);
    }

    /** Today's rhythm for this number (null when the tier system is off). */
    #dayPlan() {
        const tier = this.quota.tier();
        return tier ? this.#planFor(new Date(), tier) : null;
    }

    /** A super admin let this tenant send through quiet time (policy sending.skipQuietTime). */
    #skipQuiet() {
        return this.quota.tables?.().skipQuiet === true;
    }

    #planFor(at, tier = this.quota.tier()) {
        return dayPlan(this.seed, tier, at, this.timezone?.() || null);
    }

    /** Change the speed preset of the current run (live): recomputes the gap range. */
    setPace(preset, batchSize = this.pace.batchSize) {
        // Under platform policy the plan sets the speed; the requested preset only counts without one.
        this.pacePreset = this.bulkPolicy?.()?.maxSpeed ?? pickPreset(preset);
        this.pace = this.#paceFor(batchSize, this.pacePreset);
        this.#emitStats();
        return this.pace;
    }

    setTransport(transport) {
        this.transport = transport;
        this.registry.clear();   // unknowns from the old transport must not stick
        this.quota.invalidate();
    }

    /**
     * Which of these numbers are on WhatsApp: phone -> true | false | null.
     * null is unknown (no check on this transport, or it failed) and is sent
     * to as before. Answers are remembered (see REGISTERED_TTL_MS), so the
     * quick send and the worker never ask twice about the same number.
     */
    async checkRegistered(phones) {
        const answers = new Map();
        const ask = [];
        for (const phone of new Set(phones)) {
            const known = this.#registered(phone);
            if (known === undefined) ask.push(phone);
            else answers.set(phone, known);
        }
        if (!ask.length) return answers;
        if (!this.transport?.supportsRegistrationCheck) {
            for (const phone of ask) answers.set(phone, null);
            return answers;
        }
        let found = new Map();
        try {
            found = await this.transport.checkRegistered(ask) ?? new Map();
        } catch (err) {
            logger.warn('registration check failed, sending as usual', { error: String(err?.message ?? err) });
        }
        const at = Date.now();
        for (const phone of ask) {
            const registered = typeof found.get(phone) === 'boolean' ? found.get(phone) : null;
            this.registry.set(phone, { registered, at });
            answers.set(phone, registered);
        }
        return answers;
    }

    /** The remembered answer for a number, without asking WhatsApp: true | false | null, or undefined. */
    knownRegistered(phone) {
        return this.#registered(phone);
    }

    /** The remembered answer for a number, or undefined when it has to be asked. */
    #registered(phone) {
        const hit = this.registry.get(phone);
        if (!hit) return undefined;
        if (Date.now() - hit.at > (hit.registered === null ? UNKNOWN_TTL_MS : REGISTERED_TTL_MS)) {
            this.registry.delete(phone);
            return undefined;
        }
        return hit.registered;
    }

    /**
     * Whether `item` belongs to the run the stats describe. Once a bulk run has started, a reply or quick send in the
     * same queue is someone's own message: counting it showed "12 of 12" for an 11-person campaign.
     */
    #ofRun(item) {
        return !this.campaignId || !QUOTA_EXEMPT.has(item.messageType);
    }

    statsSnapshot() {
        const byType = this.campaignId ? this.queue.pendingByType() : {};
        const oneOff = [...QUOTA_EXEMPT].reduce((n, type) => n + (byType[type] ?? 0), 0);
        return {
            ...this.stats,
            pending: this.queue.pending - oneOff,
            duplicates: this.queue.duplicatesRejected,
            state: this.queue.state,
            safety: this.safetyStatus(),
        };
    }

    /**
     * The next bulk messages in the order the worker takes them: the one in
     * flight, then those it would send now, then those waiting for their
     * recipient's morning (`later`). Names and text only, for the progress card.
     */
    upNext(limit = 5) {
        const ready = [];
        const later = [];
        for (const item of this.queue.snapshot()) {
            if (item.messageType !== 'campaign') continue;
            (this.#ready(item) ? ready : later).push(item);
        }
        const current = this.current?.messageType === 'campaign' ? [this.current] : [];
        return [...current, ...ready, ...later].slice(0, limit).map((item) => ({
            messageId: item.messageId,
            name: item.name,
            recipient: item.recipient,
            message: item.message,
            sending: item === this.current,
            later: later.includes(item),
        }));
    }

    /** Everything the UI needs to explain the pacing and the daily budget. */
    safetyStatus(batchSize = this.pace.batchSize, preset = this.pacePreset) {
        // The plan's speed wins over the one asked for, as it does for the run itself (enqueueContacts, setPace).
        const pace = this.#paceFor(batchSize, this.bulkPolicy?.()?.maxSpeed ?? pickPreset(preset));
        // Only windows that hold bulk (#resting): none after leaving safety or with quiet time skipped.
        const plan = this.#quietApplies() ? this.#dayPlan() : null;
        return {
            quiet: plan ? quietStatus(plan) : null,
            ...this.quota.status(),
            pacingMode: this.#fixedPace() ? 'fixed' : 'adaptive',
            pacing: pace.preset,
            minSeconds: pace.minSeconds,
            maxSeconds: pace.maxSeconds,
            restEvery: pace.restEvery,
            restMinMinutes: pace.restMinSeconds / 60,
            restMaxMinutes: pace.restMaxSeconds / 60,
            estimateSeconds: this.#estimate(batchSize, pace),
            waitingSeconds: this.waitingUntil
                ? Math.max(0, Math.round((this.waitingUntil - Date.now()) / 1000))
                : 0,
            pausedByQuota: this.pausedByQuota,
            heldForQuietHours: this.holding,
        };
    }

    /**
     * Send estimate with the nightly rest it would run into added in; `quietSeconds` says how much.
     * `days` / `finishesOn` (local YYYY-MM-DD): today's budget, then the daily limit at today's level
     * (never a level-up). Null when there is no daily cap.
     */
    #estimate(batchSize, pace) {
        const est = estimateSeconds(batchSize, pace);
        const left = this.quota.remaining();
        const perDay = this.quota.planLimit();
        const days = !batchSize ? 0 : (Number.isFinite(left) && perDay > 0 ? 1 + Math.ceil(Math.max(0, batchSize - left) / perDay) : null);
        const finish = {
            days,
            finishesOn: days ? dayKey(new Date(Date.now() + (days - 1) * 86_400_000), this.timezone?.() || null) : null,
        };
        const tier = this.quota.tier();
        if (!tier || !this.transport?.realDelivery || !this.config.safetyEnabled || this.config.humanTiming === false || this.#skipQuiet() || est.typical <= 0) {
            return { ...est, quietSeconds: 0, ...finish };
        }
        const quietSeconds = quietExtraSeconds((at) => this.#planFor(at, tier), est.typical);
        return { min: est.min + quietSeconds, max: est.max + quietSeconds, typical: est.typical + quietSeconds, quietSeconds, ...finish };
    }

    #emitStats() {
        this.emit('event', { type: 'stats', stats: this.statsSnapshot() });
    }

    // ------------------------------------------------------------ queueing --
    /**
     * Personalise and queue a batch. Returns {queued, skipped}.
     *
     * With `onePerNumber` each number is messaged once per run: repeats inside
     * this batch are dropped whatever name they carry. A number messaged in an
     * earlier run is NOT skipped, so the same sheet can be sent again.
     *
     * The batch is shuffled: nobody is messaged in the order of the sheet. People who wrote in before go first.
     */
    enqueueContacts(contacts, template, {
        campaignId = null, onePerNumber = false, media = null, interactive = null,
        // Bulk Campaigns v2: per-variable fallback text and the speed preset.
        fallbacks = null, pacing = 'balanced',
        // A/B bodies [{key, body}] split evenly over the batch; tracked links (see links/store.js).
        variants = null, trackLinks = false,
        // A fresh run: queue.reset() options. Applied only after every refusal below, so a refused send keeps the live queue.
        reset = null,
    } = {}) {
        const versions = Array.isArray(variants) && variants.length ? variants : null;
        const tracking = Boolean(trackLinks && this.links);
        // Throws InteractiveError (status 400) before anything is queued.
        const block = normalizeInteractive(interactive, { carousel: true, keepMedia: true });
        // Platform policy (policy/campaignOps.js): refusals before anything is queued.
        const rules = this.bulkPolicy?.() ?? null;
        let skippedNoOptIn = 0;
        if (rules) {
            if (this.killSwitch?.()) throw new SafetyError('Bulk sending is switched off right now, so a new send cannot start.', 409);
            if (block && rules.allowInteractive === false) throw new SafetyError('Interactive buttons are not on your plan.', 403);
            const count = Array.isArray(contacts) ? contacts.length : 0;
            if (rules.maxRecipients && count > rules.maxRecipients) {
                throw new SafetyError(`A send can reach ${rules.maxRecipients} recipients on your plan; this one has ${count}.`, 403);
            }
            if (rules.notOptedIn) {
                const no = rules.notOptedIn();
                const kept = contacts.filter((c) => !no.has(digits(c?.phone)));
                skippedNoOptIn = contacts.length - kept.length;
                contacts = kept;
            }
            const cap = rules.capRemaining?.();
            if (cap?.expired) {
                throw new SafetyError('Your subscription has ended, so nothing can be sent. Contact your provider to renew.', 402);
            }
            if (cap && contacts.length > cap.left) {
                throw new SafetyError(`This send has ${contacts.length} recipients, but your business has only ${cap.left} `
                    + `messages left of its ${cap.period} cap of ${cap.cap}.`, 403);
            }
            // The plan's speed, whatever was asked for.
            pacing = rules.maxSpeed;
        }
        const bodies = versions ? versions.map((v) => v.body) : [template];
        // A QR number's level sets how much a campaign must vary.
        const levels = this.quota.qr && this.config.safetyEnabled !== false;
        const tables = this.quota.tables();
        const vary = levels ? { ...this.config, requireVariationAbove: qrVaryAbove(this.config, tables.qrVaryAbove) } : this.config;
        const unvaried = this.config.safetyEnabled === false ? null
            : bodies.map((body) => variationError(body, contacts, vary)).find(Boolean);
        if (unvaried) throw new SafetyError(unvaried);
        if (this.config.safetyEnabled !== false) {
            const own = (c) => String(c?.extra?.message ?? c?.extra?.custom_message ?? '');
            const texts = [...bodies, ...(Array.isArray(contacts) ? contacts.map(own) : [])];
            const refused = texts.map(contentError).find(Boolean);
            if (refused) throw new SafetyError(refused);
        }
        if (reset) {
            this.resetStats();
            this.queue.reset(reset);
            this.pausedByQuota = false;
        }
        this.campaignId = campaignId ?? crypto.randomUUID().replace(/-/g, '').slice(0, 12);
        // Per-recipient frequency cap: bulk only, rolling 24h, counted from the db (recipientCap).
        const perRecipient = recipientCap(this.config, levels ? this.quota.allowance?.().level ?? { level: 0 } : null);
        const recent = new Map();
        if (perRecipient && this.db.bulkCountsSince) {
            for (const [recipient, n] of this.db.bulkCountsSince(isoAgo(24 * 3600 * 1000))) {
                recent.set(digits(recipient), (recent.get(digits(recipient)) ?? 0) + n);
            }
        }
        let skippedFrequency = 0;
        const batch = Array.isArray(contacts) ? contacts.length : 0;
        this.pacePreset = pickPreset(pacing);
        this.pace = this.#paceFor(batch, this.pacePreset);
        // The rest count carries on from the last run: it restarts only after a real rest (#restartRestCount).
        let queued = 0;
        let skipped = 0;
        let skippedOptOut = 0;
        let skippedMuted = 0;
        let skippedNotOnWhatsapp = 0;
        let split = 0; // recipients given a version so far: the next one gets versions[split % n]
        const optedOut = new Set((this.db.getAllOptOuts?.() ?? []).map(digits));
        // Contacts a reply rule muted ("not now, ask me in 30 days").
        const muted = new Set([...(this.db.bulkMutedPhones?.() ?? [])].map(digits));
        // Numbers the history already says are not on WhatsApp: looking them up again spends a new chat and is a ban
        // signal, and the in-memory registry forgets them on a restart. Stored history only, never an up-front lookup:
        // checking a whole sheet at once is mass contact discovery, which gets numbers restricted.
        const dead = this.db.notOnWhatsappSince?.(contacts.map((c) => digits(c?.phone)), isoAgo(30 * 24 * 3600 * 1000))
            ?? new Set();

        // The flag only governs this batch: a later single send to one of these
        // numbers is a deliberate act, not a duplicate.
        const previousMode = this.queue.onePerRecipient;
        const previousDedupe = this.queue.dedupe;
        this.queue.onePerRecipient = onePerNumber;
        // Duplicates allowed means a repeated number with the same text is queued again too.
        this.queue.dedupe = onePerNumber;
        // One commit for the whole batch instead of one per recipient. COMMIT even on a throw: the rows already
        // written match items already in the queue, as they did when each row committed on its own.
        const sql = this.db.db;
        const ownTransaction = Boolean(sql?.exec) && !sql.isTransaction;
        if (ownTransaction) sql.exec('BEGIN');
        try {
            // People who wrote in before go first: their early replies keep the reply-rate brake away and they
            // use no new-chat budget, so strangers left at the end of the day wait for tomorrow's. Shuffled within each.
            const warm = this.config.safetyEnabled !== false ? this.db.inboundSenders?.() ?? new Set() : new Set();
            const order = shuffle([...contacts]);
            const warmFirst = [...order.filter((c) => warm.has(digits(c.phone))), ...order.filter((c) => !warm.has(digits(c.phone)))];
            for (const contact of warmFirst) {
                const phone = digits(contact.phone);
                if (optedOut.has(phone)) {
                    skipped += 1;
                    skippedOptOut += 1;
                    continue;
                }
                if (muted.has(phone)) {
                    skipped += 1;
                    skippedMuted += 1;
                    continue;
                }
                if (dead.has(phone)) {
                    skipped += 1;
                    skippedNotOnWhatsapp += 1;
                    continue;
                }
                if (perRecipient && (recent.get(phone) ?? 0) >= perRecipient) {
                    skipped += 1;
                    skippedFrequency += 1;
                    continue;
                }
                // A `message` column in the sheet gives that number its own text;
                // everyone else gets the shared template.
                const own = String(contact.extra?.message ?? contact.extra?.custom_message ?? '').trim();
                // Round-robin over the (already shuffled) batch: an even split. A sheet's own text is no version.
                const version = versions && !own ? versions[split % versions.length] : null;
                let message = renderMessage(own || (version?.body ?? template), contact, fallbacks ?? {});
                // Rewritten here, before the row is written: a retry or a restart resends the stored text, same codes.
                const tracked = tracking ? this.links.rewrite(message) : null;
                if (tracked) message = tracked.text;
                // The STOP line is the campaign's own choice (the web's "Add opt-out line" box puts it in the text);
                // a STOP reply is handled by autoreply/optout.js either way.
                const item = queueItem({
                    recipient: contact.phone,
                    message,
                    name: contact.name ?? '',
                    campaignId: this.campaignId,
                    media,
                    interactive: personalizeInteractive(block, withFallbacks(contactContext(contact), fallbacks ?? {})),
                    variant: version?.key ?? null,
                    timezone: contactZone(contact.extra),
                });
                if (this.#enqueueItem(item)) {
                    queued += 1;
                    if (version) split += 1;
                    if (tracked?.links.length) {
                        this.links.save(tracked.links, { campaignId: this.campaignId, messageId: item.messageId, recipient: item.recipient });
                    }
                    if (perRecipient) recent.set(phone, (recent.get(phone) ?? 0) + 1);
                } else skipped += 1;
            }
        } finally {
            if (ownTransaction) sql.exec('COMMIT');
            this.queue.onePerRecipient = previousMode;
            this.queue.dedupe = previousDedupe;
        }

        this.stats.total += queued;
        this.stats.skippedOptOut += skippedOptOut;
        this.#emitStats();
        // Say up front how much of this batch today's budget actually covers.
        const remaining = this.quota.remaining();
        const policyNotes = [];
        if (skippedNoOptIn) policyNotes.push(`${skippedNoOptIn} contacts were skipped because they have not opted in.`);
        return {
            queued,
            skipped: skipped + skippedNoOptIn,
            skippedNoOptIn,
            pacingClamped: null, // kept for older clients; the plan now sets the speed outright
            policyNotes,
            skippedOptOut,
            skippedFrequency,
            skippedMuted,
            skippedNotOnWhatsapp,
            campaignId: this.campaignId,
            safety: this.safetyStatus(queued),
            overQuota: Number.isFinite(remaining) ? Math.max(0, queued - remaining) : 0,
        };
    }

    /**
     * Queue a message job (Phase 3).  This is the entry point the message
     * service uses, so campaigns, auto-replies, reminders and workflows all
     * land in the same queue under the same pacing, retries and daily cap.
     *
     * @returns {string|null} the message id, or null if the queue deduped it
     */
    enqueueJob(job) {
        const item = queueItem({
            recipient: job.recipient,
            message: job.text,
            name: job.name,
            // Not this.campaignId: that is the last bulk run, and a later quick send is not part of it.
            campaignId: job.campaignId || job.messageType,
            media: job.media,
            messageType: job.messageType,
            priority: job.priority,
            idempotencyKey: job.idempotencyKey,
            interactive: job.interactive ?? null,
            variant: job.variant ?? null,
            timezone: job.timezone ?? null,
        });
        if (!this.#enqueueItem(item)) return null;
        if (this.#ofRun(item)) this.stats.total += 1;
        this.#emitStats();
        return item.messageId;
    }

    /**
     * Put a run back after a restart. The queue lives in memory, but the rows it
     * held are still QUEUED in the db: queue them again under their own ids
     * (nothing is inserted) and rebuild the counters from what the db already
     * counts, so the run carries on where it stopped instead of reading 0 / N.
     *
     * @param {{campaignId: string, jobs: object[], sent: number, failed: number, paused?: boolean, pacing?: string}} run
     * @returns {number} how many were queued
     */
    restoreRun({ campaignId, jobs, sent = 0, failed = 0, notOnWhatsapp = 0, paused = false, pacing = 'balanced' }) {
        this.queue.reset();
        this.pausedByQuota = false;
        this.resumeRefusal = null;
        this.stopReason = 'Stopped by operator';
        this.campaignId = campaignId;
        // A repeated number is a row of its own when "skip duplicates" was off.
        const dedupe = this.queue.dedupe;
        this.queue.dedupe = false;
        let queued = 0;
        for (const job of jobs) {
            const item = queueItem({
                recipient: job.recipient, message: job.text, name: job.name, campaignId,
                media: job.media, interactive: job.interactive ?? null,
                variant: job.variant ?? null, timezone: job.timezone ?? null,
            });
            item.messageId = job.messageId;
            item.attempt = job.attempt ?? 0;
            if (this.queue.put(item)) queued += 1;
        }
        this.queue.dedupe = dedupe;
        this.stats = {
            total: queued + sent + failed + notOnWhatsapp, successful: sent, failed,
            processed: sent + failed + notOnWhatsapp, skippedOptOut: 0, notOnWhatsapp,
        };
        this.setPace(pacing, queued);
        if (paused) this.queue.pause();
        this.start();
        return queued;
    }

    /** Queue depth broken down by what produced each item. */
    pendingByType() {
        return this.queue.pendingByType();
    }

    #enqueueItem(item) {
        if (!this.queue.put(item)) return false;
        const record = this.db.insert({
            messageId: item.messageId,
            recipient: item.recipient,
            message: item.message,
            status: Status.QUEUED,
            name: item.name,
            campaignId: item.campaignId,
            messageType: item.messageType,
            idempotencyKey: item.idempotencyKey,
            variant: item.variant ?? null,
        });
        this.emit('event', { type: 'message', record });
        return true;
    }

    // ------------------------------------------------------------ controls --
    start() {
        // A paused queue stays paused: start only reopens a stopped queue and
        // makes sure the worker is alive. Resume is its own command.
        if (this.queue.isStopped) this.queue.reset();
        this.shuttingDown = false;
        // Detached: the loop is often first started by some request, and outlives it by days.
        if (!this.worker) {
            const context = { tenantId: this.db.tenantId ?? null, channelId: this.db.channelId ?? null };
            this.worker = runDetached(context, () => this.#run()).finally(() => { this.worker = null; });
        }
        this.#emitStats();
    }

    pause() {
        this.heldForLink = false; // set by the channel runtime after a ban; an operator's pause owns it from here
        this.pausedByQuota = false; // nor does a daily-cap pause lift itself any more
        this.queue.pause();
        this.#emitStats();
    }

    resume() {
        this.heldForLink = false;
        if (this.resumeRefusal) {
            const cap = this.bulkPolicy?.()?.capRemaining?.();
            if (cap && cap.left <= 0) {
                this.emit('event', { type: 'policyHold', reason: this.resumeRefusal });
                return false;
            }
            this.resumeRefusal = null;
        }
        if (this.pausedByQuota && this.quota.exhausted()) {
            // Resuming into an exhausted budget would just re-pause.
            this.emit('event', { type: 'quotaReached', ...this.quota.status(), message: this.#quotaText() });
            this.#emitStats();
            return false;
        }
        this.pausedByQuota = false;
        this.queue.resume();
        this.#emitStats();
        return true;
    }

    /**
     * Stop the bulk run and cancel its waiting rows. A reply or a quick send waiting in the same queue is someone's
     * own message, not the run's: it keeps its place, and the queue reopens once the message in flight has seen the
     * stop (a stopped queue would otherwise turn every later reply away until some run started).
     */
    stop(reason = 'Stopped by operator') {
        this.stopReason = reason;
        const waiting = this.queue.stop();
        const kept = waiting.filter((item) => QUOTA_EXEMPT.has(item.messageType));
        const dropped = waiting.filter((item) => !QUOTA_EXEMPT.has(item.messageType));
        for (const item of dropped) {
            this.db.updateStatus(item.messageId, Status.CANCELLED,
                { attempt: item.attempt, error: reason });
        }
        // A number held until it is linked again keeps holding: its replies wait for the relink, not the NullTransport.
        this.#reopenWhenIdle(kept, this.heldForLink);
        this.emit('event', { type: 'historyDirty' });
        this.#emitStats();
        return dropped.length;
    }

    #reopenWhenIdle(kept, held) {
        if (this.shuttingDown) return;
        if (this.queue.isStopped && this.inFlight) {
            setTimeout(() => this.#reopenWhenIdle(kept, held), 100).unref?.();
            return;
        }
        if (this.queue.isStopped) {
            this.start();
            if (held) this.queue.pause();
        }
        // Something may have reopened the queue first (a new run, a recovery): the kept messages still go back in.
        const queued = new Set(this.queue.snapshot().map((item) => item.messageId));
        for (const item of kept) if (!queued.has(item.messageId)) this.queue.putLast(item);
    }

    resetStats() {
        this.stopReason = 'Stopped by operator';
        this.resumeRefusal = null;
        this.stats = { total: 0, successful: 0, failed: 0, processed: 0, skippedOptOut: 0, notOnWhatsapp: 0 };
        this.#emitStats();
    }

    async shutdown() {
        this.shuttingDown = true;
        this.queue.stop();
        if (this.worker) await this.worker;
    }

    // -------------------------------------------------------------- worker --
    async #run() {
        while (!this.shuttingDown) {
            const item = this.queue.get((candidate) => this.#ready(candidate)) ?? this.#pastQuotaPause();
            if (!item) {
                if (this.queue.isStopped && !this.shuttingDown) {
                    // Stopped, but stay alive for the next campaign.
                    await interruptibleSleep(0.1, () => this.shuttingDown);
                    continue;
                }
                // Items waiting on a retry timer or on their owner's morning poll slowly.
                await interruptibleSleep(this.queue.pending ? 1 : 0.15, () => this.shuttingDown);
                continue;
            }
            await this.#process(item);
        }
    }

    /**
     * A quota pause holds bulk only: a reply that arrives after it still goes
     * out (and counts toward the day). An operator's pause holds everything.
     * It lifts itself once the budget has room again (the next day, or the end
     * of a new number's rest); an operator's pause (which clears the flag) does not.
     */
    #pastQuotaPause() {
        if (!this.pausedByQuota || !this.queue.isPaused) return null;
        if (!this.heldForLink && this.transport?.isConnected?.() && Date.now() - (this.quotaCheckedAt ?? 0) > QUOTA_RECHECK_MS) {
            this.quotaCheckedAt = Date.now();
            // A business cap still reached: resume() would only refuse again, and announce it every recheck.
            const capped = this.resumeRefusal && (this.bulkPolicy?.()?.capRemaining?.()?.left ?? 1) <= 0;
            if (!capped && !this.quota.exhausted() && this.resume()) {
                this.emit('event', { type: 'holdLifted', campaignId: this.campaignId });
                return null;
            }
        }
        // ponytail: the queue has no "take while paused"; reopen it for one synchronous pick.
        this.queue.resume();
        const item = this.queue.get((candidate) => QUOTA_EXEMPT.has(candidate.messageType) && this.#ready(candidate));
        this.queue.pause();
        return item;
    }

    /**
     * Can this item go now? A retry waits out its 5-10s timer, and bulk to a
     * number whose local time is outside 9:00-21:00 waits for their morning:
     * it stays queued while everyone else goes first. On a QR number bulk also
     * waits for the hourly budget, and a message to someone this number never
     * talked to (bulk or transactional) for the new-chat budget; replies and
     * people who know the number keep flowing. The budgets refill by themselves: no pause, no resume.
     * A tenant control switched off (sendBlock) holds queued non-campaign items
     * until it is back on; a campaign stops instead (killSwitch).
     */
    #ready(item) {
        if ((item.notBefore ?? 0) > Date.now()) return false;
        // WhatsApp's own restriction (463), safety on or off: it refuses anyone who never wrote to this number, even
        // people we messaged before, so they wait for it to lift instead of failing one after another.
        if (this.quota.qr && this.transport?.realDelivery && !String(item.recipient).includes('@') && this.#restricted()
            && !(item.wrote ??= Boolean(this.db.wroteIn?.(digits(item.recipient))))) return false;
        if (item.messageType !== 'campaign' && this.sendBlock?.(item.messageType)) return false;
        const held = HELD.has(item.messageType);
        // Every held type on a QR number; elsewhere campaigns only, so a school's early notice is not held till 9.
        const daytime = item.messageType === 'campaign' || (held && this.#onLevels());
        if (daytime && this.transport?.realDelivery && this.config.safetyEnabled && this.config.humanTiming !== false) {
            const { daytimeFrom: from, daytimeTo: to } = this.quota.tables().brakes;
            if (!isDaytimeFor(item.recipient, new Date(), { from, to, zone: item.timezone })) return false;
        }
        if (!this.#onLevels() || !(held || item.messageType === 'transactional')) return true;
        const { budgets } = this.quota.allowance();
        // Bulk with nothing left today goes on to #quotaBlocked, which pauses the run and says until when.
        if (held && budgets.bulk.left <= 0) return true;
        if (held && budgets.hour.left <= 0) return false;
        // Lazily, here: restored, recovered and retried items are covered too.
        // shortcut: `cold` is read once; someone who writes in after that still waits for a new chat. Re-read it if that matters.
        return budgets.newChats.left > 0 || !(item.cold ??= this.#cold(item));
    }

    /** Nobody here: never sent to, never wrote in. A group (jid) is not a stranger. */
    #cold(item) {
        return !String(item.recipient).includes('@') && Boolean(this.db.isCold?.(digits(item.recipient)));
    }

    /** Whether today's rest windows hold bulk at all: safety on, human timing on, quiet time not skipped. */
    #quietApplies() {
        return Boolean(this.config.safetyEnabled) && this.config.humanTiming !== false && !this.#skipQuiet();
    }

    /** Our own rest window for today (bulk only; replies are never held). */
    #resting() {
        if (!this.#quietApplies()) return false;
        const plan = this.#dayPlan();
        return Boolean(plan && inQuiet(plan));
    }

    #stopped() {
        // Kill switch: a bulk run stops mid-wait, not after its next long pause.
        if (!this.queue.isStopped && this.current?.messageType === 'campaign') {
            const kill = this.killSwitch?.();
            if (kill) {
                const campaignId = this.current.campaignId;
                this.stop(kill);
                this.emit('event', { type: 'policyStop', reason: kill, campaignId });
            }
        }
        return this.shuttingDown || this.queue.isStopped;
    }

    /**
     * Wait out the adaptive gap before the next real send.
     * Returns false if the campaign stopped while waiting.
     */
    async #paceBeforeSend(item) {
        // A reply to someone who just wrote in is not bulk traffic: no gap.
        if (item?.messageType === 'auto_reply') return true;
        // A QR number that left sending safety is still paced, at its plan's level and speed (DailyQuota.tier).
        const adaptive = (this.config.safetyEnabled || this.quota.qr) && !this.#fixedPace();
        // Sandbox sends never leave the machine, so they are not paced.
        if (!adaptive || !this.transport?.realDelivery) return true;

        const { seconds, resting } = this.#nextGap(item);
        if (seconds <= 0) return true;
        this.waitingUntil = Date.now() + seconds * 1000;
        this.emit('event', {
            type: 'pacing',
            seconds: Math.round(seconds),
            resting,
            reason: resting ? 'resting between batches' : 'spacing messages',
        });
        this.#emitStats();
        // Not always online: during a long gap, go offline now and then (the
        // transport comes back online when the next message starts typing).
        if (seconds > 25 && Math.random() < 0.6) void this.transport.setPresence?.('unavailable');
        const finished = await interruptibleSleep(seconds, () => this.#stopped());
        this.waitingUntil = null;
        return finished;
    }

    /**
     * The gap before this send. Drawn at random from the tier's range, scaled
     * by today's multiplier (so no two days have the same rhythm), stretched
     * for media, and every so often a long rest at a jittered interval.
     * On a QR number it counts from the number's last real send or lookup, not
     * from the run: a new run, a restore or a restart does not fire at once,
     * and one send after a quiet spell still goes straight away.
     */
    #nextGap(item) {
        const levels = this.#onLevels();
        // A level moves mid-run (a brake, a level-up): its pace follows on every send.
        if (levels) this.pace = this.#paceFor(this.pace.batchSize, this.pacePreset);
        const pace = this.pace;
        this.#restartRestCount(pace);
        if (this.sentInRun <= 0 && !levels) return { seconds: 0, resting: false };
        let gap = null;
        if (pace.restEvery > 0 && this.sentInRun > 0) {
            this.nextRestAt ??= this.sentInRun + Math.max(1, Math.round(pace.restEvery * between(0.7, 1.3)));
            if (this.sentInRun >= this.nextRestAt) {
                this.nextRestAt = this.sentInRun + Math.max(1, Math.round(pace.restEvery * between(0.7, 1.3)));
                gap = { seconds: between(pace.restMinSeconds, pace.restMaxSeconds), resting: true };
            }
        }
        if (!gap) {
            let { seconds } = nextDelay({ ...pace, restEvery: 0 }, Math.max(1, this.sentInRun));
            seconds *= this.#dayPlan()?.gapFactor ?? 1;
            // A carousel goes out as several captioned images: as heavy as media.
            if (item.media || item.interactive?.type === 'carousel') seconds *= MEDIA_GAP_FACTOR;
            gap = { seconds, resting: false };
        }
        if (!levels) return gap;
        const last = Math.max(Date.parse(this.quota.allowance().lastSentAt ?? '') || 0, this.lastActionAt ?? 0);
        return { ...gap, seconds: Math.max(0, gap.seconds - (Date.now() - last) / 1000) };
    }

    /**
     * The rest count belongs to the number, not the run, so three 5-message campaigns back to back still take
     * the long pause a 15-message one would. It starts again once the number really rested: a new local day, or
     * no send or lookup for at least the shortest rest. shortcut: in memory, so a restart also starts it again.
     */
    #restartRestCount(pace) {
        const now = Date.now();
        const day = dayKey(new Date(now), this.timezone?.() || null);
        const idle = this.lastActionAt ? (now - this.lastActionAt) / 1000 : Infinity;
        // At least a minute, so a rate-limiter wait or a slow send never passes for a rest.
        if (day !== this.restDay || idle >= Math.max(60, pace.restMinSeconds)) {
            this.sentInRun = 0;
            this.nextRestAt = null;
        }
        this.restDay = day;
    }

    /** After a drop the first send waits 20-90s, so the pool eases back in. */
    async #settleAfterReconnect() {
        if (!await this.#waitForConnection()) return false;
        this.emit('event', { type: 'pacing', seconds: 0, resting: true, reason: 'reconnected - easing back in' });
        return interruptibleSleep(between(20, 90), () => this.#stopped());
    }

    async #waitForConnection(limitSeconds = 1800) {
        const end = Date.now() + limitSeconds * 1000;
        while (!this.transport?.isConnected?.()) {
            if (Date.now() > end) return false;
            if (!await interruptibleSleep(1, () => this.#stopped())) return false;
        }
        return true;
    }

    // ------------------------------------------------------ block / report --
    /**
     * A campaign message still on one tick is judged once, at 48h (db.stuckSent): a block only when the
     * recipient was silent in hours 24-48 and the number delivered at least 95% of its own sends then.
     * Below that the stuck brake owns it, so one incident trips one brake. Then the delivery and stuck brakes
     * (2-24h window), and a campaign pause if blocks and reports are too large a share of the week.
     * Runs every 10 minutes per connected number (app watchdog, scanHealthIfDue) and while sending.
     */
    scanHealth() {
        this.lastHealthScan = Date.now();
        if (!this.db.stuckSent) return;
        // Take back blocks that the phone has since disproved, before counting new ones.
        this.db.healBlocks?.();
        const judged = [];
        for (const m of this.db.stuckSent(new Date())) {
            // The transport may hold a receipt the database never got (it arrived mid-send).
            const known = m.providerId ? this.transport?.getStatus?.(m.providerId) : null;
            if (known && (STATUS_RANK[known] ?? 0) > STATUS_RANK.SENT && this.handleReceipt(m.providerId, known)) continue;
            judged.push(m.messageId);
            if (!m.quiet || !m.winSent || m.winDelivered / m.winSent < BLOCK_MIN_DELIVERED) continue;
            const fresh = this.db.addSafetyEvent({
                kind: 'block', phone: m.phone, messageId: m.messageId, campaignId: m.campaignId,
                detail: `Still one tick ${BLOCK_SUSPECT_AFTER_SECONDS / 3600} hours after sending while the number delivered to others: this person may have blocked the number.`,
            });
            if (fresh) this.emit('event', { type: 'safetyEvent', kind: 'block', phone: m.phone });
        }
        this.db.markBlockChecked?.(judged);
        if (this.quota.qr && this.db.deliveryWindow) {
            for (const b of deliveryBrakes(this.db.deliveryWindow(new Date()), this.quota.tables().brakes)) this.recordBrake(b.code, b.text);
        }
        this.checkBlockRate();
    }

    /** scanHealth when the last one is 10 minutes old: the app watchdog calls this for every connected number. */
    scanHealthIfDue() {
        if (Date.now() - this.lastHealthScan >= HEALTH_SCAN_MS) this.scanHealth();
    }

    /**
     * Start a halting brake (delivery, stuck, unstable) for HALT_HOURS, unless one is already running. With
     * `sending.brakesMode` 'shadow' (the default) it is only logged, as a safety_events row of kind 'shadow',
     * and sending never slows; with 'enforce' it is a kind 'brake' row that the ledger applies.
     * The code is the row's phone and its end the message_id. Returns true when a new row was written.
     */
    recordBrake(code, text) {
        if (!this.db.addSafetyEvent) return false;
        const kind = this.quota.tables().brakes?.brakesMode === 'enforce' ? 'brake' : 'shadow';
        if (this.db.activeBrake?.(kind, code)) return false;
        const until = new Date(Date.now() + HALT_HOURS[code] * 3_600_000).toISOString();
        if (!this.db.addSafetyEvent({ kind, phone: code, messageId: until, detail: text })) return false;
        this.opsAlert?.({ kind: code, shadow: kind === 'shadow', text: kind === 'shadow' ? `Shadow (not applied): ${text}` : text, detail: until });
        // A shadow row is for the admin view only: the business's page and budgets see nothing.
        if (kind === 'brake') {
            this.quota.invalidate();
            this.emit('event', { type: 'safetyEvent', kind, code, until });
        }
        return true;
    }

    /**
     * The dead-man check (ops alert): how long messages have waited in sending hours with nothing sent, once
     * that reaches DEAD_MAN_MS, else 0. Only an item that could go now counts: the queue paused (an operator
     * or the daily cap), bulk held (#bulkHeld: sending windows, a rest) or every item on a deliberate hold
     * (#ready: budgets, recipients' night, a restriction, a tenant control) restarts the wait, so a quiet
     * night or a reached cap never counts. The app's watchdog calls this every 30s; one stall reports at most
     * once an hour.
     */
    deadManIdleMs(now = Date.now()) {
        const bulkHeld = this.#bulkHeld();
        const waiting = !this.queue.isPaused && !this.queue.isStopped
            && this.queue.items.some((item) => !(item.messageType === 'campaign' && bulkHeld) && this.#ready(item));
        if (!waiting) {
            this.waitingSince = 0;
            this.deadManAlertedAt = 0;
            return 0;
        }
        this.waitingSince ||= now;
        const lastSent = Date.parse(this.quota.allowance?.().lastSentAt ?? '') || 0;
        const idle = now - Math.max(this.waitingSince, lastSent, this.lastActionAt ?? 0);
        if (idle < DEAD_MAN_MS || now - (this.deadManAlertedAt || 0) < 3_600_000) return 0;
        this.deadManAlertedAt = now;
        return idle;
    }

    /** Blocks + reports (people) over real sends in 7 days. */
    healthRates() {
        const since = isoAgo(7 * 86_400_000);
        const counts = this.db.safetyEventCounts?.(since) ?? {};
        const sent = this.db.countSentBetween(since, isoAgo(-60_000));
        const pct = (n) => (sent ? Math.round((n / sent) * 1000) / 10 : 0);
        const blocks = counts.block ?? 0;
        const reports = counts.report ?? 0;
        const pauseAtPercent = this.quota.tables().blockPausePercent;
        return { sent7d: sent, blocks, reports, blockRatePercent: pct(blocks), reportRatePercent: pct(reports), pauseAtPercent };
    }

    /** Pauses a running campaign when blocks + reports pass the limit. Returns true when it paused. */
    checkBlockRate() {
        const rates = this.healthRates();
        const over = rates.blockRatePercent + rates.reportRatePercent >= rates.pauseAtPercent;
        if (!over || rates.sent7d < this.quota.tables().blockPauseMinSent || this.queue.isPaused || this.queue.isStopped) return false;
        // The admin turned this number's brakes off (policy/channelOps.js).
        if (this.quota.qr && this.quota.allowance().level.brakesOff) return false;
        this.queue.pause();
        this.emit('event', {
            type: 'failureStop', failed: rates.blocks + rates.reports, processed: rates.sent7d,
            message: `Paused: ${rates.blocks} blocks and ${rates.reports} reports from ${rates.sent7d} messages this week (limit ${rates.pauseAtPercent}%).`,
        });
        this.#emitStats();
        return true;
    }

    /**
     * Pauses the running campaign when over STOP_PAUSE.percent of the people it reached replied STOP, from
     * STOP_PAUSE.minDelivered: the message is unwelcome. The block-rate pause sees this a week late; this, within hours.
     */
    checkStopRate() {
        if (!this.campaignId || !this.config.safetyEnabled || this.queue.isPaused || this.queue.isStopped || !this.db.campaignStopRate) return false;
        if (this.quota.qr && this.quota.allowance().level.brakesOff) return false;
        const { delivered, stopped } = this.db.campaignStopRate(this.campaignId);
        if (delivered < STOP_PAUSE.minDelivered || stopped * 100 <= delivered * STOP_PAUSE.percent) return false;
        this.queue.pause();
        this.emit('event', {
            type: 'failureStop', failed: stopped, processed: delivered,
            message: `Paused: ${stopped} of the ${delivered} people this campaign reached replied STOP (limit ${STOP_PAUSE.percent}%). People don't want this message; change it or the list before resuming.`,
        });
        this.#emitStats();
        return true;
    }

    /** Everything the health panel shows: the rates, and who blocked or reported and when. */
    healthStatus() {
        // The health card reloads on every send of a run: a full scan at most every 30s, else what the last wrote.
        if (Date.now() - this.lastHealthScan >= 30_000) this.scanHealth();
        return { ...this.healthRates(), events: this.db.safetyEvents?.(50) ?? [] };
    }

    /**
     * The daily ceiling.  Hitting it PAUSES the campaign: the remaining rows
     * stay QUEUED so the run can pick up after midnight, which is the whole
     * point of a cap that is not a failure.
     */
    #quotaBlocked(item) {
        // Safety left: a QR number still stops at its plan's day (DailyQuota.remaining).
        if (!(this.config.safetyEnabled || this.quota.qr) || !this.transport?.realDelivery) return false;
        // A reply to someone who wrote in is not bulk: it counts toward the day, but never holds the queue.
        if (QUOTA_EXEMPT.has(item.messageType)) return false;
        if (!this.quota.exhausted()) return false;
        // An operator's pause pressed during the gap stays theirs: marking it a quota pause would let
        // #pastQuotaPause resume a run its owner paused.
        const operatorPaused = this.queue.isPaused;
        this.queue.putFront(item);
        this.queue.pause();
        if (!operatorPaused) this.pausedByQuota = true;
        this.emit('event', { type: 'quotaReached', ...this.quota.status(), message: this.#quotaText() });
        this.#emitStats();
        return true;
    }

    /** Why bulk is held for the day, and when it carries on by itself (#pastQuotaPause). */
    #quotaText() {
        const status = this.quota.status();
        const zone = this.timezone?.() || null;
        if (!status.enabled) {
            return `Today's plan limit of ${status.limit} is used. Sending continues automatically at ${clockAt(status.resetsAt, zone)}.`;
        }
        if (status.asked === false) {
            return 'Answer 2 questions about this number on the Connection page to start sending. Sending continues by itself once they are answered.';
        }
        if (status.level?.resting.active) {
            return `This number is resting after being linked. Bulk sending starts automatically at ${clockAt(status.level.resting.endsAt, zone)}.`;
        }
        const halt = status.brakes?.find((b) => HALTING_BRAKES.includes(b.code));
        if (halt) return `${halt.text} Sending continues automatically at ${clockAt(halt.until, zone)}.`;
        return `Today's allowance of ${status.limit} is used. Sending continues automatically at ${clockAt(status.resetsAt, zone)}.`;
    }

    /**
     * Platform daily/monthly cap for the whole business (all its numbers).
     * Like the daily quota it PAUSES: the rest stays queued, with the reason.
     */
    #capBlocked(item) {
        if (item.messageType !== 'campaign' || !this.transport?.realDelivery) return false;
        const cap = this.bulkPolicy?.()?.capRemaining?.();
        if (!cap || cap.left > 0) return false;
        const operatorPaused = this.queue.isPaused;
        this.queue.putFront(item);
        this.queue.pause();
        // A quota-style pause: #pastQuotaPause lifts it once the day or month has room again (never an operator's).
        if (!operatorPaused) this.pausedByQuota = true;
        this.resumeRefusal = capReachedText(cap);
        this.emit('event', { type: 'policyHold', reason: this.resumeRefusal, campaignId: item.campaignId });
        this.#emitStats();
        return true;
    }

    async #process(item) {
        if (this.transport?.realDelivery) this.scanHealthIfDue();
        this.inFlight += 1;
        this.current = item;
        try {
            await this.#attempt(item);
        } finally {
            this.inFlight -= 1;
            this.current = null;
        }
    }

    /** Bulk is held now: outside the sending window, the platform's sending hours or a rest. */
    #bulkHeld() {
        // The platform's sending hours apply whatever the tenant's own safety switch says.
        return Boolean(this.transport?.realDelivery) && ((this.config.safetyEnabled && this.bulkWindowOpen?.() === false)
            || this.policyWindowOpen?.() === false || this.#resting());
    }

    /**
     * Bulk outside the sending window / quiet hours goes back in the queue (by
     * priority, so replies still overtake it) and the worker naps briefly.
     * Returns true when the item was held.
     */
    async #heldOutsideWindow(item) {
        const held = item.messageType === 'campaign' && this.#bulkHeld();
        if (held !== this.holding) {
            this.holding = Boolean(held);
            if (held) this.emit('event', { type: 'pacing', seconds: 0, resting: true, reason: 'quiet hours - bulk sending resumes when the window opens' });
            this.#emitStats();
        }
        if (!held) return false;
        this.queue.putBack(item);
        await interruptibleSleep(this.holdPollSeconds ?? 2, () => this.#stopped());
        return true;
    }

    /**
     * A number with no WhatsApp account is marked NOT_ON_WHATSAPP and never
     * sent: no attempt, no daily-cap use, no retry. Replies are not checked
     * (whoever wrote in has an account), nor jids (groups, @lid).
     * On a QR number mass lookups look like scraping: one number at a time,
     * after the gap, strangers only, none while WhatsApp restricts the number;
     * a NOT_ON_WHATSAPP spends a new chat (the ledger counts it).
     * Returns true when the item was settled that way.
     */
    async #notOnWhatsapp(item) {
        const checkable = (i) => i.messageType !== 'auto_reply' && !String(i.recipient).includes('@');
        if (!this.transport?.supportsRegistrationCheck || !checkable(item)) return false;
        if (this.#onLevels()) {
            item.cold ??= this.#cold(item);
            if (!item.cold || !this.quota.allowance().lookups) return false;
            if (this.#registered(item.recipient) === undefined) {
                await this.checkRegistered([item.recipient]);
                this.lastActionAt = Date.now();
            }
        } else if (this.#registered(item.recipient) === undefined) {
            const ahead = this.queue.snapshot()
                .filter((i) => checkable(i) && this.#registered(i.recipient) === undefined)
                .map((i) => i.recipient);
            await this.checkRegistered([...new Set([item.recipient, ...ahead])].slice(0, CHECK_AHEAD));
        }
        if (this.#registered(item.recipient) !== false) return false;
        this.#finish(item, Status.NOT_ON_WHATSAPP, { error: NOT_ON_WHATSAPP_TEXT });
        return true;
    }

    async #attempt(item) {
        for (;;) {
            if (this.#stopped()) {
                this.#finish(item, Status.CANCELLED, { error: this.stopReason });
                return;
            }
            if (await this.#heldOutsideWindow(item)) return;
            // Before the cap and the gap: a number with no account costs neither. A QR number looks up after the gap.
            const levels = this.#onLevels();
            if (!levels && await this.#notOnWhatsapp(item)) return;
            if (this.#quotaBlocked(item)) return;
            if (this.#capBlocked(item)) return;
            if (!await this.#paceBeforeSend(item)) {
                this.queue.putFront(item);   // stopped while pacing: keep the row queued
                return;
            }
            if (levels && await this.#notOnWhatsapp(item)) return;
            // Rate limit sits between the queue and the transport.
            if (!await this.rateLimiter.acquire(() => this.#stopped())) {
                this.#finish(item, Status.CANCELLED, { error: this.stopReason });
                return;
            }
            // Enqueue checked opt-outs, but a STOP can land while this row waited its turn.
            if (this.db.isOptedOut?.(digits(item.recipient))) {
                this.#finish(item, Status.CANCELLED, { error: 'opted out' });
                return;
            }
            // A control switched off while this row paced: hold it (#ready skips it until it is back on).
            if (item.messageType !== 'campaign' && this.sendBlock?.(item.messageType)) {
                this.queue.putFront(item);
                return;
            }
            // The plan's message quota ran out after this row was accepted (a fan-out, or a backlog): it does not go.
            const overQuota = item.messageType !== 'campaign' && this.transport?.realDelivery && this.capBlock?.(true);
            if (overQuota) {
                this.#finish(item, Status.CANCELLED, { error: overQuota });
                return;
            }
            // A campaign row passed #capBlocked before the gap; a reply or another number may have used the last of
            // the cap since, so it is checked again (and held, not dropped) right before it goes.
            if (this.#capBlocked(item)) return;
            // A pause pressed while this bulk row waited out its gap holds it too: on a QR number that gap can be
            // minutes, and "Paused" must mean nothing more of the run goes out. A reply or quick send still goes.
            if (this.queue.isPaused && !QUOTA_EXEMPT.has(item.messageType)) {
                this.queue.putFront(item);
                return;
            }

            item.attempt += 1;
            this.db.updateStatus(item.messageId, Status.SENDING, { attempt: item.attempt });
            this.emit('event', {
                type: 'status', messageId: item.messageId, status: Status.SENDING,
                attempt: item.attempt,
            });

            let retryable = false;
            let limited = false;
            let errorText = '';
            let dropped = false;
            try {
                // A person types before sending: the transport shows "typing..." for this long.
                const typing = this.transport?.realDelivery && this.config.safetyEnabled && this.config.humanTiming !== false
                    ? typingMs(item.message, { media: Boolean(item.media) }) : 0;
                // Someone this QR number already talks to is on WhatsApp: the transport need not look them up.
                const registered = this.#registered(item.recipient) === true || (levels && item.cold === false);
                const result = await this.transport.sendMessage(item.recipient, item.message,
                    { media: item.media, interactive: item.interactive, ...(typing ? { typingMs: typing } : {}), ...(registered ? { registered } : {}),
                        // A carousel goes as one image per card (every device shows it) unless the admin turned
                        // sending.carouselImages off: the swipe carousel, which phones do not show from a QR number.
                        ...(item.interactive?.type === 'carousel' ? { nativeCarousel: this.quota.tables?.().carouselImages === false } : {}) });
                this.lastActionAt = Date.now();
                // A carousel goes out as several WhatsApp messages (`parts`); the rests and the budgets count each.
                if (this.transport?.realDelivery) this.sentInRun += result.parts ?? 1;
                this.db.updateStatus(item.messageId, result.status, {
                    attempt: item.attempt,
                    providerId: result.providerId,
                    error: SUCCESS_STATUSES.includes(result.status) ? null : result.detail,
                    parts: result.parts,
                });
                this.#finish(item, result.status, { providerId: result.providerId, counted: true });
                // A receipt that landed before provider_id was written found no row and is gone;
                // the transport still remembers it (two ticks must not stay one).
                const late = result.providerId ? this.transport?.getStatus?.(result.providerId) : null;
                if (late && late !== result.status) this.handleReceipt(result.providerId, late);
                return;
            } catch (err) {
                this.lastActionAt = Date.now();   // a refused send still talked to WhatsApp: the next gap counts from here
                // The transport's own last-moment lookup said no account (the batch check could not tell).
                if (err?.code === NOT_ON_WHATSAPP_CODE) {
                    this.registry.set(item.recipient, { registered: false, at: Date.now() });
                    this.#finish(item, Status.NOT_ON_WHATSAPP, { error: NOT_ON_WHATSAPP_TEXT });
                    return;
                }
                if (err instanceof TransportConnectionError) {
                    this.emit('event', { type: 'connectionLost', error: err.message });
                    retryable = err.retryable;
                    errorText = `Connection error: ${err.message}`;
                    dropped = Boolean(this.transport?.realDelivery) && err.retryable !== false;
                } else if (err instanceof TransportError) {
                    retryable = err.retryable;
                    errorText = err.message;
                } else {
                    retryable = false;
                    errorText = `Unexpected error: ${err.message ?? err}`;
                }
                // The raw provider text goes to the server log; history and the
                // UI get a sentence the customer can act on.
                limited = normalizeError(err).code === ErrorCode.RATE_LIMITED;
                // The logger keeps the recipient to its last 4 digits and never logs the message text.
                logger.warn('send failed', { messageId: item.messageId, recipient: item.recipient, error: errorText });
                errorText = friendlyError(err);
            }

            // The line dropped: keep this message where it is, wait for the
            // connection, ease back in, and carry on from the same place. A
            // drop is not the message's fault, so it costs no attempt.
            if (dropped) {
                item.attempt -= 1;
                this.db.updateStatus(item.messageId, Status.QUEUED,
                    { attempt: item.attempt, error: 'Waiting for WhatsApp to reconnect' });
                if (await this.#settleAfterReconnect()) continue;
                if (this.#stopped()) {
                    this.#finish(item, Status.CANCELLED, { error: this.stopReason });
                    return;
                }
                item.attempt += 1;   // never came back: treat as an ordinary failure
            }

            // WhatsApp said rate-overlimit: the whole number backs off (this worker sends nothing) for 90s or more,
            // whether or not this message tries again.
            const rateLimited = limited && this.transport?.realDelivery;
            const backOff = (wait) => {
                this.emit('event', { type: 'pacing', seconds: wait, resting: true, reason: 'WhatsApp is rate limiting this number - backing off' });
                return interruptibleSleep(wait, () => this.#stopped());
            };
            if (this.retryPolicy.shouldRetry(item.attempt, retryable)) {
                if (rateLimited) {
                    const wait = between(...RATE_LIMIT_WAIT);
                    this.db.updateStatus(item.messageId, Status.QUEUED,
                        { attempt: item.attempt, error: `${errorText} (retry in about ${Math.round(wait)}s)` });
                    this.emit('event', {
                        type: 'status', messageId: item.messageId, status: Status.QUEUED,
                        attempt: item.attempt, error: errorText,
                    });
                    if (!await backOff(wait)) {
                        // A restart mid-backoff keeps the row queued (restoreRun picks it up); a stop cancels it.
                        if (this.shuttingDown) this.queue.putFront(item);
                        else this.#finish(item, Status.CANCELLED, { error: this.stopReason });
                        return;
                    }
                    continue;
                }
                // Real sends: everyone else goes first, then this one tries again 5-10s later.
                if (this.transport?.realDelivery) {
                    const wait = between(5, 10);
                    this.db.updateStatus(item.messageId, Status.QUEUED,
                        { attempt: item.attempt, error: `${errorText} (retry after the others, in about ${Math.round(wait)}s)` });
                    this.emit('event', {
                        type: 'status', messageId: item.messageId, status: Status.QUEUED,
                        attempt: item.attempt, error: errorText,
                    });
                    item.notBefore = Date.now() + wait * 1000;
                    this.queue.putLast(item);
                    return;
                }
                const delay = this.retryPolicy.delayFor(item.attempt);
                this.db.updateStatus(item.messageId, Status.QUEUED, {
                    attempt: item.attempt,
                    error: `${errorText} (retry in ${delay.toFixed(1)}s)`,
                });
                this.emit('event', {
                    type: 'status', messageId: item.messageId, status: Status.QUEUED,
                    attempt: item.attempt, error: errorText,
                });
                if (!await interruptibleSleep(delay, () => this.#stopped())) {
                    this.#finish(item, Status.CANCELLED, { error: this.stopReason });
                    return;
                }
                continue; // same item, next attempt
            }

            this.db.updateStatus(item.messageId, Status.FAILED,
                { attempt: item.attempt, error: errorText });
            this.#finish(item, Status.FAILED, { error: errorText, counted: true });
            if (rateLimited) await backOff(between(...RATE_LIMIT_WAIT));   // the next message still waits
            return;
        }
    }

    #finish(item, status, { providerId = null, error = null, counted = false } = {}) {
        if (!counted) {
            this.db.updateStatus(item.messageId, status, { attempt: item.attempt, error });
        }
        if (status === Status.CANCELLED) {   // an operator's stop is not a failure
            this.emit('event', { type: 'status', messageId: item.messageId, status, error, attempt: item.attempt });
            this.#emitStats();
            return;
        }
        // The run's own tally (the progress card, the failure stop): a reply or quick send in the same queue is not
        // part of it. The level's budgets below count every send regardless.
        const ofRun = this.#ofRun(item);
        if (ofRun) this.stats.processed += 1;
        // The level's budgets count this send (or this NOT_ON_WHATSAPP lookup) from the next read on.
        if (this.quota.qr) this.quota.invalidate();
        if (SUCCESS_STATUSES.includes(status) || status === Status.SANDBOX) {
            if (ofRun) this.stats.successful += 1;
            // Set by the channel runtime (records interactive sends for reply matching).
            try {
                this.onSent?.(item, { status, providerId });
            } catch (err) {
                logger.warn('onSent hook failed', { messageId: item.messageId, error: err.message });
            }
        } else if (status === Status.NOT_ON_WHATSAPP) {
            if (ofRun) this.stats.notOnWhatsapp += 1;   // a bad number, not a failed send: never trips the failure stop
        } else if (ofRun) this.stats.failed += 1;
        this.emit('event', {
            type: 'status', messageId: item.messageId, status, providerId, error,
            attempt: item.attempt,
        });
        if (ofRun) this.#stopOnFailures(item);
        this.#emitStats();
    }

    /**
   * Platform policy: a run where too many sends fail is usually a bad list or a
   * blocked number, and carrying on makes it worse. Pause, keep the rest queued.
   */
  #stopOnFailures(item) {
    // Tenant setting vs platform campaigns.autoPauseFailurePct: the stricter (lower, non-zero) wins.
    const limits = [Number(this.config.failureStopPercent) || 0, this.bulkPolicy?.()?.autoPauseFailurePct || 0].filter(Boolean);
    const limit = limits.length ? Math.min(...limits) : 0;
    const { processed, failed } = this.stats;
    if (!limit || item.messageType !== 'campaign' || processed < 20 ) return;
    if ((failed / processed) * 100 <= limit || this.queue.isPaused || this.queue.isStopped) return;
    this.queue.pause();
    this.emit('event', {
      type: 'failureStop', failed, processed, campaignId: item.campaignId,
      message: `Paused: ${failed} of ${processed} messages failed (limit ${limit}%).`,
    });
  }

  /** A receipt that arrived out of band (webhook, or a WhatsApp Web ACK). */
    handleReceipt(providerId, status, error = null) {
        if (this.db.applyReceipt(providerId, status, error)) {
            this.emit('event', { type: 'receipt', providerId, status, error });
            return true;
        }
        return false;
    }
}

export { QueueState };
