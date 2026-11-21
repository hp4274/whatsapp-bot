/**
 * A business's number collection (the super admin's Number collections page): one row per business holding
 * [{ phone, name, from }]. `from` lists where a number came from: a linked WhatsApp number's digits, or 'upload' for a
 * CSV or pasted list. One entry per phone, never per name: the same person from two sources is one entry with one
 * name and both sources.
 */

/** The marker for numbers a business uploaded (CSV, Excel or a pasted list) rather than fetched from WhatsApp. */
export const UPLOAD = 'upload';

const MAX = 50000;

const cleanFrom = (from) => (Array.isArray(from) ? from : [])
    .map((a) => (String(a) === UPLOAD ? UPLOAD : String(a).replace(/\D/g, '').slice(0, 15)))
    .filter(Boolean).slice(0, 20);

/** [{ phone, name, from }] from a stored row; rows saved before names or sources were kept hold plain strings. */
export function readEntries(json) {
    try {
        return JSON.parse(json).map((c) => (typeof c === 'string' ? { phone: c, name: '' } : c));
    } catch {
        return []; // a damaged row still lists, with no numbers
    }
}

/**
 * Fold `entries` into `base` by phone: the first non-empty name wins and the sources add up. Returns a new list,
 * `base` order first. Bad phones (under 7 or over 15 digits) are dropped.
 */
export function mergeEntries(base, entries) {
    const byPhone = new Map();
    for (const raw of [...base, ...entries]) {
        const phone = String((typeof raw === 'string' ? raw : raw?.phone) ?? '').replace(/\D/g, '');
        if (phone.length < 7 || phone.length > 15) continue;
        const name = String(raw?.name ?? '').trim().slice(0, 100);
        const from = cleanFrom(raw?.from);
        const row = byPhone.get(phone);
        if (!row) {
            byPhone.set(phone, { phone, name, ...(from.length ? { from } : {}) });
            continue;
        }
        if (!row.name && name) row.name = name;
        const all = [...new Set([...(row.from ?? []), ...from])];
        if (all.length) row.from = all;
    }
    return [...byPhone.values()].slice(0, MAX);
}

const rowOf = (db, tenantId) => db.prepare('SELECT account, numbers FROM number_collections WHERE tenant_id = ?').get(tenantId);

const write = (db, tenantId, account, entries) => {
    const createdAt = new Date().toISOString();
    db.prepare(`
        INSERT INTO number_collections (tenant_id, account, numbers, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET
            account = excluded.account, numbers = excluded.numbers, created_at = excluded.created_at`)
        .run(tenantId, account, JSON.stringify(entries), createdAt);
    return createdAt;
};

/**
 * The super admin saved a fresh WhatsApp read: it replaces what was fetched before, but numbers the business
 * uploaded stay (only their upload source is kept, so a number no longer on WhatsApp does not claim to be).
 */
export function saveFetched(db, tenantId, account, entries) {
    const before = rowOf(db, tenantId);
    const uploads = before ? readEntries(before.numbers)
        .filter((c) => (c.from ?? []).includes(UPLOAD))
        .map((c) => ({ phone: c.phone, name: c.name, from: [UPLOAD] })) : [];
    const merged = mergeEntries(uploads, entries);
    return { entries: merged, createdAt: write(db, tenantId, account, merged) };
}

/** A business uploaded numbers: they join its collection as `upload`, merged by phone with what is there. */
export function addUploaded(db, tenantId, contacts) {
    const entries = (contacts ?? []).map((c) => ({ phone: c.phone, name: c.name ?? '', from: [UPLOAD] }));
    if (!entries.length) return;
    const before = rowOf(db, tenantId);
    write(db, tenantId, before?.account ?? '', mergeEntries(before ? readEntries(before.numbers) : [], entries));
}
