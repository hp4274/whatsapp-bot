import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { CampaignDraft } from '../campaign/draft';
import { formatBytes } from '../campaign/wa-format';
import { TenancyApi } from '../core/api';
import { Auth } from '../core/auth';
import { Store } from '../core/store';
import { Tilt } from '../school/tilt';
import { StorageApi, type StoredFile, type StoredKind } from './storage-api';
import { FILE_ICON, fileMeta, fileType, shortDate } from './storage-format';

type Filter = 'all' | StoredKind;
type RowAction = 'use' | 'download' | 'delete';

const FILTERS: readonly { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'sheet', label: 'Contact lists' },
  { key: 'media', label: 'Attachments' },
];

/** Three columns of cards on a wide screen, so twelve fills the grid evenly. */
const PAGE_SIZE = 12;

/**
 * Every contact sheet and media attachment the workspace has uploaded.
 *
 * The server de-duplicates by content, so each card is one distinct file; the
 * whole list is loaded once and filtered, searched and paged here (the same
 * trade as the campaigns list). "Use in campaign" re-opens a sheet through the
 * server and hands the resulting import to the composer's draft, exactly as a
 * fresh upload would. Delete asks a second click on the same button instead of
 * a dialog; the server may refuse with a reason (409) while a campaign or
 * template still needs the file, which lands in the error banner.
 */
@Component({
  selector: 'app-storage',
  imports: [DecimalPipe, RouterLink, Tilt],
  templateUrl: './storage.html',
  styleUrl: './storage.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StorageView {
  private readonly api = inject(StorageApi);
  private readonly auth = inject(Auth);
  private readonly draft = inject(CampaignDraft);
  private readonly router = inject(Router);
  private readonly store = inject(Store);
  private readonly tenancy = inject(TenancyApi);

  /** Reopening and deleting are admin writes on the server; agents only browse and download. */
  protected readonly canWrite = computed(() => this.auth.atLeast('admin'));
  protected readonly filters = FILTERS;
  protected readonly pageSize = PAGE_SIZE;
  protected readonly files = signal<readonly StoredFile[]>([]);
  protected readonly totals = signal({ count: 0, bytes: 0 });
  protected readonly filter = signal<Filter>('all');
  protected readonly search = signal('');
  protected readonly page = signal(0);
  protected readonly loading = signal(true);
  protected readonly loaded = signal(false);
  protected readonly error = signal('');
  /** File id whose delete awaits its second click. */
  protected readonly confirming = signal<number | null>(null);
  protected readonly busy = signal<{ id: number; action: RowAction } | null>(null);
  /** The plan's storage limit in MB (uploads past it are refused with 413); null = unlimited or unknown. */
  protected readonly limitMb = signal<number | null>(null);

  /** Count and bytes per kind: drives the filter chips and the storage-by-type bar. */
  protected readonly split = computed(() => {
    const out = { sheet: { count: 0, bytes: 0 }, media: { count: 0, bytes: 0 } };
    for (const f of this.files()) {
      out[f.kind].count++;
      out[f.kind].bytes += f.size;
    }
    return out;
  });

  protected readonly counts = computed<Record<Filter, number>>(() => ({
    all: this.files().length,
    sheet: this.split().sheet.count,
    media: this.split().media.count,
  }));

  /** Each kind's share of the stored bytes, in percent; null while nothing has a size. */
  protected readonly share = computed(() => {
    const { sheet, media } = this.split();
    const total = sheet.bytes + media.bytes;
    return total
      ? { sheet: (sheet.bytes / total) * 100, media: (media.bytes / total) * 100 }
      : null;
  });

  protected readonly visible = computed(() => {
    const kind = this.filter();
    const q = this.search().trim().toLowerCase();
    return this.files()
      .filter((f) => kind === 'all' || f.kind === kind)
      .filter((f) => !q || f.name.toLowerCase().includes(q));
  });

  protected readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.visible().length / PAGE_SIZE)),
  );
  /** Clamped here so a shrinking list (filter, delete) never leaves an empty page. */
  protected readonly pageIndex = computed(() => Math.min(this.page(), this.pageCount() - 1));
  protected readonly offset = computed(() => this.pageIndex() * PAGE_SIZE);
  protected readonly cards = computed(() =>
    this.visible().slice(this.offset(), this.offset() + PAGE_SIZE),
  );
  protected readonly from = computed(() => (this.visible().length ? this.offset() + 1 : 0));
  protected readonly to = computed(() =>
    Math.min(this.visible().length, this.offset() + PAGE_SIZE),
  );

  protected readonly icon = (f: StoredFile): string => FILE_ICON[fileType(f)];
  protected readonly type = fileType;
  protected readonly meta = fileMeta;
  protected readonly date = shortDate;
  protected readonly bytes = formatBytes;

  constructor() {
    this.load();
    // Uploads land from the composer and other tabs; a plan change moves the limit.
    this.store.watch(['storage', 'media', 'contacts', 'tenant', 'config'], () => this.load(true), 1000);
  }

  /** `quiet` keeps the cards on screen, for refreshes driven by the event stream. */
  protected load(quiet = false): void {
    if (!quiet) this.loading.set(true);
    // Best effort: the limit is a footnote, and the file list must not wait for it or fail with it.
    this.tenancy.planUsage().subscribe({
      next: ({ usage }) => this.limitMb.set(usage.metrics.find((m) => m.metric === 'storage_mb')?.limit || null),
      error: () => this.limitMb.set(null),
    });
    this.api.list().subscribe({
      next: ({ files, totals }) => {
        this.files.set(files);
        this.totals.set(totals);
        this.error.set('');
        this.loading.set(false);
        this.loaded.set(true);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.loading.set(false);
        this.loaded.set(true);
      },
    });
  }

  protected setFilter(f: Filter): void {
    this.filter.set(f);
    this.page.set(0);
  }

  protected setSearch(q: string): void {
    this.search.set(q);
    this.page.set(0);
  }

  protected goTo(page: number): void {
    this.page.set(Math.min(Math.max(0, page), this.pageCount() - 1));
  }

  protected isBusy(f: StoredFile, action: RowAction): boolean {
    const b = this.busy();
    return b?.id === f.id && b.action === action;
  }

  protected download(f: StoredFile): void {
    this.busy.set({ id: f.id, action: 'download' });
    this.api.download(f.id).subscribe({
      next: (blob) => {
        this.busy.set(null);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: (err: Error) => this.fail(err),
    });
  }

  /**
   * Prime the composer with the stored sheet and open it on the audience step.
   * A finished campaign leaves the draft on its result screen, so that is
   * cleared first; a half-written message survives, as with any new upload.
   */
  protected useInCampaign(f: StoredFile): void {
    this.busy.set({ id: f.id, action: 'use' });
    this.api.use(f.id).subscribe({
      next: ({ preview }) => {
        this.busy.set(null);
        if (!preview) {
          this.error.set('The server did not return the contact list. Try again.');
          return;
        }
        if (this.draft.result()) this.draft.reset();
        this.draft.source.set('file');
        this.draft.adoptImport(preview);
        this.draft.goTo(1);
        void this.router.navigateByUrl('/campaign');
      },
      error: (err: Error) => this.fail(err),
    });
  }

  protected remove(f: StoredFile): void {
    if (this.confirming() !== f.id) {
      this.confirming.set(f.id);
      return;
    }
    this.confirming.set(null);
    this.busy.set({ id: f.id, action: 'delete' });
    this.api.remove(f.id).subscribe({
      next: () => {
        this.busy.set(null);
        this.store.setStatus(`Deleted "${f.name}"`, 'primary');
        this.load();
      },
      error: (err: Error) => this.fail(err),
    });
  }

  private fail(err: Error): void {
    this.busy.set(null);
    this.error.set(err.message);
    this.store.setStatus(err.message, 'danger');
  }
}
