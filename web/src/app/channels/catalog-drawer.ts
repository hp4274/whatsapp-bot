import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import type { Channel } from '../core/api';
import { Store } from '../core/store';
import { MediaSrc } from '../campaign/interactive/media-src';
import { Catalog, CatalogApi, CatalogError } from './catalog-api';
import { filterProducts, formatPrice, updatedAgo } from './catalog-meta';

/**
 * A WhatsApp Business number's catalog, read from the phone's account: browse it by collection, and copy the
 * picked products into the Orders "On WhatsApp" list so orders can name them.
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
  host: { '(document:keydown.escape)': 'closed.emit()' },
})
export class CatalogDrawer {
  private readonly api = inject(CatalogApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly store = inject(Store);

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

  protected readonly price = formatPrice;

  protected readonly shown = computed(() => {
    const c = this.catalog();
    if (!c) return [];
    const collection = c.collections.find((x) => x.id === this.collectionId()) ?? null;
    return filterProducts(c.products, collection, this.query());
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
  }

  protected load(refresh: boolean) {
    this.loading.set(true);
    this.error.set(null);
    this.api
      .get(this.channel().id, refresh)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (catalog) => {
          this.loading.set(false);
          this.catalog.set(catalog);
          // Picks of products that left the catalog would import nothing and inflate the count.
          const ids = new Set(catalog.products.map((p) => p.id));
          this.picked.update((s) => new Set([...s].filter((id) => ids.has(id))));
          if (!catalog.collections.some((c) => c.id === this.collectionId())) this.collectionId.set(null);
        },
        error: (err: CatalogError) => {
          this.loading.set(false);
          this.error.set(err);
          // A state that says the catalog cannot be read at all replaces the old list; a failed refresh keeps it.
          if (err.code && err.code !== 'catalog_failed') this.catalog.set(null);
        },
      });
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
