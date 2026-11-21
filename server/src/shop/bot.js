/**
 * Ordering and booking on WhatsApp. MENU (or ORDER) shows the products, BOOK shows the services; a number adds to
 * the cart (or picks the service), CHECKOUT asks for the address and places the order, the payment QR goes out
 * with it, PAID (or a screenshot) tells the business, and STATUS lists the customer's orders and bookings. INFO
 * answers with the business's details.
 *
 * Each mode belongs to its own feature - orders to the Orders service, bookings to Appointments - and answers only
 * for a business that has that service and switched it on (store.js). Neither is part of Auto replies.
 *
 * Text, because QR-linked numbers cannot send native buttons (see messaging/interactive.js): every step says which
 * word or number to reply with. The one exception is the list itself: with 2+ pictured products it also carries a
 * swipe carousel (the platform sends those natively), whose "Add 3" / "Book 3" taps read exactly like typing 3.
 *
 * Called from `handleInbound` after opt-out and the bot-pause checks, before HELP, the FAQ and keyword rules. Numbers
 * are only read as picks while the contact has a live cart, so a keyword rule's own "1 / 2 / 3" menu still works for
 * everyone else. Every reply's idempotency key comes from the inbound message id, so a redelivery is answered once.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeInteractive } from '../messaging/interactive.js';
import { deliver, localNow, zonedToUtc } from '../school/routes.js';
import { ownerAlert } from '../moduleSweeps.js';
import { objectCapError } from '../policy/modules.js';
import { MODES, MODE_SERVICE, ShopStore } from './store.js';

const ORDER_START = new Set(['MENU', 'SHOP', 'CATALOG', 'CATALOGUE', 'PRODUCTS', 'ORDER', 'PRICE', 'PRICES', 'PRICELIST']);
const BOOK_START = new Set(['BOOK', 'BOOKING', 'SERVICES', 'APPOINTMENT', 'SLOT']);
const STATUS = new Set(['STATUS', 'TRACK', 'ORDERS', 'MYORDERS', 'MYORDER', 'BOOKINGS', 'MYBOOKING']);
const INFO = new Set(['INFO', 'ADDRESS', 'LOCATION', 'TIMING', 'TIMINGS', 'HOURS', 'CONTACT', 'ABOUT']);
const CART = new Set(['CART', 'BASKET', 'BAG']);
const CHECKOUT = new Set(['CHECKOUT', 'PLACE', 'PLACEORDER', 'CONFIRM', 'DONE']);
const CLEAR = new Set(['CLEAR', 'EMPTY', 'CANCEL']);
const PAID = new Set(['PAID', 'PAYMENTDONE', 'DONEPAYMENT', 'PAYED']);
const MAX_LIST = 40;
const MAX_QTY = 99;
/** WhatsApp's carousel holds 2 to 5 cards. */
const MAX_CARDS = 5;

/** True when the business has the service this mode belongs to (Orders for `order`, Appointments for `booking`). */
export function shopAllowed(state, mode) {
    const services = state.tenancy?.getTenant?.(state.db.tenantId)?.services ?? [];
    return services.includes(MODE_SERVICE[mode]) && rule(state, mode, 'allowWhatsapp') !== false;
}

/** A platform rule for this mode: `orders.*` or `appointments.*` (policy/modules.js). */
const rule = (state, mode, name) => state.platformPolicy?.()?.[`${MODE_SERVICE[mode]}.${name}`];

/** Each mode's settings the business can use, in MODES order. */
export function usableModes(state, store = new ShopStore(state.db)) {
    return MODES.filter((mode) => shopAllowed(state, mode)).map((mode) => store.settings(mode));
}

/** The HELP list's lines for the modes that are on. */
export function shopHelpLines(modes) {
    const on = modes.filter((s) => s.enabled);
    const lines = [];
    if (on.some((s) => s.mode === 'order')) lines.push('MENU - see products and order', 'CART - your cart', 'CHECKOUT - place the order');
    if (on.some((s) => s.mode === 'booking')) lines.push('BOOK - see services and book');
    if (on.length) lines.push('STATUS - your orders and bookings');
    if (modes.some((s) => s.info)) lines.push('INFO - address, timings and contact');
    return lines;
}

/**
 * @returns {Promise<{ handled: boolean, sent?: boolean }>}
 */
export async function handleShopCommand(state, message, { greeting = '', now = new Date() } = {}) {
    const store = new ShopStore(state.db);
    const modes = usableModes(state, store);
    if (!modes.length) return { handled: false };
    const typed = String(message.body ?? '').trim();
    // A carousel tap (id SHOP_3, title "Add 3" / "Book 3") is the customer typing 3.
    const tap = /^SHOP_(\d{1,3})$/.exec(String(message.replyId ?? '')) ?? /^(?:add|book)\s*(\d{1,3})$/i.exec(typed);
    const body = tap ? tap[1] : typed;
    const word = body.toUpperCase().replace(/[^A-Z]/g, '');
    const phone = message.sender;
    const reply = (text, media = null, tag = word.toLowerCase() || 'shop', interactive = null) => {
        const outcome = deliver(state, {
            recipient: phone, messageType: 'auto_reply', key: `shop.${message.messageId}`,
            text: greeting ? `${greeting}\n\n${text}` : text, media, interactive,
        });
        state.db.markInboundReplied?.(message.messageId, `shop:${tag}`);
        state.broadcast?.({ type: 'changed', topic: 'shop' });
        return { handled: true, sent: outcome === 'sent' };
    };

    const info = modes.find((s) => s.info)?.info;
    if (info && INFO.has(word)) return reply(info, null, 'info');
    const on = modes.filter((s) => s.enabled);
    if (!on.length) return { handled: false };
    const ctxFor = (settings) => ({ state, store, settings, phone, message, now, money: moneyIn(settings.currency) });

    const cart = store.cart(phone, now, { order: rule(state, 'order', 'cartHours'), booking: rule(state, 'booking', 'cartHours') });
    // A hint, not a parse: "order status" / "where is my order" is a status question, not a new order.
    if (STATUS.has(word) || /\b(status|track|where is my)\b/i.test(body) && /\b(order|booking)\b/i.test(body)) {
        return reply(statusText(ctxFor(on[0])), null, 'status');
    }
    const cartMode = cart.live ? on.find((s) => s.mode === cart.mode) : null;
    if (cartMode) {
        // A tap picks from the list even while an option or a time was being asked for.
        const picking = tap && ['variant', 'when'].includes(cart.stage) ? { ...cart, stage: 'browse', data: {} } : cart;
        const answer = await inSession(ctxFor(cartMode), picking, body, word);
        if (answer) return reply(answer.text, answer.media ?? null);
    }
    // BOOK opens the services, MENU the products; with only one mode on, either word opens that one.
    const wanted = BOOK_START.has(word) ? 'booking' : ORDER_START.has(word) ? 'order' : null;
    const settings = wanted && (on.find((s) => s.mode === wanted) ?? (on.length === 1 ? on[0] : null));
    if (settings) {
        // A rule's half-answered menu would otherwise take the next "2" too.
        state.autoReply?.store?.clearSession?.(phone);
        const keep = cart.live && cart.mode === settings.mode ? cart.items : [];
        store.saveCart(phone, { mode: settings.mode, items: keep, stage: 'browse', data: {} }, now);
        const ctx = ctxFor(settings);
        return reply(catalogueText(ctx), null, 'menu', catalogueCarousel(ctx));
    }
    const shop = on.find((s) => s.mode === 'order');
    if (CART.has(word) && shop) return reply(cartText(ctxFor(shop), []), null, 'cart');
    return { handled: false };
}

/** A message from someone with a live cart. Null when it is not for the shop (the rules answer instead). */
async function inSession(ctx, cart, body, word) {
    const { store, phone, now, settings } = ctx;
    const save = (patch) => store.saveCart(phone, { ...cart, ...patch }, now);

    if (cart.stage === 'pay') {
        if (PAID.has(word) || ctx.message.mediaType === 'image') return paid(ctx, cart);
        return null; // anything else after an order is a normal message
    }
    if (CLEAR.has(word)) {
        store.clearCart(phone);
        return { text: settings.mode === 'booking' ? 'Cancelled. Send BOOK any time to start again.' : 'Your cart is empty now. Send MENU to start again.' };
    }
    if (cart.stage === 'address') {
        if (body.length < 8) return { text: 'Please send your full delivery address (house, street, area, city, PIN).' };
        return place(ctx, cart, { address: body.slice(0, 300) });
    }
    if (cart.stage === 'when') {
        const at = parseWhen(body, ctx.state.channel?.timezone, now);
        if (!at) return { text: 'Sorry, I could not read that. Send a date and time like *25/11 4pm* or *tomorrow 11am*.' };
        if (at < now) return { text: 'That time has passed. Send a date and time in the future, like *tomorrow 11am*.' };
        return place(ctx, cart, { scheduledAt: at.toISOString() });
    }
    if (cart.stage === 'variant') {
        const product = store.product(cart.data.productId);
        const variant = /^\d{1,2}$/.test(body) ? product?.variants[Number(body) - 1] : null;
        if (variant) return add(ctx, cart, product, variant, cart.data.qty ?? 1);
        if (product && /^\d+$/.test(body)) return { text: `Reply with an option number from 1 to ${product.variants.length}.` };
        return null;
    }
    if (CART.has(word) && settings.mode === 'order') return { text: cartText(ctx, cart.items) };
    if (CHECKOUT.has(word) && settings.mode === 'order') {
        if (!cart.items.length) return { text: 'Your cart is empty. Send MENU to see what we have.' };
        if (settings.askAddress) {
            save({ stage: 'address' });
            return { text: 'Almost done! Please send your delivery address (house, street, area, city, PIN).' };
        }
        return place(ctx, cart, {});
    }
    const remove = /^remove\s+(\d+)$/i.exec(body);
    if (remove && settings.mode === 'order') {
        const items = cart.items.filter((_, i) => i !== Number(remove[1]) - 1);
        save({ items });
        return { text: cartText(ctx, items) };
    }
    // "3", "3 x 2", "3x2", "3 2": item 3, two of them.
    const pick = /^(\d{1,3})(?:\s*[x*×]\s*|\s+)?(\d{1,2})?$/i.exec(body);
    if (!pick) return null;
    const products = store.products(settings.mode, { activeOnly: true }).slice(0, MAX_LIST);
    const product = products[Number(pick[1]) - 1];
    if (!product) return { text: `There is no item ${pick[1]}. Reply with a number from 1 to ${products.length}, or MENU to see the list.` };
    const qty = settings.mode === 'booking' ? 1 : Math.min(MAX_QTY, Math.max(1, Number(pick[2] ?? 1)));
    if (product.variants.length) {
        save({ stage: 'variant', data: { productId: product.id, qty } });
        return {
            text: [`*${product.name}* - choose one:`, ...product.variants.map((v, i) => `${i + 1}. ${v.name} - ${ctx.money(v.price)}`), '', 'Reply with the option number.'].join('\n'),
        };
    }
    return add(ctx, cart, product, null, qty);
}

function add(ctx, cart, product, variant, qty) {
    const { store, phone, now, settings } = ctx;
    const line = { productId: product.id, name: product.name, variant: variant?.name ?? '', price: variant?.price ?? product.price, qty };
    if (settings.mode === 'booking') {
        store.saveCart(phone, { mode: settings.mode, items: [line], stage: 'when', data: {} }, now);
        return { text: `*${label(line)}* - ${ctx.money(line.price)}\n\nWhen would you like to come? Send a date and time, like *25/11 4pm* or *tomorrow 11am*.\n(Reply CANCEL to stop.)` };
    }
    const same = cart.items.findIndex((l) => l.productId === line.productId && l.variant === line.variant);
    const items = same >= 0
        ? cart.items.map((l, i) => (i === same ? { ...l, qty: Math.min(MAX_QTY, l.qty + qty) } : l))
        : [...cart.items, line];
    store.saveCart(phone, { mode: settings.mode, items, stage: 'browse', data: {} }, now);
    return { text: `Added ${qty} x ${label(line)}.\n\n${cartText(ctx, items)}` };
}

async function place(ctx, cart, { address = '', scheduledAt = null }) {
    const { state, store, settings, phone, now, money } = ctx;
    if (!state.objects) return { text: 'Sorry, ordering is not available right now. Please try again later.' };
    const booking = settings.mode === 'booking';
    // The plan's monthly cap is full: say so once instead of going quiet, and keep the cart for later.
    if (objectCapError(state.platformPolicy?.() ?? {}, state.objects, booking ? 'appointment' : 'order', now)) {
        return { text: `Sorry, we can't take new ${booking ? 'bookings' : 'orders'} on WhatsApp right now. Please contact us directly.` };
    }
    const subtotal = cart.items.reduce((sum, l) => sum + l.price * l.qty, 0);
    const delivery = !booking && subtotal > 0 ? settings.deliveryFee : 0;
    const total = round(subtotal + delivery);
    const lines = cart.items.map((l) => `${l.qty} x ${label(l)} - ${money(l.price * l.qty)}`);
    const contact = state.contacts?.getByPhone(phone)
        ?? state.contacts?.upsert({ phone, name: ctx.message.senderName || undefined, source: 'shop', channelId: state.channel?.id });
    const metadata = { source: 'whatsapp', phone, lines: cart.items, address, payment: total > 0 && payable(settings) && rule(state, settings.mode, 'allowUpi') !== false ? 'pending' : 'none', total };

    let object = null;
    for (let attempt = 0; attempt < 5 && !object; attempt += 1) {
        const reference = `${booking ? 'BK' : 'ORD'}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
        try {
            object = booking
                ? await state.objects.create('appointment', {
                    reference, contactId: contact?.id ?? null, source: 'whatsapp', metadata,
                    data: { service: label(cart.items[0]), scheduledAt, notes: `Price ${money(total)}` },
                })
                : await state.objects.create('order', {
                    reference, contactId: contact?.id ?? null, source: 'whatsapp', metadata,
                    data: { amount: total, currency: settings.currency, items: lines.join('\n'), notes: address },
                });
        } catch (err) {
            if (err.status !== 409) throw err; // a reference clash: pick another
        }
    }
    if (!object) throw new Error('could not pick an order reference');
    if (settings.alertOwner !== false) {
        const who = [contact?.name || ctx.message.senderName, `+${phone}`].filter(Boolean).join(' ');
        ownerAlert(state, booking
            ? `New booking ${object.reference} on WhatsApp from ${who}: ${label(cart.items[0])}, ${whenText(scheduledAt, state.channel?.timezone)}`
            : `New order ${object.reference} on WhatsApp from ${who}: ${lines.join(', ')} - total ${money(total)}`, `shop.new.${object.id}`);
    }

    const head = booking
        ? [`Booking *${object.reference}* received ✅`, label(cart.items[0]), `When: ${whenText(scheduledAt, state.channel?.timezone)}`]
        : [`Order *${object.reference}* placed ✅`, ...lines, ...(delivery ? [`Delivery - ${money(delivery)}`] : []), `*Total: ${money(total)}*`, ...(address ? [`Deliver to: ${address}`] : [])];
    const tail = [];
    let media = null;
    if (metadata.payment === 'pending') {
        const link = upiLink(settings, total, object.reference);
        tail.push('', `Pay ${money(total)} by UPI: scan the QR${link ? ` or tap ${link}` : ''}`, 'After paying, reply *PAID* (or send the payment screenshot).');
        media = await paymentQr(state, settings, link, object.reference);
        store.saveCart(phone, { mode: settings.mode, items: [], stage: 'pay', data: { objectId: object.id, reference: object.reference } }, now);
    } else {
        tail.push('', booking ? 'We will confirm your booking shortly.' : 'We will confirm your order shortly.');
        store.clearCart(phone);
    }
    if (settings.note) tail.push('', settings.note);
    tail.push('', 'Reply STATUS any time to check it.');
    return { text: [...head, ...tail].join('\n'), media };
}

async function paid(ctx, cart) {
    const { state, store, phone } = ctx;
    const object = state.objects?.get(cart.data.objectId);
    store.clearCart(phone);
    if (!object) return { text: 'Thanks! We will check and get back to you.' };
    if (object.metadata.payment === 'pending') {
        await state.objects.update(object.id, { metadata: { ...object.metadata, payment: 'claimed' } }, { source: 'whatsapp' });
        if (ctx.settings.alertOwner !== false) {
            ownerAlert(state, `+${phone} says they have paid ${ctx.money(object.metadata.total ?? 0)} for ${object.reference}. Check your account, then mark it paid.`, `shop.paid.${object.id}`);
        }
    }
    return { text: `Thank you! We will check the payment for *${object.reference}* and confirm it here.` };
}

function catalogueText({ store, settings, state, money }) {
    const products = store.products(settings.mode, { activeOnly: true }).slice(0, MAX_LIST);
    const title = settings.title || state.tenancy?.getTenant?.(state.db.tenantId)?.name || 'Our menu';
    if (!products.length) return `${title}: our list is being updated. Please check back soon.`;
    const out = [`*${title}*`];
    let category = null;
    products.forEach((p, i) => {
        if (p.category && p.category !== category) out.push('', `_${p.category}_`);
        category = p.category || category;
        out.push(`${i + 1}. ${p.name} - ${priceText(p, money)}${p.description ? `\n    ${p.description}` : ''}`);
    });
    out.push('', settings.mode === 'booking'
        ? 'Reply with a number to book it.'
        : 'Reply with a number to add it to your cart (*2 x 3* for three of item 2).');
    return out.join('\n');
}

const priceText = (p, money) => (p.variants.length ? `from ${money(Math.min(...p.variants.map((v) => v.price)))}` : money(p.price));

/**
 * The swipe carousel sent with the list: the first MAX_CARDS products whose cover picture is still on disk, each
 * card numbered as in the list with one "Add N" / "Book N" button. Null under 2 cards (WhatsApp's minimum): the
 * text list alone then.
 */
function catalogueCarousel({ store, settings, state, money }) {
    const verb = settings.mode === 'booking' ? 'Book' : 'Add';
    const cards = [];
    for (const [i, p] of store.products(settings.mode, { activeOnly: true }).slice(0, MAX_LIST).entries()) {
        if (cards.length === MAX_CARDS) break;
        const media = p.images[0] ? state.media?.get(p.images[0]) : null;
        if (!String(media?.mimetype ?? '').startsWith('image/')) continue;
        cards.push({
            mediaId: media.mediaId, media, text: `${i + 1}. ${p.name} - ${priceText(p, money)}`,
            buttons: [{ id: `SHOP_${i + 1}`, title: `${verb} ${i + 1}` }],
        });
    }
    if (cards.length < 2) return null;
    return normalizeInteractive({ type: 'carousel', carousel: { kind: 'reply', cards } }, { carousel: true, keepMedia: true });
}

function cartText({ settings, money }, items) {
    if (!items.length) return 'Your cart is empty. Send MENU to see what we have.';
    const subtotal = items.reduce((sum, l) => sum + l.price * l.qty, 0);
    return [
        '*Your cart*',
        ...items.map((l, i) => `${i + 1}. ${l.qty} x ${label(l)} - ${money(l.price * l.qty)}`),
        ...(settings.deliveryFee ? [`Delivery - ${money(settings.deliveryFee)}`] : []),
        `*Total: ${money(subtotal + settings.deliveryFee)}*`,
        '',
        'Reply a number to add more, *CHECKOUT* to place the order, *REMOVE 1* to take out line 1, or *CLEAR* to empty it.',
    ].join('\n');
}

const STATUS_LABEL = {
    placed: 'Placed', confirmed: 'Confirmed', processing: 'Being prepared', shipped: 'On the way', delivered: 'Delivered',
    cancelled: 'Cancelled', refunded: 'Refunded', scheduled: 'Requested', rescheduled: 'Rescheduled', completed: 'Completed', no_show: 'Missed',
};
const PAYMENT_LABEL = { pending: 'payment pending', claimed: 'payment being checked', paid: 'paid' };

function statusText({ state, phone, money }) {
    const contact = state.contacts?.getByPhone(phone);
    const mine = contact && state.objects
        ? ['order', 'appointment'].flatMap((type) => state.objects.list({ type, contactId: contact.id, limit: 5 }))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 5)
        : [];
    if (!mine.length) return 'We have no orders or bookings for this number yet. Send MENU to start.';
    return ['*Your recent orders*', ...mine.map((o) => {
        const pay = PAYMENT_LABEL[o.metadata?.payment];
        const what = o.type === 'order' ? money(o.data.amount) : `${o.data.service}, ${whenText(o.data.scheduledAt, state.channel?.timezone)}`;
        return `${o.reference} - ${STATUS_LABEL[o.status] ?? o.status} - ${what}${pay ? ` (${pay})` : ''}`;
    })].join('\n');
}

const label = (line) => (line.variant ? `${line.name} (${line.variant})` : line.name);
const round = (n) => Math.round(n * 100) / 100;
const payable = (settings) => settings.payNow && Boolean(settings.upiId || settings.qrMediaId);

export function moneyIn(currency) {
    let format;
    try {
        format = new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
    } catch {
        format = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    }
    return (n) => format.format(Number(n) || 0);
}

export function upiLink(settings, amount, reference) {
    if (!settings.upiId) return '';
    const e = encodeURIComponent;
    return `upi://pay?pa=${e(settings.upiId)}&pn=${e(settings.payeeName || settings.title || 'Shop')}&am=${e(amount)}&cu=${e(settings.currency || 'INR')}&tn=${e(reference)}`;
}

/**
 * The QR to send: the business's own uploaded one, else one made from the UPI ID with the amount filled in.
 * shortcut: generated QRs are small PNGs written to uploads/ with no storage row; sweep them if uploads grows.
 */
async function paymentQr(state, settings, link, reference) {
    if (settings.qrMediaId) return state.media?.get(settings.qrMediaId) ?? null;
    if (!link || !state.media?.uploadDir) return null;
    try {
        const { default: QRCode } = await import('qrcode');
        const mediaId = `med_${crypto.randomBytes(6).toString('hex')}`;
        await fs.promises.mkdir(state.media.uploadDir, { recursive: true });
        await fs.promises.writeFile(path.join(state.media.uploadDir, `${mediaId}_pay-${reference}.png`),
            await QRCode.toBuffer(link, { width: 480, margin: 2 }));
        state.media.claim(mediaId);
        return state.media.get(mediaId) ?? null;
    } catch {
        return null; // the UPI link in the text still works
    }
}

function whenText(iso, timeZone) {
    if (!iso) return '';
    try {
        return new Intl.DateTimeFormat('en-IN', { timeZone: timeZone || 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
            .format(new Date(iso));
    } catch {
        return iso;
    }
}

/**
 * "25/11 4pm", "25-11-2026 16:30", "tomorrow 11am", "today 5:30 pm" in the business's time zone. Null when unread.
 * A date with no year that has already passed this year means next year.
 */
export function parseWhen(text, timeZone, now = new Date()) {
    const s = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const time = /(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*$/.exec(s);
    if (!time) return null;
    let hour = Number(time[1]);
    const minute = Number(time[2] ?? 0);
    if (time[3] === 'pm' && hour < 12) hour += 12;
    if (time[3] === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59 || (!time[3] && !time[2] && hour < 7)) return null; // a bare "3" is too vague
    const today = localNow(timeZone, now).date;
    const head = s.slice(0, time.index).trim();
    let date;
    if (!head || /^(today|aaj)\b/.test(head)) date = today;
    else if (/^(tomorrow|tmrw|tmr|kal)\b/.test(head)) date = shiftDay(today, 1);
    else {
        const d = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?(?:\s+at)?$/.exec(head);
        if (!d) return null;
        const year = d[3] ? (d[3].length === 2 ? `20${d[3]}` : d[3]) : today.slice(0, 4);
        const day = Number(d[1]);
        const month = Number(d[2]);
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        date = `${year}-${pad(month)}-${pad(day)}`;
        if (!d[3] && date < today) date = `${Number(year) + 1}-${pad(month)}-${pad(day)}`;
    }
    const at = zonedToUtc(date, `${pad(hour)}:${pad(minute)}`, timeZone || 'UTC');
    return Number.isNaN(at.getTime()) ? null : at;
}

const pad = (n) => String(n).padStart(2, '0');
function shiftDay(date, days) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
