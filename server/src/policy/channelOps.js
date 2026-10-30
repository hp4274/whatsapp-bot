/**
 * Enforcement for the `channels.*` platform policy (see `channels.js` beside
 * this file): number caps, allowed providers, safety defaults for new numbers,
 * the ban-risk guard and the super admin's per-number actions.
 *
 * What the channel row cannot hold (why a number was paused, when it was last
 * seen, the admin's level pin, the number questions) lives in `channel_ops`, one row per
 * number, created here so the shared schema stays untouched.
 */

import { Channels } from '../channels.js';
import { DailyQuota } from '../campaign/safety.js';
import { DEFAULTS, QR_TRANSPORTS, mergeConfig } from '../config.js';
import { CHANNEL_POLICY } from './channels.js';
import { applySendingPolicy } from './levels.js';
import { PolicyStore, limitOf } from './index.js';

const FIELD = Object.fromEntries(CHANNEL_POLICY.map((f) => [f.key, f]));
const DAY_MS = 86_400_000;
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const GUARD_EVERY_MS = 60_000;

const TABLE = `CREATE TABLE IF NOT EXISTS channel_ops (
    channel_id     INTEGER PRIMARY KEY,
    paused_reason  TEXT,
    paused_by      TEXT,
    paused_at      TEXT,
    resumed_at     TEXT,
    quality_rating TEXT,
    last_seen_at   TEXT,
    level_pin       INTEGER,
    level_pinned_by TEXT,
    level_pinned_at TEXT,
    start_level     INTEGER,
    start_answers   TEXT,
    started_at      TEXT,
    start_by_phone  TEXT,
    last_level      INTEGER,
    demoted_at      TEXT,
    clean_checks    INTEGER,
    clean_check_at  TEXT,
    brakes_off_until TEXT,
    brakes_off_by    TEXT,
    brakes_off_at    TEXT
)`;

/**
 * The level pin, the number questions, the level state (db.levelState: the level the promotion gate holds,
 * the last demotion, and the probation's passing health checks) and the admin's brakes-off came after channel_ops shipped.
 */
function migrate(raw, at) {
    const cols = raw.prepare('PRAGMA table_info(channel_ops)').all().map((c) => c.name);
    for (const [col, type] of [['level_pin', 'INTEGER'], ['level_pinned_by', 'TEXT'], ['level_pinned_at', 'TEXT'],
        ['start_level', 'INTEGER'], ['start_answers', 'TEXT'], ['started_at', 'TEXT'], ['start_by_phone', 'TEXT'],
        ['last_level', 'INTEGER'], ['demoted_at', 'TEXT'], ['clean_checks', 'INTEGER'], ['clean_check_at', 'TEXT'],
        ['brakes_off_until', 'TEXT'], ['brakes_off_by', 'TEXT'], ['brakes_off_at', 'TEXT']]) {
        if (!cols.includes(col)) raw.exec(`ALTER TABLE channel_ops ADD COLUMN ${col} ${type}`);
    }
    // Once, as the questions arrive: a QR number that already delivered is not held for them. Its level-1 start
    // seeds nothing, so its own history alone sets the level. A number with no history yet is asked.
    if (!cols.includes('start_level')) {
        raw.prepare(`INSERT INTO channel_ops (channel_id, start_level, start_answers, started_at)
            SELECT w.id, 1, '{"legacy":true}', ? FROM whatsapp_channels w
            WHERE w.provider IN (${QR_TRANSPORTS.map(() => '?').join(', ')}) AND EXISTS (SELECT 1 FROM messages m
                WHERE m.tenant_id = w.tenant_id AND m.channel_id = w.id AND m.status IN ('DELIVERED', 'READ')
                  AND m.sent_at >= COALESCE(w.number_since, ''))
            ON CONFLICT (channel_id) DO UPDATE SET start_level = excluded.start_level,
                start_answers = excluded.start_answers, started_at = excluded.started_at`).run(at, ...QR_TRANSPORTS);
    }
}

/**
 * A channel_ops row's admin overrides as DailyQuota.levelPin wants them, or null: the level pin (`level` null when
 * none) and `brakesOff` `{ until, by, at }` while the admin has the number's brakes off.
 */
export function pinFromRow(r) {
    const brakesOff = r?.brakes_off_until ? { until: r.brakes_off_until, by: r.brakes_off_by, at: r.brakes_off_at } : null;
    if (r?.level_pin == null && !brakesOff) return null;
    return { level: r.level_pin ?? null, at: r.level_pinned_at, by: r.level_pinned_by, brakesOff };
}

/**
 * A channel_ops row's answered number questions as DailyQuota.levelStart wants them, or null.
 * `answers`: `{ age, usage }` or `{ skipped: true }`.
 */
export function startFromRow(r) {
    if (r?.started_at == null || r.start_level == null) return null;
    let answers = null;
    try { answers = JSON.parse(r.start_answers ?? 'null'); } catch { /* a bad row still starts at its level */ }
    return { level: r.start_level, answers, at: r.started_at };
}

/** Effective number cap: the stricter of the legacy tenant limit and the policy (null = none). */
export function numberCap(limits = {}, policy = {}) {
    const caps = [limits.maxChannels || null, limitOf(FIELD['channels.maxNumbers'], policy['channels.maxNumbers'] ?? 0)]
        .filter((n) => n);
    return caps.length ? Math.min(...caps) : null;
}

export const capMessage = (cap) => `Your plan allows ${cap} WhatsApp number${cap === 1 ? '' : 's'}. Ask the platform admin to raise it.`;

/**
 * Why `transport` is not allowed, or null. Both the legacy tenant limit and
 * the policy must allow it (stricter wins). The legacy messages are kept.
 */
export function providerBlocked(transport, limits = {}, policy = {}) {
    if (QR_TRANSPORTS.includes(transport)) {
        if (limits.allowWhatsappWeb === false) return 'WhatsApp QR login is not enabled for your plan.';
        if (policy['channels.allowBaileys'] === false) return 'QR-login (Baileys) numbers are not allowed on your plan.';
    }
    return null;
}

/** A number past the cap (by age, oldest first) may exist but not connect. */
export function overCap(channelDb, channel, limits, policy) {
    const cap = numberCap(limits, policy);
    if (!cap) return null;
    const older = channelDb.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_channels WHERE tenant_id = ? AND id < ?')
        .get(channel.tenantId, channel.id).n;
    return older >= cap ? `${capMessage(cap)} This number is over the limit, so it cannot connect.` : null;
}

/**
 * Starting safety settings for a new number. A tenant may start stricter than
 * the policy, never looser: lower retries and longer gaps win. The plan's
 * per-number day (channels.dailyCap) is not copied: sendingTables reads it live.
 * So a QR number keeps only a day the tenant asked for (0 = none), which can
 * only lower its level; the sandbox falls back to the plain default.
 */
export function newNumberSafety(policy = {}, asked = {}) {
    const v = (key) => policy[`channels.${key}`] ?? FIELD[`channels.${key}`].default;
    const n = (key) => Number(asked[key]) || 0;
    const qr = QR_TRANSPORTS.includes(mergeConfig(DEFAULTS, asked).transport);
    return {
        dailyLimit: n('dailyLimit') || (qr ? 0 : DEFAULTS.dailyLimit),
        minDelaySeconds: Math.max(v('minGapSeconds'), n('minDelaySeconds')),
        maxDelaySeconds: Math.max(v('maxGapSeconds'), n('maxDelaySeconds'), v('minGapSeconds')),
        maxRetries: asked.maxRetries == null ? v('retryLimit') : Math.min(n('maxRetries'), v('retryLimit')),
    };
}

/** Brakes that take a QR number out of `quota` routing. The halting ones are in its brakes only once enforced. */
const ROUTE_AROUND = ['delivery', 'stuck', 'unstable', 'failures', 'blocks', 'restricted'];

/**
 * `channel`'s score for the `quota` sender rule (channels.js pick: highest wins), running or not: sends left today
 * (Infinity = uncapped). A QR number under a ROUTE_AROUND brake scores -1, below any healthy one; ties on what is
 * left go to the higher delivered rate of messages sent 2-24h ago (the fraction added, under 1).
 * `sending`/`pin`/`start`: see policy/levels.js applySendingPolicy.
 */
export function quotaLeft(tenantDb, channel, runtime, enforced = {}, sending = {}, pin = null, start = null) {
    const quota = runtime?.state.manager.quota
        ?? applySendingPolicy(new DailyQuota(tenantDb.forChannel(channel.id), { ...DEFAULTS, ...channel.settings, ...enforced }), sending, pin, start);
    const left = quota.remaining();
    if (!quota.qr) return left;
    const { brakes, delivery } = quota.allowance();
    if (brakes.some((b) => ROUTE_AROUND.includes(b.code))) return -1;
    return left + (delivery.sentWin ? delivery.deliveredWin / delivery.sentWin : 0) / 2;
}

/**
 * @param {object} o
 * @param {import('../db.js').Database} o.db  the unscoped handle
 * @param {Map} o.runtimes  tenantId -> tenant runtime (app.js createTenantRuntime)
 */
export function createChannelOps({ db, tenancy, runtimes, policy = new PolicyStore(db), now = () => Date.now() }) {
    const raw = db.db;
    raw.exec(TABLE);
    migrate(raw, stamp(now()));
    const upsert = (channelId, fields) => {
        const keys = Object.keys(fields);
        raw.prepare(`INSERT INTO channel_ops (channel_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})
            ON CONFLICT (channel_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(', ')}`)
            .run(Number(channelId), ...keys.map((k) => fields[k]));
    };
    const rows = () => new Map(raw.prepare('SELECT * FROM channel_ops').all().map((r) => [r.channel_id, r]));
    const findRow = (id) => raw.prepare('SELECT * FROM whatsapp_channels WHERE id = ?').get(Number(id));

    /** The live runtime state of a number, if its engine is up. */
    const stateOf = (tenantId, channelId) => runtimes.get(tenantId)?.runtimes.get(channelId)?.state ?? null;

    /** Stop a number's engine (and, with `logout`, end its WhatsApp session). */
    const close = async (tenantId, channelId, { logout = false } = {}) => {
        const state = stateOf(tenantId, channelId);
        if (logout && state?.transport?.logout) {
            try { await state.transport.logout(); } catch { /* best effort: the engine closes anyway */ }
        }
        await runtimes.get(tenantId)?.release?.(channelId);
    };

    const setStatus = (row, status) => new Channels(db.forTenant(row.tenant_id)).update(row.id, { status });

    const pause = async (row, reason, by) => {
        setStatus(row, 'disabled');
        upsert(row.id, { paused_reason: reason, paused_by: by, paused_at: stamp(now()) });
        stateOf(row.tenant_id, row.id)?.announce?.(); // open pages learn why before close() ends their stream
        await close(row.tenant_id, row.id);
    };

    /** Why a number is paused (null when it is not), for the business's own Connection page. */
    const pausedOf = (channelId) => {
        const r = raw.prepare('SELECT paused_reason, paused_by, paused_at FROM channel_ops WHERE channel_id = ?').get(Number(channelId));
        return r?.paused_by ? { reason: r.paused_reason, by: r.paused_by, at: r.paused_at } : null;
    };

    /** The admin's overrides on a number, `{ level, at, by, brakesOff }` (pinFromRow), or null. */
    const pinOf = (channelId) => pinFromRow(raw.prepare(`SELECT level_pin, level_pinned_by, level_pinned_at, brakes_off_until,
        brakes_off_by, brakes_off_at FROM channel_ops WHERE channel_id = ?`).get(Number(channelId)));

    /** The number's answered questions, `{ level, answers, at }`, or null (asked again once voided: safety.js allowance). */
    const startOf = (channelId) => startFromRow(raw.prepare('SELECT start_level, start_answers, started_at FROM channel_ops WHERE channel_id = ?')
        .get(Number(channelId)));

    /** Record a number's answers (`answers`: `{ age, usage }` or `{ skipped: true }`) and the level they start it at. */
    const setStart = (channelId, level, answers) => {
        upsert(channelId, { start_level: level, start_answers: JSON.stringify(answers), started_at: stamp(now()) });
        return startOf(channelId);
    };

    /**
     * A different phone took this channel (`from` -> `to`, digits or as WhatsApp reports them). The outgoing phone's
     * answers are kept under it, and a phone that answered here before gets its own back (fresh, so the new
     * number_since does not void them) unless the channel saw a ban since. Otherwise the new phone is asked.
     */
    const switchPhone = (channelId, from, to) => {
        const key = (phone) => String(phone ?? '').replace(/D/g, '');
        const row = raw.prepare('SELECT start_level, start_answers, started_at, start_by_phone FROM channel_ops WHERE channel_id = ?')
            .get(Number(channelId));
        let known = {};
        try { known = JSON.parse(row?.start_by_phone ?? '{}') ?? {}; } catch { /* a bad map only forgets */ }
        if (key(from) && row?.start_level != null) {
            let answers = null;
            try { answers = JSON.parse(row.start_answers ?? 'null'); } catch { /* kept as unknown */ }
            known[key(from)] = { level: row.start_level, answers, at: row.started_at };
        }
        const back = key(to) ? known[key(to)] : null;
        const banned = back && raw.prepare(`SELECT 1 FROM safety_events WHERE channel_id = ? AND kind = 'ban' AND at > ? LIMIT 1`)
            .get(Number(channelId), back.at ?? '');
        const fields = { start_by_phone: JSON.stringify(known) };
        if (back && !banned) Object.assign(fields, { start_level: back.level, start_answers: JSON.stringify(back.answers), started_at: stamp(now()) });
        upsert(channelId, fields);
        return Boolean(back && !banned);
    };

    /** A number's sending quota: the running engine's, or a one-off built the same way (policy/levels.js). */
    const quotaOf = (row) => {
        const live = stateOf(row.tenant_id, row.id)?.manager?.quota;
        if (live) return live;
        const scoped = db.forTenant(row.tenant_id);
        const channel = new Channels(scoped).get(row.id);
        const config = { ...DEFAULTS, ...channel.settings, ...tenancy.enforcedSafety(tenancy.getTenant(row.tenant_id)) };
        const quota = applySendingPolicy(new DailyQuota(scoped.forChannel(row.id), config), policy.resolve(row.tenant_id).values, () => pinOf(row.id), () => startOf(row.id));
        quota.zone = () => channel.timezone || null;
        return quota;
    };

    const resume = (row) => {
        setStatus(row, 'active');
        // The guard judges only sends after this, or it would pause again at once.
        upsert(row.id, { paused_reason: null, paused_by: null, paused_at: null, resumed_at: stamp(now()) });
    };

    /**
     * Ban-risk guard: pause an active number whose last-24h failure rate or
     * 7-day spam reports cross its tenant's policy line. Also records
     * last-seen for the health view. Runs from the app sweep, at
     * most once a minute unless `force`.
     * ponytail: one aggregate query per run; per-send evaluation if a minute is too slow.
     */
    let lastRun = 0;
    const guard = async ({ force = false } = {}) => {
        const at = now();
        if (!force && at - lastRun < GUARD_EVERY_MS) return [];
        lastRun = at;
        const since = stamp(at - DAY_MS);
        const stats = new Map(raw.prepare(`
            SELECT m.channel_id AS id, m.tenant_id,
                SUM(m.status IN ('SENT', 'DELIVERED', 'READ', 'FAILED')) AS total,
                SUM(m.status = 'FAILED') AS failed
            FROM messages m LEFT JOIN channel_ops o ON o.channel_id = m.channel_id
            WHERE m.direction = 'outbound' AND m.channel_id IS NOT NULL
              AND m.updated_at >= ? AND (o.resumed_at IS NULL OR m.updated_at > o.resumed_at)
            GROUP BY m.channel_id, m.tenant_id`).all(since).map((r) => [`${r.tenant_id}:${r.id}`, r]));
        // Distinct people who reported the number in 7 days, since it was last resumed.
        const reports = new Map(raw.prepare(`
            SELECT e.channel_id AS id, COUNT(DISTINCT e.phone) AS n
            FROM safety_events e LEFT JOIN channel_ops o ON o.channel_id = e.channel_id
            WHERE e.kind = 'report' AND e.channel_id IS NOT NULL
              AND e.at >= ? AND (o.resumed_at IS NULL OR e.at > o.resumed_at)
            GROUP BY e.channel_id`).all(stamp(at - 7 * DAY_MS)).map((r) => [r.id, r.n]));
        const policies = new Map();
        const paused = [];
        for (const row of raw.prepare("SELECT * FROM whatsapp_channels WHERE status = 'active'").all()) {
            const state = stateOf(row.tenant_id, row.id);
            if (state?.transport?.isConnected?.()) upsert(row.id, { last_seen_at: stamp(at) });
            if (!policies.has(row.tenant_id)) policies.set(row.tenant_id, policy.resolve(row.tenant_id).values);
            const p = policies.get(row.tenant_id);
            if (!p['channels.banGuardEnabled']) continue;

            const s = stats.get(`${row.tenant_id}:${row.id}`);
            const total = Number(s?.total ?? 0);
            const pct = total ? (Number(s.failed) / total) * 100 : 0;
            const reported = reports.get(row.id) ?? 0;
            const reportLimit = p['channels.banGuardReports'];
            let reason = null;
            if (reportLimit > 0 && reported >= reportLimit) {
                reason = `Auto-paused: ${reported} people reported this number as spam in 7 days (limit ${reportLimit}).`;
            } else if (total >= p['channels.banGuardMinSample'] && pct > p['channels.banGuardFailurePct']) {
                reason = `Auto-paused: ${Math.round(pct)}% of ${total} messages failed in 24 hours (limit ${p['channels.banGuardFailurePct']}%).`;
            }
            if (!reason) continue;
            await pause(row, reason, 'ban_guard');
            tenancy.audit({ tenantId: row.tenant_id, userId: null, action: 'channel.ban_guard.pause', target: row.id, detail: reason });
            paused.push({ channelId: row.id, tenantId: row.tenant_id, reason });
        }
        return paused;
    };

    /** Super admin per-number actions; every one is audited on the owning tenant. */
    const register = (admin, audit) => {
        admin.param('channelId', (req, res, next, id) => {
            const row = findRow(id);
            if (!row) return res.status(404).json({ errors: ['WhatsApp number not found.'] });
            req.channelRow = row;
            req.tenantId = row.tenant_id;
            return next();
        });

        admin.post('/numbers/:channelId/pause', async (req, res) => {
            const reason = String(req.body?.reason ?? '').trim().slice(0, 300) || 'Paused by the platform admin.';
            await pause(req.channelRow, reason, 'admin');
            audit(req, 'channel.admin.pause', req.channelRow.id, reason);
            return res.json({ ok: true });
        });

        admin.post('/numbers/:channelId/resume', (req, res) => {
            resume(req.channelRow);
            audit(req, 'channel.admin.resume', req.channelRow.id);
            // Back now, not at the watchdog's next pass (up to 30s of "Not connected" on the business's page).
            void Promise.resolve(req.app.locals.reconnectAll?.()).catch(() => undefined);
            return res.json({ ok: true });
        });

        admin.post('/numbers/:channelId/disconnect', async (req, res) => {
            const row = req.channelRow;
            // Off autoConnect first, or the watchdog brings it straight back.
            new Channels(db.forTenant(row.tenant_id)).update(row.id, { settings: { autoConnect: false } });
            await close(row.tenant_id, row.id, { logout: true });
            audit(req, 'channel.admin.disconnect', row.id);
            return res.json({ ok: true });
        });

        /**
         * Pin a QR number to a sending level (`{ level }`, 0..top) or clear the
         * pin (`{ level: null }`). The pin replaces the earned level, but every
         * brake still applies, the tenant's level cap still wins, and a ban
         * after the pin voids it (campaign/safety.js allowance).
         */
        admin.put('/numbers/:channelId/level', (req, res) => {
            const row = req.channelRow;
            // Only an explicit null unpins: a body that forgot the key must not clear a pin.
            if (!req.body || typeof req.body !== 'object' || !('level' in req.body)) {
                return res.status(400).json({ errors: ['Send { level }: a level, or null to clear the pin.'] });
            }
            const level = req.body.level;
            const quota = quotaOf(row);
            // Clearing always works: a pin set while the number was on QR must not stick once it moved to the sandbox.
            if (!quota.qr && level === null) {
                upsert(row.id, { level_pin: null, level_pinned_by: null, level_pinned_at: null });
                audit(req, 'channel.admin.level_unpin', row.id, 'not a QR-login number');
                return res.json({ earned: null, pinned: null, cap: null, effective: null, aboveEarned: false });
            }
            if (!quota.qr) return res.status(400).json({ errors: ['Sending levels apply to QR-login numbers only.'] });
            const top = quota.tables().levels.length - 1;
            if (level !== null && !(Number.isInteger(level) && level >= 0 && level <= top)) {
                return res.status(400).json({ errors: [`Level must be a whole number from 0 to ${top}, or null to clear the pin.`] });
            }
            upsert(row.id, level === null
                ? { level_pin: null, level_pinned_by: null, level_pinned_at: null }
                : { level_pin: level, level_pinned_by: req.user?.email ?? 'admin', level_pinned_at: stamp(now()) });
            quota.invalidate();
            const lv = quota.allowance().level;
            const out = {
                earned: lv.earned, pinned: lv.pinned ? level : null, cap: lv.cap ?? null,
                effective: lv.level, aboveEarned: level !== null && level > lv.earned,
            };
            audit(req, level === null ? 'channel.admin.level_unpin' : 'channel.admin.level_pin', row.id,
                `earned ${out.earned}, pin ${level ?? 'none'}, cap ${out.cap ?? 'none'}`);
            return res.json(out);
        });

        /**
         * Turn a QR number's brakes off for `{ hours }` (1..720), or back on (`{ hours: null }`). While off, the
         * reply, report, block, failure, ban and delivery brakes are ignored; WhatsApp's own restriction still
         * applies, and a ban after this voids it (campaign/safety.js allowance).
         */
        admin.put('/numbers/:channelId/brakes', (req, res) => {
            const row = req.channelRow;
            if (!req.body || typeof req.body !== 'object' || !('hours' in req.body)) {
                return res.status(400).json({ errors: ['Send { hours }: how long the brakes stay off, or null to turn them back on.'] });
            }
            const { hours } = req.body;
            if (hours !== null && !(Number.isInteger(hours) && hours >= 1 && hours <= 720)) {
                return res.status(400).json({ errors: ['Hours must be a whole number from 1 to 720, or null to turn the brakes back on.'] });
            }
            const quota = quotaOf(row);
            // Turning brakes back on always works, as clearing a pin does.
            if (!quota.qr && hours !== null) return res.status(400).json({ errors: ['Brakes apply to QR-login numbers only.'] });
            const t = now();
            upsert(row.id, hours === null
                ? { brakes_off_until: null, brakes_off_by: null, brakes_off_at: null }
                : { brakes_off_until: stamp(t + hours * 3_600_000), brakes_off_by: req.user?.email ?? 'admin', brakes_off_at: stamp(t) });
            quota.invalidate();
            const brakesOff = quota.allowance().level.brakesOff;
            audit(req, hours === null ? 'channel.admin.brakes_on' : 'channel.admin.brakes_off', row.id,
                hours === null ? 'brakes back on' : `brakes off for ${hours} h`);
            return res.json({ brakesOff });
        });

        /**
         * End a QR number's wait after linking, so bulk can start now. Only the
         * link wait: a ban still rests the number (humanize levelFor rests from
         * the later of linkedAt and the last ban), and every other rule applies.
         */
        admin.post('/numbers/:channelId/end-link-wait', (req, res) => {
            const row = req.channelRow;
            const quota = quotaOf(row);
            if (!quota.qr) return res.status(400).json({ errors: ['The wait after linking applies to QR-login numbers only.'] });
            new Channels(db.forTenant(row.tenant_id)).update(row.id, { settings: { linkedAt: '' } });
            const state = stateOf(row.tenant_id, row.id);
            if (state) {
                state.config = { ...state.config, linkedAt: '' };
                state.manager?.applyConfig(state.config);
            }
            const live = quotaOf(row);
            live.invalidate?.();
            const lv = live.allowance().level;
            audit(req, 'channel.admin.end_link_wait', row.id, `level ${lv.level}, resting ${lv.resting.active}`);
            return res.json({ level: lv.level, resting: lv.resting.active });
        });

        /**
         * Move a number to another business. Message history, conversations and
         * campaigns stay with the original tenant (their rows carry its
         * tenant_id); only the number and its settings move. A QR-login number
         * must scan again: its session folder belongs to the old tenant.
         */
        admin.post('/numbers/:channelId/move', async (req, res) => {
            const row = req.channelRow;
            const target = tenancy.getTenant(Number(req.body?.tenantId));
            if (!target || target.status === 'archived') return res.status(404).json({ errors: ['Target business not found.'] });
            if (target.id === row.tenant_id) return res.status(400).json({ errors: ['The number already belongs to that business.'] });
            const targetPolicy = policy.resolve(target.id).values;
            const cap = numberCap(target.limits, targetPolicy);
            const targetChannels = new Channels(db.forTenant(target.id));
            const count = targetChannels.list().length;
            if (cap && count >= cap) {
                return res.status(409).json({ errors: [`${target.name} already has ${count} of ${cap} allowed WhatsApp numbers.`] });
            }
            const blocked = providerBlocked(row.provider, target.limits, targetPolicy);
            if (blocked) return res.status(409).json({ errors: [`${target.name}: ${blocked}`] });
            const source = new Channels(db.forTenant(row.tenant_id));
            if (source.list().length === 1) {
                return res.status(409).json({ errors: ['A business must keep at least one WhatsApp number, so its only number cannot be moved.'] });
            }

            await close(row.tenant_id, row.id);
            // The new business links it when it chooses: a kept autoConnect would have the watchdog start a session
            // (a fresh QR on a QR-login number) in a business that has not even seen the number yet.
            source.update(row.id, { settings: { autoConnect: false } });
            // The pin and the answers (or a skip consented to) were the old business's: the number goes back to its
            // earned level, and the new business answers the questions or skips them with its own consent.
            upsert(row.id, { level_pin: null, level_pinned_by: null, level_pinned_at: null, start_level: null, start_answers: null, started_at: null, start_by_phone: null,
                brakes_off_until: null, brakes_off_by: null, brakes_off_at: null });
            raw.prepare('UPDATE whatsapp_channels SET tenant_id = ?, is_default = ?, updated_at = ? WHERE id = ?')
                .run(target.id, count ? 0 : 1, stamp(now()), row.id);
            if (row.is_default) {
                const next = source.list()[0];
                if (next) source.setDefault(next.id);
            }
            audit(req, 'channel.admin.move', row.id, `tenant ${row.tenant_id} -> ${target.id}`);
            tenancy.audit({ tenantId: target.id, userId: req.user?.id ?? null, action: 'channel.admin.move_in', target: row.id, detail: `from tenant ${row.tenant_id}` });
            return res.json({ ok: true, tenantId: target.id });
        });
    };

    /** The business resumes its own number, but only one the guard paused (an admin pause stays). */
    const resumeBanGuard = (channelId) => {
        const row = findRow(channelId);
        if (!row || pausedOf(channelId)?.by !== 'ban_guard') return false;
        resume(row);
        return true;
    };

    return { guard, register, rows, pausedOf, pinOf, startOf, setStart, switchPhone, resumeBanGuard };
}
