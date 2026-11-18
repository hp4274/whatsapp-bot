import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { ArSwitch } from '../auto-replies/ar-fields';
import { MediaSrc } from '../campaign/interactive/media-src';
import { ConfirmDialog } from '../core/confirm-dialog';
import { Store } from '../core/store';
import {
  PaymentState,
  Product,
  ProductPayload,
  ShopApi,
  ShopMode,
  ShopOrder,
  ShopRules,
  ShopSettings,
  ShopState,
} from './shop-api';

const EMPTY_PRODUCT: ProductPayload = {
  name: '',
  description: '',
  category: '',
  price: 0,
  variants: [],
  images: [],
  active: true,
};

/** Pictures per product (server/src/shop/store.js MAX_IMAGES). */
const MAX_IMAGES = 5;
/** What WhatsApp shows as a photo; anything else would break the carousel. */
const IMAGE_TYPES = ['image/jpeg', 'image/png'];

/** How a payment state reads, and its pill tone. */
const PAYMENT: Record<PaymentState, { label: string; tone: string }> = {
  pending: { label: 'Not paid yet', tone: 'var(--warning)' },
  claimed: { label: 'Says paid - check', tone: 'var(--info)' },
  paid: { label: 'Paid', tone: 'var(--success)' },
  none: { label: 'Pay later', tone: 'var(--text-muted)' },
};

/**
 * Taking orders (on the Orders page) or bookings (on the Appointments page) over WhatsApp: the switch, the list of
 * products or services, how customers pay, the business info answered to INFO, and what came in. Customers do
 * everything by typing (QR numbers cannot send buttons), so the strip under the switch spells out the words.
 *
 * Settings save with one button so a half-typed UPI ID is never live; the switch saves at once because it is one
 * tap. Orders are moved from here so the customer is messaged with each step. Feedback is a line at the top, not a
 * toast: the records pages that host this have no toast area.
 */
@Component({
  selector: 'app-shop',
  imports: [FormsModule, ArSwitch, ConfirmDialog, MediaSrc],
  templateUrl: './shop.html',
  styleUrl: './shop.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShopPanel {
  private readonly api = inject(ShopApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly mode = input.required<ShopMode>();

  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly state = signal<ShopState | null>(null);
  /** The settings form; reset whenever the server's copy changes. */
  protected readonly form = linkedSignal<ShopSettings | null>(() => this.state()?.settings ?? null);
  protected readonly saving = signal(false);
  protected readonly dirty = computed(
    () => JSON.stringify(this.form()) !== JSON.stringify(this.state()?.settings ?? null),
  );
  protected readonly booking = computed(() => this.mode() === 'booking');
  protected readonly noun = computed(() => (this.booking() ? 'service' : 'product'));

  /** The last thing that happened, shown above the cards for a few seconds. */
  protected readonly notice = signal<{ text: string; bad: boolean } | null>(null);
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  /** The product being added or edited, or null. */
  protected readonly editing = signal<{ id: number | null; draft: ProductPayload } | null>(null);
  protected readonly savingProduct = signal(false);
  protected readonly uploading = signal(false);
  /** Product pictures still uploading. */
  protected readonly uploadingImages = signal(0);
  protected readonly maxImages = MAX_IMAGES;
  protected readonly busyOrder = signal<number | null>(null);
  /** The product waiting on the "are you sure" dialog. */
  protected readonly deleting = signal<Product | null>(null);

  protected readonly orders = computed(() => this.state()?.orders ?? []);
  protected readonly waiting = computed(
    () => this.orders().filter((o) => o.metadata.payment === 'claimed').length,
  );
  protected readonly statuses = computed(() => this.state()?.statuses ?? []);
  protected readonly payReady = computed(() => !!(this.form()?.upiId || this.form()?.qrMediaId));
  /** The platform's rules for this business; everything allowed until the first load says otherwise. */
  protected readonly rules = computed<ShopRules>(
    () => this.state()?.rules ?? { allowWhatsapp: true, allowUpi: true, maxProducts: null, allowReminders: true },
  );
  protected readonly atCap = computed(() => {
    const max = this.rules().maxProducts;
    return max !== null && (this.state()?.products.length ?? 0) >= max;
  });

  constructor() {
    effect(() => {
      this.mode();
      untracked(() => this.load());
    });
    inject(Store).watch(['shop', 'objects'], () => this.load(true));
    this.destroyRef.onDestroy(() => clearTimeout(this.noticeTimer));
  }

  protected load(quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.loadError.set('');
    this.api
      .get(this.mode())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => {
          // A live reload must not wipe what the owner is typing.
          if (quiet && this.dirty()) this.state.update((cur) => (cur ? { ...s, settings: cur.settings } : s));
          else this.state.set(s);
          this.loading.set(false);
        },
        error: (err: Error) => {
          this.loadError.set(err.message);
          this.loading.set(false);
        },
      });
  }

  private say(text: string, bad = false): void {
    clearTimeout(this.noticeTimer);
    this.notice.set({ text, bad });
    this.noticeTimer = setTimeout(() => this.notice.set(null), bad ? 7000 : 3500);
  }

  private fail = (err: unknown): void => this.say(err instanceof Error ? err.message : String(err), true);

  // Settings ------------------------------------------------------------------
  protected set<K extends keyof ShopSettings>(key: K, value: ShopSettings[K]): void {
    this.form.update((f) => (f ? { ...f, [key]: value } : f));
  }

  /** The on/off switch: one tap, saved straight away, keeping anything else typed but not saved. */
  protected toggle(enabled: boolean): void {
    this.api.saveSettings(this.mode(), { enabled }).subscribe({
      next: ({ settings }) => {
        const typed = this.form();
        this.state.update((s) => (s ? { ...s, settings } : s));
        if (typed) this.form.set({ ...typed, enabled });
        const what = this.booking() ? 'Bookings' : 'Orders';
        this.say(`${what} on WhatsApp are ${settings.enabled ? 'on' : 'off'}`);
      },
      error: this.fail,
    });
  }

  protected save(): void {
    const f = this.form();
    if (!f || this.saving()) return;
    this.saving.set(true);
    this.api.saveSettings(this.mode(), f).subscribe({
      next: ({ settings }) => {
        this.state.update((s) => (s ? { ...s, settings } : s));
        this.saving.set(false);
        this.say('Settings saved');
      },
      error: (err) => {
        this.saving.set(false);
        this.fail(err);
      },
    });
  }

  protected uploadQr(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.uploading.set(true);
    this.api.upload(file).subscribe({
      next: (m) => {
        this.uploading.set(false);
        this.set('qrMediaId', m.mediaId);
      },
      error: (err) => {
        this.uploading.set(false);
        this.fail(err);
      },
    });
  }

  // Products / services -------------------------------------------------------
  protected add(): void {
    this.editing.set({ id: null, draft: structuredClone(EMPTY_PRODUCT) });
  }

  protected edit(p: Product): void {
    const { id, ...draft } = p;
    this.editing.set({ id, draft: structuredClone(draft) });
  }

  protected patch(change: Partial<ProductPayload>): void {
    this.editing.update((e) => (e ? { ...e, draft: { ...e.draft, ...change } } : e));
  }

  protected addVariant(): void {
    const e = this.editing();
    if (e) this.patch({ variants: [...e.draft.variants, { name: '', price: e.draft.price }] });
  }

  protected setVariant(i: number, change: Partial<{ name: string; price: number }>): void {
    const e = this.editing();
    if (e) this.patch({ variants: e.draft.variants.map((v, j) => (j === i ? { ...v, ...change } : v)) });
  }

  protected dropVariant(i: number): void {
    const e = this.editing();
    if (e) this.patch({ variants: e.draft.variants.filter((_, j) => j !== i) });
  }

  /** Each picked file uploads on its own and joins the end of the list as it lands. */
  protected addImages(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    const room = MAX_IMAGES - (this.editing()?.draft.images.length ?? 0) - this.uploadingImages();
    const wrong = files.filter((f) => !IMAGE_TYPES.includes(f.type));
    if (wrong.length) this.say(`${wrong[0].name} is not a JPG or PNG picture`, true);
    const ok = files.filter((f) => IMAGE_TYPES.includes(f.type));
    if (ok.length > room) this.say(`Up to ${MAX_IMAGES} pictures per ${this.noun()}`, true);
    for (const file of ok.slice(0, Math.max(0, room))) {
      this.uploadingImages.update((n) => n + 1);
      this.api.upload(file).subscribe({
        next: (m) => {
          this.uploadingImages.update((n) => n - 1);
          const e = this.editing();
          if (e && e.draft.images.length < MAX_IMAGES) this.patch({ images: [...e.draft.images, m.mediaId] });
        },
        error: (err) => {
          this.uploadingImages.update((n) => n - 1);
          this.fail(err);
        },
      });
    }
  }

  /** Move picture `i` one place (-1 left, 1 right); the first one is the cover. */
  protected moveImage(i: number, by: -1 | 1): void {
    const images = [...(this.editing()?.draft.images ?? [])];
    const j = i + by;
    if (j < 0 || j >= images.length) return;
    [images[i], images[j]] = [images[j], images[i]];
    this.patch({ images });
  }

  protected dropImage(i: number): void {
    const e = this.editing();
    if (e) this.patch({ images: e.draft.images.filter((_, j) => j !== i) });
  }

  protected saveProduct(): void {
    const e = this.editing();
    if (!e || this.savingProduct() || this.uploadingImages()) return;
    this.savingProduct.set(true);
    this.api.saveProduct(this.mode(), e.draft, e.id).subscribe({
      next: ({ product }) => {
        this.state.update((s) =>
          s
            ? {
                ...s,
                products:
                  e.id === null
                    ? [...s.products, product]
                    : s.products.map((p) => (p.id === product.id ? product : p)),
              }
            : s,
        );
        this.savingProduct.set(false);
        this.editing.set(null);
        this.say(e.id === null ? `${product.name} added` : `${product.name} saved`);
      },
      error: (err) => {
        this.savingProduct.set(false);
        this.fail(err);
      },
    });
  }

  protected toggleProduct(p: Product, active: boolean): void {
    const { id, ...draft } = p;
    this.api.saveProduct(this.mode(), { ...draft, active }, id).subscribe({
      next: ({ product }) =>
        this.state.update((s) =>
          s ? { ...s, products: s.products.map((x) => (x.id === id ? product : x)) } : s,
        ),
      error: this.fail,
    });
  }

  protected removeProduct(): void {
    const p = this.deleting();
    this.deleting.set(null);
    if (!p) return;
    this.api.removeProduct(this.mode(), p.id).subscribe({
      next: () => {
        this.state.update((s) => (s ? { ...s, products: s.products.filter((x) => x.id !== p.id) } : s));
        if (this.editing()?.id === p.id) this.editing.set(null);
        this.say(`${p.name} deleted`);
      },
      error: this.fail,
    });
  }

  // Orders / bookings ---------------------------------------------------------
  protected move(o: ShopOrder, body: { status?: string; payment?: 'paid' }): void {
    this.busyOrder.set(o.id);
    this.api.moveOrder(this.mode(), o.id, body).subscribe({
      next: ({ order, notified }) => {
        this.busyOrder.set(null);
        this.state.update((s) =>
          s ? { ...s, orders: s.orders.map((x) => (x.id === order.id ? order : x)) } : s,
        );
        this.say(notified ? `${order.reference} updated - customer told on WhatsApp` : `${order.reference} updated`);
      },
      error: (err) => {
        this.busyOrder.set(null);
        this.fail(err);
      },
    });
  }

  // Formatting ----------------------------------------------------------------
  protected money(n: number | undefined): string {
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: this.form()?.currency || 'INR',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(n ?? 0);
    } catch {
      return String(n ?? 0);
    }
  }

  protected priceOf(p: Product): string {
    return p.variants.length
      ? `from ${this.money(Math.min(...p.variants.map((v) => v.price)))}`
      : this.money(p.price);
  }

  /** The cover of the order's first product that still has one. */
  protected coverOf(o: ShopOrder): string {
    const products = this.state()?.products ?? [];
    for (const line of o.metadata.lines ?? []) {
      const cover = products.find((p) => p.id === line.productId)?.images[0];
      if (cover) return cover;
    }
    return '';
  }

  protected payment(o: ShopOrder): { label: string; tone: string } {
    return PAYMENT[o.metadata.payment ?? 'none'];
  }

  protected statusLabel(s: string): string {
    const words = s.replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  protected when(iso: string | undefined): string {
    return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }

  protected num(event: Event): number {
    return Number((event.target as HTMLInputElement).value) || 0;
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
}
