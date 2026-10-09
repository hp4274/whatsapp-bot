/**
 * School settings: one JSON row per tenant. Listed in `MODULE_SCHEMAS`.
 *
 * A row rather than columns because the portal grows a toggle every few weeks
 * and a migration per toggle buys nothing; the defaults below are the schema.
 * Staff profiles (title + classes per user id) live here too: they are school
 * configuration, not identity, so `users` stays industry-neutral.
 *
 * Keys starting with `_` are the sweep's bookkeeping (last auto-alert date,
 * last monthly summary) and never leave the server.
 */

export const SCHOOL_SCHEMA = `
CREATE TABLE IF NOT EXISTS school_settings (
    tenant_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);
`;

export const SETTINGS_DEFAULTS = Object.freeze({
    schoolName: '',
    gateCutoff: '08:15',
    homeworkSendTime: '15:00',
    absentAlertTime: null,
    monthlySummary: false,
    commandsEnabled: true,
    upiId: '',
    payeeName: '',
    currency: 'INR',
    staff: {},
});

/**
 * The tenant's settings, defaults filled in. The row is created on first read
 * so the sweep's "which tenants run a school" query only sees tenants that
 * have opened the portal or used a school route.
 */
export function getSettings(db, tenantId) {
    const row = db.prepare('SELECT data FROM school_settings WHERE tenant_id = ?').get(Number(tenantId));
    if (!row) {
        db.prepare('INSERT OR IGNORE INTO school_settings (tenant_id, data, updated_at) VALUES (?, ?, ?)')
            .run(Number(tenantId), '{}', new Date().toISOString());
    }
    let data = {};
    try {
        data = row ? JSON.parse(row.data) : {};
    } catch {
        // A corrupt row reads as defaults rather than taking the portal down.
    }
    return { ...SETTINGS_DEFAULTS, ...data, staff: { ...(data.staff ?? {}) } };
}

/** Merge `patch` over the stored settings. Callers validate; this only persists. */
export function saveSettings(db, tenantId, patch) {
    const next = { ...getSettings(db, tenantId), ...patch };
    db.prepare('UPDATE school_settings SET data = ?, updated_at = ? WHERE tenant_id = ?')
        .run(JSON.stringify(next), new Date().toISOString(), Number(tenantId));
    return next;
}

/** What the API shows: no staff map, no bookkeeping. */
export function publicSettings(settings) {
    return Object.fromEntries(Object.keys(SETTINGS_DEFAULTS).filter((k) => k !== 'staff').map((k) => [k, settings[k]]));
}
