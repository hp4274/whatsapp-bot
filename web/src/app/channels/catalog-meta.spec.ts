import { type CatalogProduct, toCatalog } from './catalog-api';
import { filterProducts, formatPrice, hoursRows, isOutOfStock, reviewLabel, updatedAgo } from './catalog-meta';

const product = (id: string, name: string, description = ''): CatalogProduct => ({
  id,
  name,
  description,
  price: 10,
  salePrice: null,
  currency: 'INR',
  image: null,
  images: [],
  url: '',
  retailerId: '',
  hidden: false,
  status: 'APPROVED',
  canAppeal: false,
  availability: '',
  collectionIds: [],
});

describe('catalog-meta', () => {
  it('formats a price in its own currency', () => {
    expect(formatPrice(1299, 'INR', 'en-IN')).toBe('₹1,299.00');
    expect(formatPrice(5.5, 'USD', 'en-US')).toBe('$5.50');
  });

  it('falls back when the currency code is not one Intl knows', () => {
    expect(formatPrice(12, 'not-a-code', 'en-US')).toBe('12 not-a-code');
  });

  it('filters by collection and by every search word', () => {
    const list = [product('1', 'Red shirt', 'cotton'), product('2', 'Blue shirt'), product('3', 'Red cap')];
    const shirts = { id: 'c', name: 'Shirts', productIds: ['1', '2'], status: '' };
    expect(filterProducts(list, null, '').map((p) => p.id)).toEqual(['1', '2', '3']);
    expect(filterProducts(list, shirts, '').map((p) => p.id)).toEqual(['1', '2']);
    expect(filterProducts(list, null, 'red').map((p) => p.id)).toEqual(['1', '3']);
    expect(filterProducts(list, shirts, ' RED  cotton ').map((p) => p.id)).toEqual(['1']);
  });

  it('says how long ago the catalog was read', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    expect(updatedAgo('2026-11-18T11:59:40Z', now)).toBe('Updated just now');
    expect(updatedAgo('2026-11-18T11:55:00Z', now)).toBe('Updated 5 min ago');
    expect(updatedAgo('2026-11-18T09:00:00Z', now)).toBe('Updated 3 h ago');
    expect(updatedAgo('2026-11-17T12:00:00Z', now)).toBe('Updated 1 day ago');
    expect(updatedAgo('nope', now)).toBe('');
  });

  it('fills in what an older server leaves out', () => {
    const c = toCatalog({
      products: [{ id: '1', name: 'Shirt', price: 10, currency: 'INR', image: '/api/x', images: ['/api/x'] }],
      collections: [{ id: 'c', name: 'Shirts', productIds: ['1'] }],
      fetchedAt: '2026-11-18T12:00:00Z',
    });
    expect(c.business).toBeNull();
    expect(c.link).toBe('');
    expect(c.total).toBe(1);
    expect(c.truncated).toBe(false);
    expect(c.products[0]).toMatchObject({ salePrice: null, availability: '', canAppeal: false, collectionIds: ['c'] });
    expect(toCatalog({}).products).toEqual([]);
  });

  it('puts the review and stock in plain words', () => {
    expect(reviewLabel('PENDING')).toBe('In review');
    expect(reviewLabel('')).toBe('');
    expect(isOutOfStock('out of stock')).toBe(true);
    expect(isOutOfStock('in stock')).toBe(false);
    expect(isOutOfStock('')).toBe(false);
  });

  it('lists the week, closed on the days WhatsApp leaves out', () => {
    const rows = hoursRows({
      timezone: 'Asia/Kolkata',
      days: [
        { day: 'mon', mode: 'specific_hours', open: '10:00', close: '19:00' },
        { day: 'sat', mode: 'open_24h', open: null, close: null },
        { day: 'tue', mode: 'appointment_only', open: null, close: null },
      ],
    });
    expect(rows.map((r) => r.text)).toEqual(['Closed', '10:00 – 19:00', 'By appointment', 'Closed', 'Closed', 'Closed', 'Open 24 hours']);
  });
});
