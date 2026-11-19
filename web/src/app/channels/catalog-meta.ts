import type { CatalogBusiness, CatalogCollection, CatalogProduct } from './catalog-api';

/** "₹1,299.00" in the product's own currency; a code Intl does not know falls back to "1299 XYZ". */
export function formatPrice(price: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(price);
  } catch {
    return `${price} ${currency}`.trim();
  }
}

/** The products in a collection (null = all) whose name, description or SKU holds the search words. */
export function filterProducts(
  products: readonly CatalogProduct[],
  collection: CatalogCollection | null,
  query: string,
): CatalogProduct[] {
  const inCollection = collection ? new Set(collection.productIds) : null;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return products.filter((p) => {
    if (inCollection && !inCollection.has(p.id)) return false;
    const text = `${p.name} ${p.description} ${p.retailerId}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** "Updated just now" / "Updated 5 min ago" / "Updated 2 h ago" / "Updated 3 days ago". */
export function updatedAgo(fetchedAt: string, now: number): string {
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return '';
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  if (min < 1) return 'Updated just now';
  if (min < 60) return `Updated ${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Updated ${h} h ago`;
  const d = Math.floor(h / 24);
  return `Updated ${d} day${d === 1 ? '' : 's'} ago`;
}

/** WhatsApp's review of a product or collection in plain words; '' when it did not say. */
export function reviewLabel(status: string): string {
  switch (status.toUpperCase()) {
    case 'APPROVED':
      return 'Approved';
    case 'PENDING':
      return 'In review';
    case 'REJECTED':
      return 'Rejected';
    default:
      return sentence(status);
  }
}

/** "in stock" / "OUT_OF_STOCK" -> "In stock" / "Out of stock". */
export function sentence(text: string): string {
  const words = text.replace(/_/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** WhatsApp says a product cannot be bought right now (anything but "in stock", when it says at all). */
export function isOutOfStock(availability: string): boolean {
  const a = availability.replace(/_/g, ' ').trim().toLowerCase();
  return a !== '' && a !== 'in stock';
}

/** Sunday first, the order WhatsApp Business lists them in. */
const DAYS: readonly (readonly [string, string])[] = [
  ['sun', 'Sunday'],
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
];

/** The week as rows: a day WhatsApp does not list is one the business is closed on. */
export function hoursRows(hours: NonNullable<CatalogBusiness['hours']>): { day: string; text: string }[] {
  return DAYS.map(([key, day]) => {
    const slots = hours.days.filter((d) => d.day.toLowerCase().startsWith(key));
    const text = slots
      .map((d) =>
        d.mode === 'open_24h'
          ? 'Open 24 hours'
          : d.mode === 'appointment_only'
            ? 'By appointment'
            : d.open && d.close
              ? `${d.open} – ${d.close}`
              : sentence(d.mode),
      )
      .filter(Boolean)
      .join(', ');
    return { day, text: text || 'Closed' };
  });
}
