import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { Subscription } from 'rxjs';

import type { Channel } from '../core/api';
import { Store } from '../core/store';
import { MediaSrc } from '../campaign/interactive/media-src';
import { Catalog, CatalogApi, CatalogError } from './catalog-api';
import { filterProducts, formatPrice, hoursRows, isOutOfStock, reviewLabel, sentence, updatedAgo } from './catalog-meta';

/**
 * A WhatsApp Business number's catalog, read from the phone's account: the business profile and public link, the
 * products by collection, one product in full (every photo, review, stock, link), and copying the picked products
 * into the Orders "On WhatsApp" list so orders can name them.
 *
 * A product opens in place of the list, inside the same drawer, so the picks and the filter are still there on the
 * way back. Focus stays inside while it is open and goes back to the button that opened it.
 *
 * Lives at the page root, not inside the number card: the card is transformed (its tilt), and a fixed panel
 * inside a transformed ancestor is positioned against the card instead of the screen.
 */
@Component({
  selector: 'app-catalog-drawer',
  imports: [MediaSrc, RouterLink],
  templateUrl: './catalog-drawer.html',
  styleUrl: './catalog-drawer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'escape()', '(keydown)': 'trap($event)' },
})
export class CatalogDrawer {
  private readonly api = inject(CatalogApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly store = inject(Store);
  private readonly injector = inject(Injector);
  private readonly body = viewChild<ElementRef<HTMLElement>>('body');

  readonly channel = input.required<Channel>();
  readonly closed = output<void>();

  protected readonly loading = signal(true);
  protected readonly catalog = signal<Catalog | null>(null);
  protected readonly error = signal<CatalogError | null>(null);
  protected readonly collectionId = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  protected readonly importing = signal(false);
  protected readonly imported = signal<{ created: number; skipped: number } | null>(null);
  protected readonly importError = signal('');
  /** The business has no Orders service: there is no list to add to, so the import goes. */
  protected readonly ordersOff = signal(false);
  /** The product shown in full, in place of the list. */
  protected readonly detailId = signal<string | null>(null);
  /** Which of that product's photos is the large one. */
  protected readonly photo = signal(0);
  /** What was just copied ('link' or 'product'), for the two seconds its button says so. */
  protected readonly copied = signal<string | null>(null);
  /** The profile starts folded on a phone, where it would push every product off the first screen. */
  protected readonly profileOpen = signal(typeof matchMedia === 'function' && matchMedia('(min-width: 640px)').matches);

  protected readonly price = formatPrice;
  protected readonly review = reviewLabel;
  protected readonly sentence = sentence;
  protected readonly outOfStock = isOutOfStock;

  private request: Subscription | null = null;
  private listScroll = 0;
  private readonly opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  protected readonly shown = computed(() => {
    const c = this.catalog();
    if (!c) return [];
    const collection = c.collections.find((x) => x.id === this.collectionId()) ?? null;
    return filterProducts(c.products, collection, this.query());
  });
  protected readonly detail = computed(() => this.catalog()?.products.find((p) => p.id === this.detailId()) ?? null);
  protected readonly detailCollections = computed(() => {
    const ids = this.detail()?.collectionIds ?? [];
    return (this.catalog()?.collections ?? []).filter((c) => ids.includes(c.id));
  });
  protected readonly hours = computed(() => {
    const h = this.catalog()?.business?.hours;
    return h ? hoursRows(h) : [];
  });
  /** WhatsApp gives every Business number a profile, but a new one can be blank: then there is nothing to unfold. */
  protected readonly hasProfile = computed(() => {
    const b = this.catalog()?.business;
    return !!b && !!(b.description || b.category || b.address || b.email || b.websites.length || b.hours);
  });
  protected readonly updated = computed(() => {
    const at = this.catalog()?.fetchedAt;
    return at ? updatedAgo(at, this.store.now()) : '';
  });
  protected readonly allShownPicked = computed(() => {
    const picked = this.picked();
    const shown = this.shown();
    return shown.length > 0 && shown.every((p) => picked.has(p.id));
  });

  constructor() {
    // After the first render: the required `channel` input is not set yet while the constructor runs.
    afterNextRender(() => {
      this.load(false);
      this.host.nativeElement.querySelector<HTMLElement>('.drawer')?.focus();
    });
    // "Offline" and "not WhatsApp Business" end when the number reconnects: read again then, without a click.
    this.store.watch(['channels', 'connection'], () => {
      const code = this.error()?.code;
      if (!this.loading() && (code === 'not_connected' || code === 'not_business')) this.load(false);
    });
    this.destroyRef.onDestroy(() => {
      this.request?.unsubscribe();
      this.opener?.focus();
    });
  }

  /** Escape steps back from a product to the list before it closes the drawer. */
  protected escape() {
    if (this.detailId()) this.back();
    else this.closed.emit();
  }

  /** Tab wraps inside the drawer, so focus cannot wander onto the page behind the scrim. */
  protected trap(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const list = [
      ...this.host.nativeElement.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input, summary'),
    ].filter((el) => el.offsetParent !== null);
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !list.includes(active as HTMLElement))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  protected load(refresh: boolean) {
    this.loading.set(true);
    this.error.set(null);
    // One read at a time: a reconnect can ask again while "Try again" is still out.
    this.request?.unsubscribe();
    this.request = this.api.get(this.channel().id, refresh).subscribe({
      next: (catalog) => {
        this.loading.set(false);
        this.catalog.set(catalog);
        // Picks of products that left the catalog would import nothing and inflate the count.
        const ids = new Set(catalog.products.map((p) => p.id));
        this.picked.update((s) => new Set([...s].filter((id) => ids.has(id))));
        if (!catalog.collections.some((c) => c.id === this.collectionId())) this.collectionId.set(null);
        if (!ids.has(this.detailId() ?? '')) this.detailId.set(null);
        this.photo.set(0);
      },
      error: (err: CatalogError) => {
        this.loading.set(false);
        this.error.set(err);
        // A state that says the catalog cannot be read at all replaces the old list; a failed refresh keeps it.
        if (err.code && err.code !== 'catalog_failed') {
          this.catalog.set(null);
          this.detailId.set(null);
        }
      },
    });
  }

  protected openDetail(id: string) {
    this.listScroll = this.body()?.nativeElement.scrollTop ?? 0;
    this.photo.set(0);
    this.detailId.set(id);
    this.afterRender(() => {
      this.body()?.nativeElement.scrollTo({ top: 0 });
      this.host.nativeElement.querySelector<HTMLElement>('.back')?.focus();
    });
  }

  /** Back to the list where it was left: same scroll position, focus on the product that was open. */
  protected back() {
    const id = this.detailId();
    this.detailId.set(null);
    this.afterRender(() => {
      this.body()?.nativeElement.scrollTo({ top: this.listScroll });
      const card = [...this.host.nativeElement.querySelectorAll<HTMLElement>('.product .open')].find(
        (el) => el.dataset['id'] === id,
      );
      (card ?? this.host.nativeElement.querySelector<HTMLElement>('.drawer'))?.focus({ preventScroll: true });
    });
  }

  /** From a product's collection chip: the list, filtered to that collection. */
  protected showCollection(id: string) {
    this.collectionId.set(id);
    this.query.set('');
    this.detailId.set(null);
    this.afterRender(() => {
      this.body()?.nativeElement.scrollTo({ top: 0 });
      this.host.nativeElement.querySelector<HTMLElement>('.chips [aria-pressed="true"]')?.focus();
    });
  }

  /** Step through a product's photos; wraps at both ends. */
  protected step(by: number) {
    const count = this.detail()?.images.length ?? 0;
    if (count > 1) this.photo.update((i) => (i + by + count) % count);
  }

  protected copy(what: string, text: string) {
    const done = () => {
      this.copied.set(what);
      setTimeout(() => {
        if (this.copied() === what) this.copied.set(null);
      }, 2000);
    };
    // The Clipboard API only exists on https (and localhost), and the browser can still refuse it.
    (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard'))).then(done, () => {
      const area = document.createElement('textarea');
      area.value = text;
      this.host.nativeElement.append(area);
      area.select();
      if (document.execCommand('copy')) done();
      area.remove();
    });
  }

  private afterRender(run: () => void) {
    afterNextRender(run, { injector: this.injector });
  }

  protected toggle(id: string) {
    this.imported.set(null);
    this.picked.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected toggleShown() {
    const ids = this.shown().map((p) => p.id);
    const all = this.allShownPicked();
    this.imported.set(null);
    this.picked.update((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  protected importPicked() {
    const ids = [...this.picked()];
    if (!ids.length || this.importing()) return;
    this.importing.set(true);
    this.importError.set('');
    this.imported.set(null);
    this.api
      .import(this.channel().id, ids)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.importing.set(false);
          this.imported.set(result);
          this.picked.set(new Set());
        },
        error: (err: CatalogError) => {
          this.importing.set(false);
          if (err.code === 'orders_off') this.ordersOff.set(true);
          else this.importError.set(err.message);
        },
      });
  }
}
