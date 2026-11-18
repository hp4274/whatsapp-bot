/**
 * Ordering and booking on WhatsApp. Two independent modes, one per feature: `order` (products, the Orders service)
 * and `booking` (services, the Appointments service). Each has its own settings and its own list, so one business
 * can take orders and bookings side by side. What they create are business objects (`order` / `appointment` in
 * objects/types.js), so the Records pages, workflows and the public API see them with no extra code.
 *
 * Lists are per business, not per number: every number sells the same things. A contact has one cart per number,
 * in one mode at a time.
 */

export const MODES = Object.freeze(['order', 'booking']);
/** The service each mode belongs to (tenancy.js TENANT_SERVICES). */
export const MODE_SERVICE = Object.freeze({ order: 'orders', booking: 'appointments' });
/** A cart nobody touched for a day is forgotten, so a "2" next week is not read as "add item 2". */
export const CART_HOURS = 24;
/** After an order is placed, PAID or a screenshot counts as the payment for it for this long. */
export const PAY_HOURS = 72;
/** Pictures per product; the first is its cover (the list row and the WhatsApp carousel card). */
export const MAX_IMAGES = 5;

export const DEFAULT_SHOP = Object.freeze({
    enabled: false,
    title: '',
    currency: 'INR',
    upiId: '',
    payeeName: '',
    // An uploaded QR image (PhonePe/GPay/Paytm) sent instead of one made from the UPI ID.
    qrMediaId: '',
    payNow: true,
    askAddress: true,
    deliveryFee: 0,
    note: '',
    // Hours, address, phone: answered to INFO / ADDRESS / TIMINGS.
    info: '',
    // Bookings only: remind the customer this many hours before (0 = off). Sent by objects/sweeps.js.
    reminderHours: 0,
    // Message the owner (moduleSweeps.js ownerAlert) on each new order/booking and each PAID reply.
    alertOwner: true,
});

const TABLES = `
CREATE TABLE IF NOT EXISTS shop_config (
    tenant_id   INTEGER NOT NULL,
    mode        TEXT NOT NULL,
    settings    TEXT NOT NULL DEFAULT '{}',
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (tenant_id, mode)
);
CREATE TABLE IF NOT EXISTS shop_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL,
    mode        TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL DEFAULT '',
    price       REAL NOT NULL DEFAULT 0,
    variants    TEXT NOT NULL DEFAULT '[]',
    media_id    TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1,
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_items ON shop_items(tenant_id, mode, sort, id);
CREATE TABLE IF NOT EXISTS shop_baskets (
    tenant_id   INTEGER NOT NULL,
    channel_id  INTEGER NOT NULL DEFAULT 0,
    phone       TEXT NOT NULL,
    mode        TEXT NOT NULL,
    items       TEXT NOT NULL DEFAULT '[]',
    stage       TEXT NOT NULL DEFAULT 'browse',
    data        TEXT NOT NULL DEFAULT '{}',
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (tenant_id, channel_id, phone)
);
`;

export class ShopError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

const checkMode = (mode) => {
    if (!MODES.includes(mode)) throw new ShopError('unknown mode', 404);
    return mode;
};

export class ShopStore {
    /** @param {import('../db.js').Database} database a tenant- or channel-scoped handle */
    constructor(database) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.channelId = database.channelId ?? 0;
        this.db.exec(TABLES);
        // Several pictures per product, added after the table shipped; `media_id` keeps the cover for older readers.
        const cols = this.db.prepare('PRAGMA table_info(shop_items)').all().map((c) => c.name);
        if (!cols.includes('images')) this.db.exec(`ALTER TABLE shop_items ADD COLUMN images TEXT NOT NULL DEFAULT '[]'`);
    }

    /** One mode's settings; `mode` is carried on them so the chat code knows which it is talking about. */
    settings(mode) {
        checkMode(mode);
        const row = this.db.prepare('SELECT settings FROM shop_config WHERE tenant_id = ? AND mode = ?').get(this.tenantId, mode);
        return { ...DEFAULT_SHOP, ...parse(row?.settings, {}), mode };
    }

    saveSettings(mode, patch = {}) {
        const { mode: _ignored, ...current } = this.settings(mode);
        const next = cleanSettings({ ...current, ...patch });
        this.db.prepare(`INSERT INTO shop_config (tenant_id, mode, settings, updated_at) VALUES (?, ?, ?, ?)
                         ON CONFLICT(tenant_id, mode) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`)
            .run(this.tenantId, mode, JSON.stringify(next), new Date().toISOString());
        return { ...next, mode };
    }

    products(mode, { activeOnly = false } = {}) {
        checkMode(mode);
        return this.db.prepare(`SELECT * FROM shop_items WHERE tenant_id = ? AND mode = ? ${activeOnly ? 'AND active = 1' : ''}
                                ORDER BY sort, id`).all(this.tenantId, mode).map(toProduct);
    }

    product(id, mode = null) {
        const row = this.db.prepare('SELECT * FROM shop_items WHERE id = ? AND tenant_id = ?').get(Number(id), this.tenantId);
        return row && (!mode || row.mode === mode) ? toProduct(row) : null;
    }

    saveProduct(mode, input, id = null) {
        checkMode(mode);
        const p = cleanProduct(input);
        const now = new Date().toISOString();
        if (id === null) {
            const sort = this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM shop_items WHERE tenant_id = ? AND mode = ?').get(this.tenantId, mode).n;
            const info = this.db.prepare(`INSERT INTO shop_items (tenant_id, mode, name, description, category, price, variants, media_id, images, active, sort, created_at, updated_at)
                                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(this.tenantId, mode, p.name, p.description, p.category, p.price, JSON.stringify(p.variants), p.images[0] ?? '', JSON.stringify(p.images), p.active ? 1 : 0, sort, now, now);
            return this.product(info.lastInsertRowid);
        }
        if (!this.product(id, mode)) throw new ShopError('item not found', 404);
        this.db.prepare(`UPDATE shop_items SET name = ?, description = ?, category = ?, price = ?, variants = ?, media_id = ?, images = ?, active = ?, updated_at = ?
                         WHERE id = ? AND tenant_id = ?`)
            .run(p.name, p.description, p.category, p.price, JSON.stringify(p.variants), p.images[0] ?? '', JSON.stringify(p.images), p.active ? 1 : 0, now, Number(id), this.tenantId);
        return this.product(id);
    }

    removeProduct(mode, id) {
        const info = this.db.prepare('DELETE FROM shop_items WHERE id = ? AND tenant_id = ? AND mode = ?').run(Number(id), this.tenantId, mode);
        if (!info.changes) throw new ShopError('item not found', 404);
    }

    /**
     * The contact's cart on this number (with its mode); an empty one when it is missing or stale. `cartHours`
     * ({ order, booking }) is the platform's "forget an unfinished chat" rule per mode; CART_HOURS without one.
     */
    cart(phone, now = new Date(), cartHours = {}) {
        const row = this.db.prepare('SELECT * FROM shop_baskets WHERE tenant_id = ? AND channel_id = ? AND phone = ?')
            .get(this.tenantId, this.channelId, String(phone));
        const empty = { mode: null, items: [], stage: 'browse', data: {}, live: false };
        if (!row) return empty;
        const cart = { mode: row.mode, items: parse(row.items, []), stage: row.stage, data: parse(row.data, {}) };
        const hours = cart.stage === 'pay' ? PAY_HOURS : Number(cartHours[cart.mode]) || CART_HOURS;
        if (now - new Date(row.updated_at) > hours * 3_600_000) return empty;
        return { ...cart, live: true };
    }

    saveCart(phone, { mode, items = [], stage = 'browse', data = {} }, now = new Date()) {
        checkMode(mode);
        this.db.prepare(`INSERT INTO shop_baskets (tenant_id, channel_id, phone, mode, items, stage, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(tenant_id, channel_id, phone) DO UPDATE SET mode = excluded.mode, items = excluded.items, stage = excluded.stage,
                           data = excluded.data, updated_at = excluded.updated_at`)
            .run(this.tenantId, this.channelId, String(phone), mode, JSON.stringify(items), stage, JSON.stringify(data), now.toISOString());
    }

    clearCart(phone) {
        this.db.prepare('DELETE FROM shop_baskets WHERE tenant_id = ? AND channel_id = ? AND phone = ?')
            .run(this.tenantId, this.channelId, String(phone));
    }
}

function toProduct(row) {
    return {
        id: row.id, name: row.name, description: row.description, category: row.category, price: row.price,
        variants: parse(row.variants, []), images: imagesOf(row), active: Boolean(row.active), sort: row.sort,
    };
}

/** A row saved before `images` existed has only `media_id`: that picture is its one image. */
function imagesOf(row) {
    const images = parse(row.images, []);
    return Array.isArray(images) && images.length ? images : row.media_id ? [row.media_id] : [];
}

const MEDIA_ID = /^med_[a-f0-9]{12}$/;

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const money = (v) => {
    const n = Math.round(Number(v) * 100) / 100;
    return Number.isFinite(n) && n >= 0 ? n : NaN;
};

export function cleanProduct(input = {}) {
    const name = str(input.name, 80);
    if (!name) throw new ShopError('a product needs a name');
    const price = money(input.price ?? 0);
    if (Number.isNaN(price)) throw new ShopError('price must be 0 or more');
    const variants = (Array.isArray(input.variants) ? input.variants : [])
        .map((v) => ({ name: str(v?.name, 40), price: money(v?.price === '' || v?.price == null ? price : v.price) }))
        .filter((v) => v.name);
    if (variants.some((v) => Number.isNaN(v.price))) throw new ShopError('each option needs a price of 0 or more');
    if (variants.length > 20) throw new ShopError('a product can have up to 20 options');
    // `mediaId` is the one-picture shape older clients send.
    const raw = Array.isArray(input.images) ? input.images : input.mediaId ? [input.mediaId] : [];
    const images = [...new Set(raw.map((id) => String(id ?? '')))];
    if (images.some((id) => !MEDIA_ID.test(id))) throw new ShopError('a picture is not an uploaded image');
    if (images.length > MAX_IMAGES) throw new ShopError(`a product can have up to ${MAX_IMAGES} pictures`);
    return {
        name, price, variants, description: str(input.description, 300), category: str(input.category, 40),
        images,
        active: input.active !== false,
    };
}

function cleanSettings(s) {
    const fee = money(s.deliveryFee ?? 0);
    if (Number.isNaN(fee)) throw new ShopError('delivery charge must be 0 or more');
    const upiId = str(s.upiId, 80);
    if (upiId && !/^[\w.-]{2,}@[\w.-]{2,}$/.test(upiId)) throw new ShopError('UPI ID looks wrong (it should be like name@bank)');
    const reminderHours = Number(s.reminderHours ?? 0);
    if (!Number.isInteger(reminderHours) || reminderHours < 0 || reminderHours > 168) {
        throw new ShopError('reminder must be a whole number of hours from 0 to 168');
    }
    return {
        enabled: Boolean(s.enabled),
        title: str(s.title, 60),
        currency: str(s.currency, 3).toUpperCase() || 'INR',
        upiId,
        payeeName: str(s.payeeName, 60),
        qrMediaId: MEDIA_ID.test(String(s.qrMediaId ?? '')) ? s.qrMediaId : '',
        payNow: s.payNow !== false,
        askAddress: s.askAddress !== false,
        deliveryFee: fee,
        note: str(s.note, 300),
        info: str(s.info, 1000),
        reminderHours,
        alertOwner: s.alertOwner !== false,
    };
}

function parse(value, fallback) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch {
        return fallback;
    }
}
