/**
 * Campaign engine: contact -> personalise -> queue -> rate limit -> transport
 * -> status update.
 *
 * One worker drains the queue, so ordering stays FIFO and the rate limiter has
 * a single place to enforce the configured send rate.  Every state change is
 * written to SQLite and emitted for the browser.
 */

import { ErrorCode, friendlyError, normalizeError } from '../messaging/errors.js';
import { normalizeInteractive, personalizeInteractive } from '../messaging/interactive.js';
import { renderMessage, withFallbacks } from './importer.js';
import { prepareTemplateSend } from '../messaging/templateSend.js';
import { EventEmitter } from 'node:events';

import {
    SUCCESS_STATUSES,
    Status,
    contactContext,
    personalize,
} from '../protocol.js';
import { TransportConnectionError, TransportError } from '../transports/base.js';
import { RateLimiter, RetryPolicy, interruptibleSleep } from './limits.js';
import { MessageQueue, QueueState, queueItem } from './queue.js';
import {
    DailyQuota, SafetyError, estimateSeconds, nextDelay, paceFor, pickPreset, variationError,
} from './safety.js';
import { capReachedText, clampPreset } from '../policy/campaignOps.js';

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
        this.stats = { total: 0, successful: 0, failed: 0, processed: 0, skippedOptOut: 0 };
        this.worker = null;
        this.shuttingDown = false;
        this.inFlight = 0;

        // Sending safety: a daily ceiling, and a gap between messages that
        // varies with how many are going out.
        this.quota = new DailyQuota(db, config);
        this.pacePreset = 'balanced';   // 'safe' | 'balanced' | 'fast'
        this.pace = paceFor(0, config);
        this.sentInRun = 0;
        this.waitingUntil = null;   // when the next message may go (ms epoch)
        this.pausedByQuota = false;
        // Set by the channel runtime: () => true while bulk may go out now
        // (sending window + quiet hours). Bulk outside it waits, it does not fail.
        this.bulkWindowOpen = null;
        this.holding = false;
        // Platform policy hooks, set by policy/campaignOps.js attachCampaignPolicy.
        this.bulkPolicy = null;        // () => rules (caps, opt-in, speed ceiling, ...)
        this.killSwitch = null;        // () => reason text while bulk must stop, else null
        this.policyWindowOpen = null;  // () => false outside the platform's sending hours
        this.stopReason = 'Stopped by operator';
        this.resumeRefusal = null;     // why a policy hold cannot be resumed yet
        this.current = null;
    }

    applyConfig(config) {
        this.config = config;
        this.rateLimiter.setRate(config.rateLimitPerSecond, config.rateLimitBurst);
        this.retryPolicy = RetryPolicy.fromConfig(config);
        this.quota.config = config;
        this.pace = paceFor(this.pace.batchSize, config, this.pacePreset);
    }

    /** Change the speed preset of the current run (live): recomputes the gap range. */
    setPace(preset, batchSize = this.pace.batchSize) {
        const ceiling = this.bulkPolicy?.()?.maxSpeed;
        this.pacePreset = ceiling ? clampPreset(pickPreset(preset), ceiling) : pickPreset(preset);
        this.pace = paceFor(batchSize, this.config, this.pacePreset);
        this.#emitStats();
        return this.pace;
    }

    setTransport(transport) {
        this.transport = transport;
    }

    statsSnapshot() {
        return {
            ...this.stats,
            pending: this.queue.pending,
            duplicates: this.queue.duplicatesRejected,
            state: this.queue.state,
            safety: this.safetyStatus(),
        };
    }

    /** Everything the UI needs to explain the pacing and the daily budget. */
    safetyStatus(batchSize = this.pace.batchSize, preset = this.pacePreset) {
        const pace = paceFor(batchSize, this.config, pickPreset(preset));
        return {
            ...this.quota.status(),
            pacingMode: this.config.pacingMode,
            pacing: pace.preset,
            minSeconds: pace.minSeconds,
            maxSeconds: pace.maxSeconds,
            restEvery: pace.restEvery,
            restMinMinutes: pace.restMinSeconds / 60,
            restMaxMinutes: pace.restMaxSeconds / 60,
            estimateSeconds: estimateSeconds(batchSize, pace),
            waitingSeconds: this.waitingUntil
                ? Math.max(0, Math.round((this.waitingUntil - Date.now()) / 1000))
                : 0,
            pausedByQuota: this.pausedByQuota,
            heldForQuietHours: this.holding,
        };
    }

    #emitStats() {
        this.emit('event', { type: 'stats', stats: this.statsSnapshot() });
    }

    // ------------------------------------------------------------ queueing --
    /**
     * Personalise and queue a batch. Returns {queued, skipped}.
     *
     * With `onePerNumber` each number is messaged exactly once: repeats inside
     * this batch are dropped whatever name they carry, and numbers that already
     * received a real message in an earlier run are skipped too (the database,
     * not the queue, is what remembers those).
     */
    enqueueContacts(contacts, template, {
        campaignId = null, onePerNumber = false, media = null, interactive = null,
        // Meta approved template mode / 131047 fallback: { template: stored, params }.
        metaTemplate = null, fallbackTemplate = null,
        // Bulk Campaigns v2: per-variable fallback text and the speed preset.
        fallbacks = null, pacing = 'balanced',
    } = {}) {
        // Throws InteractiveError (status 400) before anything is queued.
        const block = normalizeInteractive(interactive);
        // Platform policy (policy/campaignOps.js): refusals before anything is queued.
        const rules = this.bulkPolicy?.() ?? null;
        let skippedNoOptIn = 0;
        let pacingClamped = null;
        if (rules) {
            if (this.killSwitch?.()) throw new SafetyError('Bulk sending is switched off right now, so a new send cannot start.', 409);
            if (block && rules.allowInteractive === false) throw new SafetyError('Interactive buttons are not on your plan.', 403);
            const count = Array.isArray(contacts) ? contacts.length : 0;
            if (rules.maxRecipients && count > rules.maxRecipients) {
                throw new SafetyError(`A send can reach ${rules.maxRecipients} recipients on your plan; this one has ${count}.`, 403);
            }
            if (rules.notOptedIn) {
                const no = rules.notOptedIn();
                const kept = contacts.filter((c) => !no.has(String(c?.phone ?? '').replace(/\D/g, '')));
                skippedNoOptIn = contacts.length - kept.length;
                contacts = kept;
            }
            const cap = rules.capRemaining?.();
            if (cap && contacts.length > cap.left) {
                throw new SafetyError(`This send has ${contacts.length} recipients, but your business has only ${cap.left} `
                    + `messages left of its ${cap.period} cap of ${cap.cap}.`, 403);
            }
            const wanted = pickPreset(pacing);
            const applied = clampPreset(wanted, rules.maxSpeed);
            if (applied !== wanted) pacingClamped = { requested: wanted, applied };
            pacing = applied;
        }
        // Meta fixes an approved template's wording; variation is not ours to add.
        const unvaried = this.config.safetyEnabled === false || metaTemplate ? null : variationError(template, contacts, this.config);
        if (unvaried) throw new SafetyError(unvaried);
        this.campaignId = campaignId ?? crypto.randomUUID().replace(/-/g, '').slice(0, 12);
        const alreadySent = onePerNumber ? this.db.sentRecipients() : new Set();
        // Per-recipient frequency cap: bulk only, rolling 24h, counted from the db.
        const perRecipient = this.config.safetyEnabled === false ? 0 : Number(this.config.recipientDailyCap) || 0;
        const recent = perRecipient && this.db.bulkCountsSince
            ? this.db.bulkCountsSince(new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00'))
            : new Map();
        let skippedFrequency = 0;
        const batch = Array.isArray(contacts) ? contacts.length : 0;
        this.pacePreset = pickPreset(pacing);
        this.pace = paceFor(batch, this.config, this.pacePreset);
        this.sentInRun = 0;
        let queued = 0;
        let skipped = 0;
        let skippedOptOut = 0;
        let skippedMuted = 0;
        let skippedTemplateVars = 0;
        const optedOut = new Set(this.db.getAllOptOuts?.() ?? []);
        // Contacts a reply rule muted ("not now, ask me in 30 days").
        const muted = this.db.bulkMutedPhones?.() ?? new Set();

        // The flag only governs this batch: a later single send to one of these
        // numbers is a deliberate act, not a duplicate.
        const previousMode = this.queue.onePerRecipient;
        this.queue.onePerRecipient = onePerNumber;
        try {
            for (const contact of contacts) {
                if (optedOut.has(contact.phone)) {
                    skipped += 1;
                    skippedOptOut += 1;
                    continue;
                }
                if (alreadySent.has(contact.phone)) {
                    skipped += 1;
                    continue;
                }
                if (muted.has(contact.phone)) {
                    skipped += 1;
                    skippedMuted += 1;
                    continue;
                }
                if (perRecipient && (recent.get(contact.phone) ?? 0) >= perRecipient) {
                    skipped += 1;
                    skippedFrequency += 1;
                    continue;
                }
                // A `message` column in the sheet gives that number its own text;
                // everyone else gets the shared template.
                const own = String(contact.extra?.message ?? contact.extra?.custom_message ?? '').trim();
                // --- Meta approved template (messaging/templateSend.js) ---
                // Meta rejects an empty parameter, so a contact missing a
                // mapped variable (and its fallback) is skipped, not sent.
                const meta = metaTemplate
                    ? prepareTemplateSend(metaTemplate.template, withFallbacks(contactContext(contact), fallbacks ?? {}), metaTemplate.params) : null;
                if (meta?.missing.length) {
                    skipped += 1;
                    skippedTemplateVars += 1;
                    continue;
                }
                const fallback = fallbackTemplate
                    ? prepareTemplateSend(fallbackTemplate.template, withFallbacks(contactContext(contact), fallbacks ?? {}), fallbackTemplate.params) : null;
                // --- end Meta approved template ---
                const item = queueItem({
                    recipient: contact.phone,
                    message: meta ? meta.text : renderMessage(own || template, contact, fallbacks ?? {}),
                    template: meta?.template ?? null,
                    fallbackTemplate: fallback && !fallback.missing.length ? fallback : null,
                    name: contact.name ?? '',
                    campaignId: this.campaignId,
                    media,
                    interactive: personalizeInteractive(block, withFallbacks(contactContext(contact), fallbacks ?? {})),
                });
                if (this.#enqueueItem(item)) {
                    queued += 1;
                    if (perRecipient) recent.set(contact.phone, (recent.get(contact.phone) ?? 0) + 1);
                } else skipped += 1;
            }
        } finally {
            this.queue.onePerRecipient = previousMode;
        }

        this.stats.total += queued;
        this.stats.skippedOptOut += skippedOptOut;
        this.#emitStats();
        // Say up front how much of this batch today's budget actually covers.
        const remaining = this.quota.remaining();
        const policyNotes = [];
        if (skippedNoOptIn) policyNotes.push(`${skippedNoOptIn} contacts were skipped because they have not opted in.`);
        if (pacingClamped) policyNotes.push(`Speed was lowered to "${pacingClamped.applied}", the fastest your plan allows.`);
        return {
            queued,
            skipped: skipped + skippedNoOptIn,
            skippedNoOptIn,
            pacingClamped,
            policyNotes,
            skippedOptOut,
            skippedFrequency,
            skippedMuted,
            skippedTemplateVars,
            campaignId: this.campaignId,
            safety: this.safetyStatus(queued),
            overQuota: Number.isFinite(remaining) ? Math.max(0, queued - remaining) : 0,
        };
    }

    enqueueSingle(recipient, message, name = '', { media = null } = {}) {
        const item = queueItem({
            recipient,
            message,
            name,
            campaignId: this.campaignId || 'single',
            media,
        });
        if (!this.#enqueueItem(item)) return null;
        this.stats.total += 1;
        this.#emitStats();
        return item.messageId;
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
            campaignId: job.campaignId || this.campaignId || job.messageType,
            media: job.media,
            messageType: job.messageType,
            priority: job.priority,
            idempotencyKey: job.idempotencyKey,
            interactive: job.interactive ?? null,
            fallbackTemplate: job.fallbackTemplate ?? null,
            template: job.template ?? null,
        });
        if (!this.#enqueueItem(item)) return null;
        this.stats.total += 1;
        this.#emitStats();
        return item.messageId;
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
        if (!this.worker) this.worker = this.#run().finally(() => { this.worker = null; });
        this.#emitStats();
    }

    pause() {
        this.queue.pause();
        this.#emitStats();
    }

    resume() {
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
            this.emit('event', {
                type: 'quotaReached',
                ...this.quota.status(),
                message: `Daily limit of ${this.quota.limit} still reached - try after midnight.`,
            });
            this.#emitStats();
            return false;
        }
        this.pausedByQuota = false;
        this.queue.resume();
        this.#emitStats();
        return true;
    }

    /** Stop the campaign and drop everything still queued. */
    stop(reason = 'Stopped by operator') {
        this.stopReason = reason;
        const dropped = this.queue.stop();
        for (const item of dropped) {
            this.db.updateStatus(item.messageId, Status.FAILED,
                { attempt: item.attempt, error: reason });
        }
        this.stats.failed += dropped.length;
        this.stats.processed += dropped.length;
        this.emit('event', { type: 'historyDirty' });
        this.#emitStats();
        return dropped.length;
    }

    resetStats() {
        this.stopReason = 'Stopped by operator';
        this.resumeRefusal = null;
        this.stats = { total: 0, successful: 0, failed: 0, processed: 0, skippedOptOut: 0 };
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
            const item = this.queue.get();
            if (!item) {
                if (this.queue.isStopped && !this.shuttingDown) {
                    // Stopped, but stay alive for the next campaign.
                    await interruptibleSleep(0.1, () => this.shuttingDown);
                    continue;
                }
                await interruptibleSleep(0.15, () => this.shuttingDown);
                continue;
            }
            await this.#process(item);
        }
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
        const adaptive = this.config.safetyEnabled && this.config.pacingMode !== 'fixed';
        // Sandbox sends never leave the machine, so they are not paced.
        if (!adaptive || !this.transport?.realDelivery) return true;

        const { seconds, resting } = nextDelay(this.pace, this.sentInRun);
        if (seconds <= 0) return true;
        this.waitingUntil = Date.now() + seconds * 1000;
        this.emit('event', {
            type: 'pacing',
            seconds: Math.round(seconds),
            resting,
            reason: resting ? 'resting between batches' : 'spacing messages',
        });
        this.#emitStats();
        const finished = await interruptibleSleep(seconds, () => this.#stopped());
        this.waitingUntil = null;
        return finished;
    }

    /**
     * The daily ceiling.  Hitting it PAUSES the campaign: the remaining rows
     * stay QUEUED so the run can pick up after midnight, which is the whole
     * point of a cap that is not a failure.
     */
    #quotaBlocked(item) {
        if (!this.config.safetyEnabled || !this.transport?.realDelivery) return false;
        if (!this.quota.exhausted()) return false;
        this.queue.putFront(item);
        this.queue.pause();
        this.pausedByQuota = true;
        this.emit('event', {
            type: 'quotaReached',
            ...this.quota.status(),
            message: `Daily limit of ${this.quota.limit} reached - campaign paused.`,
        });
        this.#emitStats();
        return true;
    }

    /**
     * Platform daily/monthly cap for the whole business (all its numbers).
     * Like the daily quota it PAUSES: the rest stays queued, with the reason.
     */
    #capBlocked(item) {
        if (item.messageType !== 'campaign' || !this.transport?.realDelivery) return false;
        const cap = this.bulkPolicy?.()?.capRemaining?.();
        if (!cap || cap.left > 0) return false;
        this.queue.putFront(item);
        this.queue.pause();
        this.resumeRefusal = capReachedText(cap);
        this.emit('event', { type: 'policyHold', reason: this.resumeRefusal, campaignId: item.campaignId });
        this.#emitStats();
        return true;
    }

    async #process(item) {
        this.inFlight += 1;
        this.current = item;
        try {
            await this.#attempt(item);
        } finally {
            this.inFlight -= 1;
            this.current = null;
        }
    }

    /**
     * Bulk outside the sending window / quiet hours goes back in the queue (by
     * priority, so replies still overtake it) and the worker naps briefly.
     * Returns true when the item was held.
     */
    async #heldOutsideWindow(item) {
        const bulk = item.messageType === 'campaign' && this.transport?.realDelivery;
        // The platform's sending hours apply whatever the tenant's own safety switch says.
        const held = bulk && ((this.config.safetyEnabled && this.bulkWindowOpen?.() === false)
            || this.policyWindowOpen?.() === false);
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

    async #attempt(item) {
        for (;;) {
            if (this.#stopped()) {
                this.#finish(item, Status.FAILED, { error: this.stopReason });
                return;
            }
            if (await this.#heldOutsideWindow(item)) return;
            if (this.#quotaBlocked(item)) return;
            if (this.#capBlocked(item)) return;
            if (!await this.#paceBeforeSend(item)) {
                this.queue.putFront(item);   // stopped while pacing: keep the row queued
                return;
            }
            // Rate limit sits between the queue and the transport.
            if (!await this.rateLimiter.acquire(() => this.#stopped())) {
                this.#finish(item, Status.FAILED, { error: this.stopReason });
                return;
            }

            item.attempt += 1;
            this.db.updateStatus(item.messageId, Status.SENDING, { attempt: item.attempt });
            this.emit('event', {
                type: 'status', messageId: item.messageId, status: Status.SENDING,
                attempt: item.attempt,
            });

            let retryable = false;
            let errorText = '';
            try {
                const result = await this.transport.sendMessage(item.recipient, item.message,
                    { media: item.media, interactive: item.interactive, template: item.template });
                if (this.transport?.realDelivery) this.sentInRun += 1;
                this.db.updateStatus(item.messageId, result.status, {
                    attempt: item.attempt,
                    providerId: result.providerId,
                    error: SUCCESS_STATUSES.includes(result.status) ? null : result.detail,
                });
                this.#finish(item, result.status, { providerId: result.providerId, counted: true });
                return;
            } catch (err) {
                if (err instanceof TransportConnectionError) {
                    this.emit('event', { type: 'connectionLost', error: err.message });
                    retryable = err.retryable;
                    errorText = `Connection error: ${err.message}`;
                } else if (err instanceof TransportError) {
                    retryable = err.retryable;
                    errorText = err.message;
                } else {
                    retryable = false;
                    errorText = `Unexpected error: ${err.message ?? err}`;
                }
                // Meta 131049: this person's marketing allowance is used up; retrying now only burns attempts.
                if (normalizeError(err).code === ErrorCode.PER_USER_CAP) retryable = false;
                // The raw provider text goes to the server log; history and the
                // UI get a sentence the customer can act on.
                console.warn(`[send] ${item.messageId} to ${item.recipient}: ${errorText}`);
                errorText = friendlyError(err);
                // Outside the 24h window (131047): swap in the campaign's
                // fallback approved template once and go again.
                if (err?.code === 131047 && item.fallbackTemplate && !item.template) {
                    item.template = item.fallbackTemplate.template;
                    item.message = item.fallbackTemplate.text;
                    item.interactive = null;
                    continue;
                }
            }

            if (this.retryPolicy.shouldRetry(item.attempt, retryable)) {
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
                    this.#finish(item, Status.FAILED, { error: this.stopReason });
                    return;
                }
                continue; // same item, next attempt
            }

            this.db.updateStatus(item.messageId, Status.FAILED,
                { attempt: item.attempt, error: errorText });
            this.#finish(item, Status.FAILED, { error: errorText, counted: true });
            return;
        }
    }

    #finish(item, status, { providerId = null, error = null, counted = false } = {}) {
        if (!counted) {
            this.db.updateStatus(item.messageId, status, { attempt: item.attempt, error });
        }
        this.stats.processed += 1;
        if (SUCCESS_STATUSES.includes(status) || status === Status.SANDBOX) {
            this.stats.successful += 1;
            // Set by the channel runtime (records interactive sends for reply matching).
            try {
                this.onSent?.(item, { status, providerId });
            } catch (err) {
                console.warn(`[send] onSent hook failed for ${item.messageId}: ${err.message}`);
            }
        } else this.stats.failed += 1;
        this.emit('event', {
            type: 'status', messageId: item.messageId, status, providerId, error,
            attempt: item.attempt,
        });
        this.#stopOnFailures(item);
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
