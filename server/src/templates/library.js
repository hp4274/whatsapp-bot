/**
 * The starter library: platform-wide template bodies a super admin curates and
 * any tenant can copy into its own templates. A copy is a plain tenant
 * template afterwards - editing the starter never rewrites what a tenant took.
 *
 * Global on purpose (no tenant_id): one list for the whole platform.
 */

import { TemplateError, TEMPLATE_CATEGORIES } from './store.js';
import { utcNow } from '../protocol.js';

const STARTERS = [
    ['Fee reminder', 'utility', 'Polite reminder that a school fee is due.',
        'Dear Parent, the {term} fee of {currency} {amount} for {studentName} is due on {dueAt}. Please pay on time to avoid a late fee. Pay here: {payLink}'],
    ['PTM invitation', 'utility', 'Invite parents to a parent-teacher meeting.',
        'Dear Parent, you are invited to the Parent-Teacher Meeting for {studentName} ({classKey}) on {date} at {time}. Venue: {venue}. Reply YES to confirm.'],
    ['Order update', 'utility', 'Tell a customer where their order is.',
        'Hi {name|there}, your order {orderId} is now {status}. Track it here: {trackingLink}. Thank you for shopping with {businessName}.'],
];

/**
 * Created and seeded here (called from migrateTemplates) rather than in
 * TEMPLATES_SCHEMA: seeding only when the table is first created means a
 * starter the admin deleted stays deleted across restarts.
 */
export function ensureLibrary(db) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'template_library'").get()) return;
    db.exec(`CREATE TABLE template_library (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        category    TEXT NOT NULL DEFAULT 'utility',
        description TEXT NOT NULL DEFAULT '',
        body        TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    )`);
    const now = utcNow();
    const put = db.prepare(`INSERT INTO template_library (name, category, description, body, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?)`);
    for (const [name, category, description, body] of STARTERS) put.run(name, category, description, body, now, now);
}

const toEntry = (row) => ({
    id: row.id, name: row.name, category: row.category, description: row.description,
    body: row.body, createdAt: row.created_at, updatedAt: row.updated_at,
});

export function listLibrary(db) {
    return db.prepare('SELECT * FROM template_library ORDER BY name').all().map(toEntry);
}

export function getLibraryEntry(db, id) {
    const row = db.prepare('SELECT * FROM template_library WHERE id = ?').get(Number(id));
    if (!row) throw new TemplateError('starter template not found', 404);
    return toEntry(row);
}

/** Create (id null) or replace one starter. */
export function saveLibraryEntry(db, id, input = {}) {
    const name = String(input.name ?? '').trim().slice(0, 80);
    const body = String(input.body ?? '').trim();
    const category = input.category ?? 'utility';
    if (!name) throw new TemplateError('a starter template needs a name');
    if (!body) throw new TemplateError('a starter template needs a message');
    if (!TEMPLATE_CATEGORIES.includes(category)) {
        throw new TemplateError(`category must be one of ${TEMPLATE_CATEGORIES.join(', ')}`);
    }
    const clash = db.prepare('SELECT id FROM template_library WHERE name = ?').get(name);
    if (clash && clash.id !== Number(id)) throw new TemplateError(`a starter named ${name} already exists`, 409);
    const description = String(input.description ?? '').trim().slice(0, 200);
    const now = utcNow();
    if (id == null) {
        const info = db.prepare(`INSERT INTO template_library (name, category, description, body, created_at, updated_at)
                                 VALUES (?, ?, ?, ?, ?, ?)`).run(name, category, description, body, now, now);
        return getLibraryEntry(db, info.lastInsertRowid);
    }
    getLibraryEntry(db, id);
    db.prepare('UPDATE template_library SET name = ?, category = ?, description = ?, body = ?, updated_at = ? WHERE id = ?')
        .run(name, category, description, body, now, Number(id));
    return getLibraryEntry(db, id);
}

export function removeLibraryEntry(db, id) {
    const entry = getLibraryEntry(db, id);
    db.prepare('DELETE FROM template_library WHERE id = ?').run(entry.id);
    return entry;
}
