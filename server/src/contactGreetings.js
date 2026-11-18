/**
 * Birthday greetings: the business names the contact detail that holds a date and the message, and the module sweep
 * (moduleSweeps.js) sends it once per contact per year on that day, after 9am on the number's clock.
 *
 * Settings are one JSON row per tenant, like the other modules' settings. The table is created here on first use so
 * the feature stays in this file. Keys starting with `_` are the sweep's bookkeeping and never leave the server.
 */

import { localClock } from './autoreply/engine.js';
import { personalize } from './protocol.js';
import { deliver } from './school/routes.js';
import { ruleCap } from './policy/modules.js';

export const GREETING_DEFAULTS = Object.freeze({
    enabled: false,
    field: '',
    message: 'Happy birthday {name}! Wishing you a wonderful year ahead.',
});

const SEND_FROM_HOUR = 9;
const ready = new WeakSet();

function table(db) {
    if (ready.has(db)) return;
    db.exec(`CREATE TABLE IF NOT EXISTS contact_greetings (
        tenant_id INTEGER PRIMARY KEY,
        data TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
    )`);
    ready.add(db);
}

function stored(db, tenantId) {
    table(db);
    const row = db.prepare('SELECT data FROM contact_greetings WHERE tenant_id = ?').get(Number(tenantId));
    try {
        return row ? JSON.parse(row.data) : {};
    } catch {
        return {}; // a corrupt row reads as defaults rather than taking the page down
    }
}

/** What the Contacts page shows and edits. */
export function getGreetings(db, tenantId) {
    const data = stored(db, tenantId);
    return Object.fromEntries(Object.keys(GREETING_DEFAULTS).map((key) => [key, data[key] ?? GREETING_DEFAULTS[key]]));
}

/** Check and save a patch; returns { settings } or { error }. */
export function saveGreetings(db, tenantId, patch = {}) {
    const next = { ...getGreetings(db, tenantId) };
    if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') return { error: 'enabled must be true or false' };
        next.enabled = patch.enabled;
    }
    if (patch.field !== undefined) next.field = String(patch.field).trim().slice(0, 100);
    if (patch.message !== undefined) next.message = String(patch.message).trim().slice(0, 2000);
    if (next.enabled && !next.field) return { error: 'Pick the contact detail that holds the date.' };
    if (next.enabled && !next.message) return { error: 'Write the greeting message.' };
    // A changed setup runs again today; deliver()'s key still stops a second greeting to anyone.
    const data = { ...stored(db, tenantId), ...next, _doneDay: null };
    db.prepare(`INSERT INTO contact_greetings (tenant_id, data, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(tenant_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
        .run(Number(tenantId), JSON.stringify(data), new Date().toISOString());
    return { settings: next };
}

/** { day, month } from DD/MM, DD-MM, DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD (also with dots), or null. */
export function parseDayMonth(value) {
    const text = String(value ?? '').trim();
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
    const [day, month] = m ? [Number(m[3]), Number(m[2])] : (() => {
        m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2}|\d{4}))?$/.exec(text);
        return m ? [Number(m[1]), Number(m[2])] : [0, 0];
    })();
    const longest = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return longest && day >= 1 && day <= longest ? { day, month } : null;
}

/** Whether a date falls on local `date` (YYYY-MM-DD); 29 Feb is greeted on 28 Feb in other years. */
function isToday(dm, date) {
    const [year, month, day] = date.split('-').map(Number);
    if (dm.month !== month) return false;
    if (dm.day === day) return true;
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return dm.month === 2 && dm.day === 29 && day === 28 && !leap;
}

/**
 * The sweep: once a day per business, after 9am local, greet every contact whose date is today.
 * Returns { sent, skipped } (or null when it had nothing to do), for tests.
 */
export function greetingSweep(state, now = new Date()) {
    const policy = state.platformPolicy?.() ?? {};
    if (policy['contacts.allowDateGreetings'] === false) return null;
    const db = state.db.db;
    const tenantId = state.db.tenantId;
    const settings = stored(db, tenantId);
    if (!settings.enabled || !settings.field || !settings.message) return null;
    const clock = localClock(now, state.channel?.timezone || 'UTC');
    if (clock.hour < SEND_FROM_HOUR || settings._doneDay === clock.date) return null;

    const due = db.prepare(`SELECT id, json_extract(custom_fields, '$."' || ? || '"') AS d FROM contacts
                            WHERE tenant_id = ? AND status = 'active' AND d IS NOT NULL`)
        .all(settings.field, tenantId)
        .filter((row) => {
            const dm = parseDayMonth(row.d);
            return dm && isToday(dm, clock.date);
        })
        .map((row) => row.id);

    const cap = ruleCap(policy, 'contacts.maxGreetingsPerDay');
    const result = { sent: 0, skipped: 0 };
    const year = clock.date.slice(0, 4);
    for (let i = 0; i < due.length; i += 1000) {
        for (const contact of state.contacts.find({ ids: due.slice(i, i + 1000) }, { limit: 1000 })) {
            if (cap !== null && result.sent >= cap) break;
            if (!contact.messageable) { result.skipped += 1; continue; }
            const outcome = deliver(state, {
                recipient: contact.phone,
                text: personalize(settings.message, { name: contact.name ?? '', phone: contact.phone, ...contact.customFields }),
                key: `greeting.birthday.${contact.phone}.${year}`,
                messageType: 'reminder',
            });
            result[outcome === 'sent' ? 'sent' : 'skipped'] += 1;
        }
    }
    db.prepare('UPDATE contact_greetings SET data = ? WHERE tenant_id = ?')
        .run(JSON.stringify({ ...settings, _doneDay: clock.date }), tenantId);
    return result;
}
