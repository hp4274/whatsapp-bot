import type { CatalogCollection, CatalogProduct } from './catalog-api';

/** "₹1,299.00" in the product's own currency; a code Intl does not know falls back to "1299 XYZ". */
export function formatPrice(price: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(price);
  } catch {
    return `${price} ${currency}`.trim();
  }
}

/** The products in a collection (null = all) whose name or description holds the search words. */
export function filterProducts(
  products: readonly CatalogProduct[],
  collection: CatalogCollection | null,
  query: string,
): CatalogProduct[] {
  const inCollection = collection ? new Set(collection.productIds) : null;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return products.filter((p) => {
    if (inCollection && !inCollection.has(p.id)) return false;
    const text = `${p.name} ${p.description}`.toLowerCase();
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
