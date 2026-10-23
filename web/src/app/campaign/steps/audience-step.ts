import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  Campaign,
  CampaignsApi,
  ContactsApi,
  ImportIssueReason,
  ImportPreview,
  RetargetFilter,
  Segment,
} from '../../core/api';
import { ReusePicker } from '../../storage/reuse-picker';
import type { StorageUse } from '../../storage/storage-api';
import { shortDate } from '../../storage/storage-format';
import { AudienceSource, CampaignDraft } from '../draft';
import { CampaignPolicy } from '../policy-api';

const REASONS: Record<ImportIssueReason, string> = {
  empty: 'Empty',
  letters: 'Letters / symbols',
  too_short: 'Too short',
  too_long: 'Too long',
  bad_country_code: 'Bad country code',
  invalid: 'Invalid',
  duplicate: 'Duplicate',
  opted_out: 'Opted out',
  recent: 'Messaged recently',
};

/** Where recipients can come from; the order is the order of the choice cards. */
const SOURCES: { value: AudienceSource; icon: string; title: string; text: string }[] = [
  {
    value: 'file',
    icon: 'file-upload',
    title: 'Upload a file',
    text: 'CSV or Excel - every column becomes a variable',
  },
  {
    value: 'retarget',
    icon: 'reload',
    title: 'Re-target a campaign',
    text: 'Follow up on failed, unread or clicked',
  },
];

const FILTERS: { value: RetargetFilter; label: string; hint: string }[] = [
  { value: 'failed', label: 'Failed', hint: 'The message never arrived' },
  { value: 'unread', label: 'Delivered but not read', hint: 'Sent or delivered, no blue ticks' },
  { value: 'noreply', label: 'Read but did not reply', hint: 'Got it, said nothing' },
  { value: 'replied', label: 'Replied', hint: 'Wrote back after the campaign started' },
  { value: 'clicked', label: 'Picked a button', hint: 'Chose a specific reply option' },
];

/** "Skip if messaged within N days" choices; 0 turns the check off. */
export const DEDUPE_PRESETS = [0, 7, 30, 90];
/** Rows rendered in the skipped-rows table; the CSV download carries the rest. */
const ISSUE_LIMIT = 200;

/**
 * Step 1 (top half): pick who gets the campaign — an uploaded file, a re-target of a past
 * campaign, or a saved segment. Uploaded files are audited on the server
 * (debounced) every time the mapping or cleaning rules change, so the count
 * shown is always what will actually be sent.
 */
@Component({
  selector: 'app-audience-step',
  imports: [FormsModule, ReusePicker],
  templateUrl: './audience-step.html',
  styleUrl: './audience-step.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AudienceStep {
  protected readonly draft = inject(CampaignDraft);
  private readonly campaignsApi = inject(CampaignsApi);
  private readonly contactsApi = inject(ContactsApi);
  private readonly destroyRef = inject(DestroyRef);
  /** Re-targeting is a follow-up campaign, which a plan can switch off. */
  protected readonly policy = inject(CampaignPolicy);

  protected readonly sources = SOURCES;
  protected readonly filters = FILTERS;
  protected readonly reasons = REASONS;
  protected readonly dedupePresets = DEDUPE_PRESETS;
  /** First-upload time of the sheet when identical bytes were already stored; else null. */
  protected readonly duplicateOf = signal<string | null>(null);
  protected readonly date = shortDate;

  protected readonly uploading = signal(false);
  protected readonly auditing = signal(false);
  protected readonly dragOver = signal(false);
  /** Numbers typed by hand, one per line, optionally "number, name". */
  protected readonly typed = signal('');
  protected readonly error = signal('');
  protected readonly copied = signal<string | null>(null);
  protected readonly campaigns = signal<Campaign[] | null>(null);
  protected readonly segments = signal<Segment[] | null>(null);

  protected readonly ccValid = computed(() => /^\d{1,4}$/.test(this.draft.countryCode()));
  protected readonly columns = computed(() => this.draft.preview()?.columns ?? []);
  /** Every column that is not the phone or the name, with a sample value. */
  protected readonly varColumns = computed(() => {
    const preview = this.draft.preview();
    if (!preview) return [];
    const { phone, name } = this.draft.mapping();
    const first = preview.rows[0] ?? [];
    const out = preview.columns
      .map((c, i) => ({ ...c, sample: String(first[i] ?? '') }))
      .filter((c) => c.slug !== phone && c.slug !== name);
    const nameAt = preview.columns.findIndex((c) => c.slug === name);
    return [
      {
        header: 'Name column',
        slug: 'name',
        sample: nameAt >= 0 ? String(first[nameAt] ?? '') : '',
      },
      ...out,
      ...this.draft.extraColumns().map((c) => ({ header: 'Added column', slug: c.slug, sample: c.value })),
    ];
  });

  protected readonly newCol = signal('');
  protected readonly newValue = signal('');
  /** Same shape as the server's file-column slugs, so added columns read alike. */
  protected readonly newSlug = computed(() =>
    this.newCol()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, ''),
  );
  protected readonly colError = computed(() => {
    const slug = this.newSlug();
    if (!slug) return '';
    const taken = [
      'name',
      'phone',
      ...this.columns().map((c) => c.slug),
      ...this.draft.extraColumns().map((c) => c.slug),
    ];
    return taken.includes(slug) ? `{${slug}} already exists` : '';
  });
  protected readonly issues = computed(() =>
    (this.draft.audit()?.issues ?? []).slice(0, ISSUE_LIMIT),
  );
  protected readonly moreIssues = computed(() =>
    Math.max(0, (this.draft.audit()?.issues.length ?? 0) - ISSUE_LIMIT),
  );

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped per audit request so a slow, stale response never overwrites a newer one. */
  private auditSeq = 0;

  constructor() {
    this.policy.load();
    // Re-audit (debounced) whenever the file, mapping or cleaning rules change.
    effect(() => {
      const preview = this.draft.preview();
      const mapping = this.draft.mapping();
      const countryCode = this.draft.countryCode();
      const autoClean = this.draft.autoClean();
      const dedupeDays = this.draft.dedupeDays();
      const skipDuplicates = this.draft.onePerNumber();
      untracked(() => {
        if (this.timer) clearTimeout(this.timer);
        if (!preview || !mapping.phone || !/^\d{1,4}$/.test(countryCode)) return;
        this.timer = setTimeout(
          () => this.runAudit(preview.importId, mapping, countryCode, autoClean, dedupeDays, skipDuplicates),
          350,
        );
      });
    });
    effect(() => {
      const source = this.draft.source();
      untracked(() => this.loadFor(source));
    });
    this.destroyRef.onDestroy(() => {
      if (this.timer) clearTimeout(this.timer);
    });
  }

  private runAudit(
    importId: string,
    mapping: { phone: string; name: string },
    countryCode: string,
    autoClean: boolean,
    dedupeDays: number,
    skipDuplicates: boolean,
  ): void {
    const seq = ++this.auditSeq;
    this.auditing.set(true);
    this.campaignsApi
      .importAudit({
        importId,
        mapping: { phone: mapping.phone, name: mapping.name || null },
        countryCode,
        autoClean,
        dedupeDays,
        skipDuplicates,
      })
      .subscribe({
        next: (audit) => {
          if (seq !== this.auditSeq) return;
          this.auditing.set(false);
          this.error.set('');
          this.draft.audit.set(audit);
          this.draft.excludedRows.set([]);
          this.draft.previewIndex.set(0);
        },
        error: (err: Error) => {
          if (seq !== this.auditSeq) return;
          this.auditing.set(false);
          this.error.set(err.message);
        },
      });
  }

  private loadFor(source: AudienceSource): void {
    if (source === 'retarget' && !this.campaigns()) {
      this.campaignsApi.list().subscribe({
        next: ({ campaigns }) =>
          this.campaigns.set(
            campaigns.filter((c) => c.status !== 'draft' && c.status !== 'scheduled'),
          ),
        error: (err: Error) => {
          this.campaigns.set([]);
          this.error.set(err.message);
        },
      });
    }
    if (source === 'segment' && !this.segments()) {
      this.contactsApi.segments().subscribe({
        next: ({ segments }) => this.segments.set(segments),
        error: (err: Error) => {
          this.segments.set([]);
          this.error.set(err.message);
        },
      });
    }
  }

  /** Reload the list behind the current source after a failed load. */
  protected retry(): void {
    const source = this.draft.source();
    this.error.set('');
    if (source === 'retarget') this.campaigns.set(null);
    if (source === 'segment') this.segments.set(null);
    this.loadFor(source);
  }

  protected pickSource(source: AudienceSource): void {
    this.error.set('');
    this.draft.source.set(source);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) this.load(file);
  }

  protected onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.load(file);
  }

  /**
   * Typed numbers go through the same import as a file, so cleaning, dedupe
   * and the skipped-rows report work the same.
   */
  protected useTyped(): void {
    const cell = (v: string) => `"${v.trim().replace(/"/g, '""')}"`;
    const rows = this.typed()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [phone, ...name] = line.split(/[,\t;]/);
        return `${cell(phone)},${cell(name.join(' '))}`;
      });
    if (!rows.length) return;
    const csv = ['phone,name', ...rows].join('\n');
    this.load(new File([csv], 'Typed numbers.csv', { type: 'text/csv' }));
  }

  private load(file: File): void {
    if (!/\.(csv|xlsx|xlsm)$/i.test(file.name)) {
      this.error.set('Choose a .csv or .xlsx file.');
      return;
    }
    this.uploading.set(true);
    this.error.set('');
    this.campaignsApi
      .importPreview(file, this.ccValid() ? this.draft.countryCode() : '')
      .subscribe({
        next: (preview) => {
          this.uploading.set(false);
          this.duplicateOf.set(preview.duplicate ? (preview.firstUploadedAt ?? '') : null);
          this.adopt(preview);
        },
        error: (err: Error) => {
          this.uploading.set(false);
          this.error.set(err.message);
        },
      });
  }

  /** A sheet picked from Storage is handled exactly like a fresh upload. */
  protected onReused({ preview }: StorageUse): void {
    if (!preview) {
      this.error.set('The server did not return the contact list. Try again.');
      return;
    }
    this.error.set('');
    // The server flags every reopened file as a duplicate; picking one on purpose is not news.
    this.duplicateOf.set(null);
    this.adopt(preview);
  }

  private adopt(preview: ImportPreview): void {
    this.draft.adoptImport(preview);
    if (!preview.guess.phone)
      this.error.set('We could not tell which column holds the phone number - pick it below.');
  }

  protected setMapping(key: 'phone' | 'name', value: string): void {
    this.draft.mapping.update((m) => ({ ...m, [key]: value }));
  }

  protected setCountry(value: string): void {
    this.draft.countryCode.set(
      String(value ?? '')
        .replace(/[^\d]/g, '')
        .slice(0, 4),
    );
  }

  protected addColumn(): void {
    const slug = this.newSlug();
    if (!slug || this.colError()) return;
    this.draft.extraColumns.update((cols) => [...cols, { slug, value: this.newValue() }]);
    this.newCol.set('');
    this.newValue.set('');
  }

  protected setColumnValue(slug: string, value: string): void {
    this.draft.extraColumns.update((cols) =>
      cols.map((c) => (c.slug === slug ? { ...c, value } : c)),
    );
  }

  protected removeColumn(slug: string): void {
    this.draft.extraColumns.update((cols) => cols.filter((c) => c.slug !== slug));
  }

  protected copy(slug: string): void {
    const text = `{${slug}}`;
    const done = () => {
      this.copied.set(slug);
      setTimeout(() => {
        if (this.copied() === slug) this.copied.set(null);
      }, 1400);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
    else done();
  }

  protected downloadBad(): void {
    const audit = this.draft.audit();
    if (!audit?.issues.length) return;
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      ['row', 'raw', 'name', 'reason', 'detail'],
      ...audit.issues.map((i) => [
        i.row + 2,
        i.raw,
        i.name,
        REASONS[i.reason] ?? i.reason,
        i.detail,
      ]),
    ];
    const blob = new Blob([lines.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n'], {
      type: 'text/csv',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(this.draft.preview()?.filename ?? 'contacts').replace(/\.[^.]+$/, '')}-bad-rows.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  protected pickCampaign(id: string): void {
    const campaign = this.campaigns()?.find((c) => String(c.id) === id) ?? null;
    this.draft.retargetCampaign.set(campaign);
    this.draft.retarget.update((r) => ({ ...r, campaignId: campaign?.id ?? null }));
  }

  protected setFilter(filter: RetargetFilter): void {
    this.draft.retarget.update((r) => ({ ...r, filter }));
  }

  protected setOption(optionId: string): void {
    this.draft.retarget.update((r) => ({ ...r, optionId }));
  }

  protected pickSegment(id: string): void {
    const segment = this.segments()?.find((s) => String(s.id) === id) ?? null;
    this.draft.segment.set(segment);
    this.draft.segmentId.set(segment?.id ?? null);
  }

  protected dedupeLabel(days: number): string {
    return days ? `${days} days` : 'Off';
  }
}
