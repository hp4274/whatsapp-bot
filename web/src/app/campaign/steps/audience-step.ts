import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Campaign, CampaignsApi, ContactsApi, ImportIssueReason, RetargetFilter, Segment } from '../../core/api';
import { AudienceSource, CampaignDraft } from '../draft';

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

const SOURCES: { value: AudienceSource; icon: string; title: string; text: string }[] = [
  { value: 'file', icon: 'upload_file', title: 'Upload a file', text: 'CSV or Excel - every column becomes a variable' },
  { value: 'retarget', icon: 'replay', title: 'Re-target a campaign', text: 'Follow up on failed, unread or clicked' },
  { value: 'segment', icon: 'groups', title: 'Saved segment', text: 'A filter over your contacts' },
];

const FILTERS: { value: RetargetFilter; label: string; hint: string }[] = [
  { value: 'failed', label: 'Failed', hint: 'The message never arrived' },
  { value: 'unread', label: 'Delivered but not read', hint: 'Sent or delivered, no blue ticks' },
  { value: 'noreply', label: 'Read but did not reply', hint: 'Got it, said nothing' },
  { value: 'replied', label: 'Replied', hint: 'Wrote back after the campaign started' },
  { value: 'clicked', label: 'Picked a button', hint: 'Chose a specific reply option' },
];

export const DEDUPE_PRESETS = [0, 7, 30, 90];
const ISSUE_LIMIT = 200;

@Component({
  selector: 'app-audience-step',
  imports: [FormsModule],
  templateUrl: './audience-step.html',
  styleUrl: './audience-step.scss',
})
export class AudienceStep {
  protected readonly draft = inject(CampaignDraft);
  private readonly campaignsApi = inject(CampaignsApi);
  private readonly contactsApi = inject(ContactsApi);

  protected readonly sources = SOURCES;
  protected readonly filters = FILTERS;
  protected readonly reasons = REASONS;
  protected readonly dedupePresets = DEDUPE_PRESETS;

  protected readonly uploading = signal(false);
  protected readonly auditing = signal(false);
  protected readonly dragOver = signal(false);
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
    return [{ header: 'Name column', slug: 'name', sample: nameAt >= 0 ? String(first[nameAt] ?? '') : '' }, ...out];
  });
  protected readonly issues = computed(() => (this.draft.audit()?.issues ?? []).slice(0, ISSUE_LIMIT));
  protected readonly moreIssues = computed(() => Math.max(0, (this.draft.audit()?.issues.length ?? 0) - ISSUE_LIMIT));

  private timer: ReturnType<typeof setTimeout> | null = null;
  private auditSeq = 0;

  constructor() {
    // Re-audit (debounced) whenever the file, mapping or cleaning rules change.
    effect(() => {
      const preview = this.draft.preview();
      const mapping = this.draft.mapping();
      const countryCode = this.draft.countryCode();
      const autoClean = this.draft.autoClean();
      const dedupeDays = this.draft.dedupeDays();
      untracked(() => {
        if (this.timer) clearTimeout(this.timer);
        if (!preview || !mapping.phone || !/^\d{1,4}$/.test(countryCode)) return;
        this.timer = setTimeout(() => this.runAudit(preview.importId, mapping, countryCode, autoClean, dedupeDays), 350);
      });
    });
    effect(() => {
      const source = this.draft.source();
      untracked(() => this.loadFor(source));
    });
    inject(DestroyRef).onDestroy(() => { if (this.timer) clearTimeout(this.timer); });
  }

  private runAudit(importId: string, mapping: { phone: string; name: string }, countryCode: string,
    autoClean: boolean, dedupeDays: number): void {
    const seq = ++this.auditSeq;
    this.auditing.set(true);
    this.campaignsApi.importAudit({
      importId, mapping: { phone: mapping.phone, name: mapping.name || null }, countryCode, autoClean, dedupeDays,
    }).subscribe({
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
        next: ({ campaigns }) => this.campaigns.set(campaigns.filter((c) => c.status !== 'draft' && c.status !== 'scheduled')),
        error: (err: Error) => { this.campaigns.set([]); this.error.set(err.message); },
      });
    }
    if (source === 'segment' && !this.segments()) {
      this.contactsApi.segments().subscribe({
        next: ({ segments }) => this.segments.set(segments),
        error: (err: Error) => { this.segments.set([]); this.error.set(err.message); },
      });
    }
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

  private load(file: File): void {
    if (!/\.(csv|xlsx|xlsm)$/i.test(file.name)) {
      this.error.set('Choose a .csv or .xlsx file.');
      return;
    }
    this.uploading.set(true);
    this.error.set('');
    this.campaignsApi.importPreview(file, this.ccValid() ? this.draft.countryCode() : '').subscribe({
      next: (preview) => {
        this.uploading.set(false);
        this.draft.clearImport();
        this.draft.preview.set(preview);
        this.draft.mapping.set({ phone: preview.guess.phone ?? '', name: preview.guess.name ?? '' });
        if (!preview.guess.phone) this.error.set('We could not tell which column holds the phone number - pick it below.');
      },
      error: (err: Error) => {
        this.uploading.set(false);
        this.error.set(err.message);
      },
    });
  }

  protected setMapping(key: 'phone' | 'name', value: string): void {
    this.draft.mapping.update((m) => ({ ...m, [key]: value }));
  }

  protected setCountry(value: string): void {
    this.draft.countryCode.set(String(value ?? '').replace(/[^\d]/g, '').slice(0, 4));
  }

  protected copy(slug: string): void {
    const text = `{${slug}}`;
    const done = () => {
      this.copied.set(slug);
      setTimeout(() => { if (this.copied() === slug) this.copied.set(null); }, 1400);
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
    const lines = [['row', 'raw', 'name', 'reason', 'detail'],
      ...audit.issues.map((i) => [i.row + 2, i.raw, i.name, REASONS[i.reason] ?? i.reason, i.detail])];
    const blob = new Blob([lines.map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv' });
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

  protected proceed(): void {
    if (this.draft.audienceReady()) this.draft.goTo(2);
  }

  protected dedupeLabel(days: number): string {
    return days ? `${days} days` : 'Off';
  }
}
