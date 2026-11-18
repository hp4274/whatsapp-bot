/**
 * Leads made from WhatsApp: the business's "make a lead from every new person who messages" switch, and the capture
 * itself, called from app.js handleInbound right after opt-out (so a STOP never becomes a lead).
 */

import { objectCapError, ruleCap } from '../policy/modules.js';

const TABLE = `
CREATE TABLE IF NOT EXISTS lead_settings (
    tenant_id   INTEGER PRIMARY KEY,
    settings    TEXT NOT NULL DEFAULT '{}',
    updated_at  TEXT NOT NULL
);`;

export const DEFAULT_LEAD_SETTINGS = Object.freeze({ autoCapture: false });

/** @param {import('../db.js').Database} database a tenant- or channel-scoped handle */
export function leadSettings(database) {
    database.db.exec(TABLE);
    const row = database.db.prepare('SELECT settings FROM lead_settings WHERE tenant_id = ?').get(database.tenantId);
    let saved = {};
    try {
        saved = row ? JSON.parse(row.settings) : {};
    } catch { /* a broken row reads as the defaults */ }
    return { ...DEFAULT_LEAD_SETTINGS, ...saved };
}

export function saveLeadSettings(database, patch = {}) {
    const next = { autoCapture: Boolean(patch.autoCapture ?? leadSettings(database).autoCapture) };
    database.db.prepare(`INSERT INTO lead_settings (tenant_id, settings, updated_at) VALUES (?, ?, ?)
                         ON CONFLICT(tenant_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`)
        .run(database.tenantId, JSON.stringify(next), new Date().toISOString());
    return next;
}

const OPEN = ['new', 'contacted', 'qualified'];

/**
 * One open lead per person: made from their message when the business switched capture on and the platform allows
 * it. Returns the new lead, or null when nothing was made.
 */
export async function captureLead(state, message, now = new Date()) {
    const tenant = state.tenancy?.getTenant?.(state.db.tenantId);
    if (!tenant?.services?.includes('leads') || !state.objects || !state.contacts) return null;
    const policy = state.platformPolicy?.() ?? {};
    if (policy['leads.autoCapture'] === false || !leadSettings(state.db).autoCapture) return null;
    const phone = String(message.sender ?? '');
    if (!/^\d{6,15}$/.test(phone)) return null; // groups and broadcasts are not people

    const existing = state.contacts.getByPhone(phone) ?? state.contacts.getByPhone(state.contacts.normalize(phone, true));
    if (existing && OPEN.some((status) => state.objects.count({ type: 'lead', contactId: existing.id, status }))) return null;
    const cap = ruleCap(policy, 'leads.maxAutoPerDay');
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (cap && state.objects.count({ type: 'lead', filter: { source: 'whatsapp' }, createdSince: today }) >= cap) return null;
    if (objectCapError(policy, state.objects, 'lead', now)) return null;

    const contact = existing ?? state.contacts.upsert({ phone, name: message.senderName || undefined, source: 'whatsapp' });
    const name = contact?.name || message.senderName || '';
    return state.objects.create('lead', {
        contactId: contact?.id ?? null, source: 'whatsapp', metadata: { auto: true },
        data: { name, phone, source: 'whatsapp', interest: String(message.body ?? '').trim().slice(0, 200) || undefined },
    });
}
