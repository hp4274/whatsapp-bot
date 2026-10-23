/**
 * Everything the campaign composer knows, as signals. One instance per app
 * (providedIn root) so a half-built campaign survives leaving the page.
 */

import { Injectable, computed, inject, signal } from '@angular/core';

import {
  Api,
  Campaign,
  CampaignCreate,
  Contact,
  ImportAudit,
  ImportPreview,
  PacingPreset,
  RetargetFilter,
  Segment,
} from '../core/api';
import { Store } from '../core/store';
import type { MetaMapping } from '../templates/meta-mapping';
import type { Template } from '../templates/templates-api';
import { InteractiveDraft, validateInteractive } from './interactive/interactive.model';
import {
  blank,
  hasVariation,
  plainPlaceholders,
  renderTemplateText,
  substitute,
  withFallbacks,
  zonedTimeToUtc,
} from './wa-format';

export type TemplateMode = 'free' | 'meta';

export type AudienceSource = 'file' | 'retarget' | 'segment';
export type ComposerStep = 1 | 2 | 3;

export interface DraftAttachment {
  mediaId: string;
  filename: string;
  mimetype: string;
  size: number;
  previewUrl: string;
  /** The Storage copy, so the "reuse" list can mark the one in use. */
  storageId?: number;
}

export interface DraftWarning {
  tone: 'warning' | 'danger';
  text: string;
}

export interface SendResult {
  campaign: Campaign;
  started: boolean;
  queued?: number;
  skipped?: number;
  overQuota?: number;
  error?: string;
}

export const DEFAULT_MESSAGE = 'Hi {name}, ';
/** Stand-in contact for the preview before any audience is loaded. */
const SAMPLE: Contact = { name: 'Asha', phone: '919876543210', extra: {} };

export type ScheduleMode = 'now' | 'later' | 'spread';

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Shift a `YYYY-MM-DD` calendar date by whole days. Done in UTC so a DST
 * change between the two dates can never skip or repeat a day.
 */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function defaultName(): string {
  return `Campaign ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

@Injectable({ providedIn: 'root' })
export class CampaignDraft {
  private readonly api = inject(Api);
  private readonly store = inject(Store);
  private configLoaded = false;
  private defaultCc = '91';

  readonly step = signal<ComposerStep>(1);
  readonly source = signal<AudienceSource>('file');

  // File import
  readonly preview = signal<ImportPreview | null>(null);
  readonly mapping = signal<{ phone: string; name: string }>({ phone: '', name: '' });
  readonly countryCode = signal('91');
  readonly autoClean = signal(true);
  readonly dedupeDays = signal(0);
  readonly audit = signal<ImportAudit | null>(null);
  readonly excludedRows = signal<number[]>([]);
  /** Columns typed in after the upload: one value for every row, used like a file column. */
  readonly extraColumns = signal<readonly { slug: string; value: string }[]>([]);

  // Retarget / segment
  readonly retarget = signal<{
    campaignId: number | null;
    filter: RetargetFilter;
    optionId: string;
  }>({ campaignId: null, filter: 'failed', optionId: '' });
  readonly retargetCampaign = signal<Campaign | null>(null);
  readonly segmentId = signal<number | null>(null);
  readonly segment = signal<Segment | null>(null);

  // Message
  readonly name = signal(defaultName());
  readonly message = signal(DEFAULT_MESSAGE);
  readonly fallbacks = signal<Record<string, string>>({ name: 'Valued Customer' });
  readonly attachment = signal<DraftAttachment | null>(null);
  readonly interactive = signal<InteractiveDraft | null>(null);
  readonly templateId = signal<number | null>(null);

  // Meta approved template (Cloud API only). The picked records are kept whole
  // so the preview can render their approved body.
  readonly templateMode = signal<TemplateMode>('free');
  readonly metaTemplate = signal<Template | null>(null);
  readonly templateParams = signal<MetaMapping>({ body: [] });
  readonly fallbackTemplate = signal<Template | null>(null);
  readonly fallbackTemplateParams = signal<MetaMapping>({ body: [] });
  /** Approved templates only exist on a Cloud API channel. */
  readonly cloudApi = computed(() => this.store.connection().transport === 'cloud_api');
  /** The mode that actually applies: a non-Cloud channel is always free-form. */
  readonly metaMode = computed(() => this.templateMode() === 'meta' && this.cloudApi());

  // Send
  readonly pacing = signal<PacingPreset>('balanced');
  readonly scheduleMode = signal<ScheduleMode>('now');
  readonly date = signal(today());
  readonly time = signal('10:00');
  /**
   * Spread mode: the server shuffles the uploaded list and sends equal daily
   * batches from `spreadFrom` to `spreadTo`, each day starting at `spreadTime`.
   * Defaults start tomorrow so the first batch time is never already past.
   */
  readonly spreadFrom = signal(addDays(today(), 1));
  readonly spreadTo = signal(addDays(today(), 7));
  readonly spreadTime = signal('09:00');
  readonly timezone = signal(localZone());
  readonly onePerNumber = signal(true);
  readonly result = signal<SendResult | null>(null);

  // Preview cursor
  readonly previewIndex = signal(0);
  readonly seed = signal(1);

  /** Every placeholder the message may use. */
  readonly variables = computed(() => {
    const preview = this.preview();
    if (this.source() !== 'file' || !preview) return ['name', 'phone'];
    const { phone, name } = this.mapping();
    return [
      'name',
      'phone',
      ...preview.columns
        .map((c) => c.slug)
        .filter((s) => s !== phone && s !== name && s !== 'name' && s !== 'phone'),
      ...this.extraColumns().map((c) => c.slug),
    ];
  });

  readonly validContacts = computed<Contact[]>(() => {
    const preview = this.preview();
    const audit = this.audit();
    if (this.source() !== 'file' || !preview || !audit) return [];
    const excluded = new Set(this.excludedRows());
    const { phone, name } = this.mapping();
    const phoneAt = preview.columns.findIndex((c) => c.slug === phone);
    const nameAt = preview.columns.findIndex((c) => c.slug === name);
    const added = this.extraColumns();
    return audit.valid
      .filter((v) => !excluded.has(v.row))
      .map((v) => {
        const row = preview.rows[v.row] ?? [];
        const extra: Record<string, string> = {};
        preview.columns.forEach((c, j) => {
          if (j !== phoneAt && j !== nameAt) extra[c.slug] = String(row[j] ?? '');
        });
        for (const c of added) extra[c.slug] = c.value;
        return { name: v.name, phone: v.phone, extra };
      });
  });

  /** Recipients the composer can count now (retarget audiences resolve at send time). */
  readonly audienceSize = computed(() => {
    switch (this.source()) {
      case 'file':
        return this.validContacts().length;
      case 'segment':
        return this.segment()?.count ?? 0;
      default:
        return 0;
    }
  });

  /** Best estimate for pacing/safety, including the retarget source campaign's size. */
  readonly estimatedSize = computed(() =>
    this.source() === 'retarget'
      ? (this.retargetCampaign()?.audienceSize ?? 0)
      : this.audienceSize(),
  );

  readonly previewTotal = computed(() => Math.max(1, this.validContacts().length));

  readonly previewContact = computed<Contact>(() => {
    const list = this.validContacts();
    if (!list.length) return SAMPLE;
    return list[Math.min(this.previewIndex(), list.length - 1)];
  });

  readonly previewContext = computed(() => this.contextFor(this.previewContact()));

  readonly rendered = computed(() =>
    substitute(this.message(), this.previewContext(), this.fallbacks(), this.seed()),
  );

  /** Meta mode: the approved body filled for the preview contact. */
  readonly metaRendered = computed(() =>
    renderTemplateText(
      this.metaTemplate()?.body ?? '',
      this.templateParams().body ?? [],
      this.previewContext(),
    ),
  );

  /** What the phone preview shows: the free-form message or the filled template. */
  readonly previewText = computed(() =>
    this.metaMode() ? this.metaRendered().text : this.message(),
  );

  /** Meta mode: recipients the server will skip because a {{n}} comes out empty. */
  readonly metaSkipped = computed(() => {
    const tpl = this.metaTemplate();
    if (!this.metaMode() || !tpl) return 0;
    const slots = this.templateParams().body ?? [];
    const list = this.validContacts();
    if (!list.length) return this.metaRendered().missing.length ? this.estimatedSize() : 0;
    return list.filter(
      (c) => renderTemplateText(tpl.body, slots, this.contextFor(c)).missing.length,
    ).length;
  });
  readonly unresolved = computed(() => this.rendered().missing);
  readonly hasVariation = computed(() => hasVariation(this.message()));

  /** Contacts that would get at least one blank placeholder (after fallbacks). */
  readonly contactsMissing = computed(() => {
    const keys = plainPlaceholders(this.message());
    if (!keys.length) return 0;
    const list = this.validContacts();
    if (!list.length) return this.unresolved().length ? this.estimatedSize() : 0;
    const fb = this.fallbacks();
    let count = 0;
    for (const contact of list) {
      const ctx = withFallbacks(this.rawContext(contact), fb);
      if (keys.some((k) => blank(ctx[k]))) count++;
    }
    return count;
  });

  readonly usedVariables = computed(() => {
    const vars = this.variables();
    if (this.metaMode()) {
      const m = this.templateParams();
      const used = [...(m.body ?? []), m.header, ...(m.buttons ?? [])].map((s) => s?.var ?? '');
      return vars.filter((v) => used.includes(v));
    }
    const text = this.message() + JSON.stringify(this.interactive() ?? {});
    return vars.filter((v) => text.includes(`{${v}}`) || text.includes(`{${v}|`));
  });

  readonly usedFallbacks = computed(() =>
    this.usedVariables().filter((v) => !blank(this.fallbacks()[v])),
  );

  readonly interactiveErrors = computed(() => validateInteractive(this.interactive()));

  readonly warnings = computed<DraftWarning[]>(() => {
    const out: DraftWarning[] = [];
    const size = this.estimatedSize();
    if (this.metaMode()) {
      // Meta fixes the wording, so spintax/variation advice does not apply.
      if (!this.metaTemplate())
        out.push({ tone: 'danger', text: 'Pick an approved Meta template.' });
      const skipped = this.metaSkipped();
      if (skipped > 0) {
        out.push({
          tone: 'warning',
          text: `${skipped} contact${skipped === 1 ? '' : 's'} would be skipped - a template slot (${this.metaRendered().missing.join(', ') || 'one'}) has no value or fallback.`,
        });
      }
      return out;
    }
    if (!this.message().trim()) out.push({ tone: 'danger', text: 'The message is empty.' });
    const missing = this.contactsMissing();
    if (missing > 0) {
      out.push({
        tone: 'warning',
        text: `${missing} contact${missing === 1 ? '' : 's'} would get a blank placeholder - their ${this.unresolvedKeysAll().join(', ') || 'value'} is empty.`,
      });
    }
    if (size > 50 && !this.hasVariation()) {
      out.push({
        tone: 'warning',
        text: `Identical text to ${size} people is a spam signal - add {name} or {Hi|Hello}.`,
      });
    }
    for (const e of this.interactiveErrors()) out.push({ tone: 'danger', text: `Buttons: ${e}` });
    return out;
  });

  /** Keys that are blank for at least one contact. */
  readonly unresolvedKeysAll = computed(() => {
    const keys = plainPlaceholders(this.message());
    const fb = this.fallbacks();
    const list = this.validContacts().length ? this.validContacts() : [this.previewContact()];
    return keys.filter((k) => list.some((c) => blank(withFallbacks(this.rawContext(c), fb)[k])));
  });

  /** Spreading only works on the uploaded file: other audiences resolve server-side at send time. */
  readonly spreadActive = computed(
    () => this.scheduleMode() === 'spread' && this.source() === 'file',
  );

  readonly scheduledAt = computed(() => {
    if (this.spreadActive()) {
      return zonedTimeToUtc(this.spreadFrom(), this.spreadTime(), this.timezone());
    }
    return this.scheduleMode() === 'later'
      ? zonedTimeToUtc(this.date(), this.time(), this.timezone())
      : null;
  });

  readonly audienceReady = computed(() => {
    switch (this.source()) {
      case 'file':
        return this.validContacts().length > 0;
      case 'segment':
        return this.segmentId() !== null;
      case 'retarget': {
        const r = this.retarget();
        return r.campaignId !== null && (r.filter !== 'clicked' || r.optionId.trim() !== '');
      }
    }
  });

  readonly messageReady = computed(() =>
    this.metaMode()
      ? this.metaTemplate() !== null
      : this.message().trim().length > 0 && this.interactiveErrors().length === 0,
  );

  /** Step 1 shows audience and message together, so Review opens only when both are ready. */
  readonly composeReady = computed(() => this.audienceReady() && this.messageReady());

  /** Load the tenant's default country code once. */
  init(): void {
    if (this.configLoaded) return;
    this.configLoaded = true;
    this.api.getConfig().subscribe({
      next: ({ config }) => {
        const cc = String(config.defaultCountryCode ?? '').replace(/\D/g, '');
        if (cc) {
          this.defaultCc = cc;
          if (!this.preview()) this.countryCode.set(cc);
        }
      },
      error: () => undefined,
    });
  }

  /** A contact's own values keyed by slug, before fallbacks. */
  rawContext(contact: Contact): Record<string, string> {
    return { name: contact.name ?? '', phone: contact.phone ?? '', ...(contact.extra ?? {}) };
  }

  /** Row values keyed by slug with fallbacks applied. */
  contextFor(contact: Contact | number): Record<string, string> {
    const c = typeof contact === 'number' ? (this.validContacts()[contact] ?? SAMPLE) : contact;
    return withFallbacks(this.rawContext(c), this.fallbacks());
  }

  goTo(step: ComposerStep): void {
    this.step.set(step);
  }

  /** Step the previewed contact, wrapping at both ends. */
  movePreview(delta: number): void {
    const total = this.previewTotal();
    this.previewIndex.update((i) => (i + delta + total) % total);
  }

  shuffle(): void {
    this.seed.update((s) => s + 1);
  }

  /** Swap the attachment, revoking the old object URL so previews do not leak memory. */
  setAttachment(next: DraftAttachment | null): void {
    const current = this.attachment();
    if (current?.previewUrl) URL.revokeObjectURL(current.previewUrl);
    this.attachment.set(next);
  }

  /** Pick (or clear) the approved template; its stored mapping seeds the per-campaign one. */
  pickMetaTemplate(t: Template | null, which: 'main' | 'fallback' = 'main'): void {
    const params: MetaMapping = structuredClone(t?.paramMapping ?? {});
    params.body ??= [];
    if (which === 'main') {
      this.metaTemplate.set(t);
      this.templateParams.set(params);
    } else {
      this.fallbackTemplate.set(t);
      this.fallbackTemplateParams.set(params);
    }
  }

  /** The POST /api/campaigns body for the current draft. */
  buildCreate(): CampaignCreate & { segmentId?: number } {
    const source = this.source();
    const attachment = this.attachment();
    const scheduled = this.scheduledAt();
    const body: CampaignCreate & { segmentId?: number } = {
      name: this.name().trim() || defaultName(),
      body: this.message(),
      mediaId: attachment?.mediaId ?? null,
      audience: [],
      status: scheduled ? 'scheduled' : 'draft',
      scheduledAt: scheduled ? scheduled.toISOString() : null,
      templateId: this.templateId(),
      options: {
        templateMode: 'free',
        interactive: this.interactive(),
        fallbacks: Object.fromEntries(
          Object.entries(this.fallbacks()).filter(([, v]) => !blank(v)),
        ),
        pacing: this.pacing(),
        timezone: this.timezone(),
        dedupeDays: this.dedupeDays(),
        skipDuplicates: this.onePerNumber(),
        variables: this.usedVariables(),
        mediaMeta: attachment
          ? { filename: attachment.filename, mimetype: attachment.mimetype, size: attachment.size }
          : null,
      },
    };
    if (this.spreadActive()) {
      body.options = {
        ...body.options,
        spread: { from: this.spreadFrom(), to: this.spreadTo(), startTime: this.spreadTime() },
      };
    }
    const meta = this.metaTemplate();
    if (this.metaMode() && meta) {
      // The approved body goes in `body` for history; the server sends the template.
      body.body = meta.body;
      body.templateId = meta.id;
      body.options = {
        ...body.options,
        templateMode: 'meta',
        templateParams: this.templateParams(),
        interactive: null,
      };
    }
    const fallback = this.fallbackTemplate();
    if (this.cloudApi() && !this.metaMode() && fallback) {
      body.options = {
        ...body.options,
        fallbackTemplateId: fallback.id,
        fallbackTemplateParams: this.fallbackTemplateParams(),
      };
    }
    if (source === 'file') {
      const preview = this.preview();
      const { phone, name } = this.mapping();
      // The import reference only carries file columns, so added ones force the explicit list.
      if (preview && !this.excludedRows().length && !this.extraColumns().length) {
        body.audience = {
          importId: preview.importId,
          mapping: { phone, name: name || null },
          countryCode: this.countryCode(),
          dedupeDays: this.dedupeDays(),
          autoClean: this.autoClean(),
          skipDuplicates: this.onePerNumber(),
        };
      } else {
        body.audience = this.validContacts();
      }
    } else if (source === 'retarget') {
      const r = this.retarget();
      body.audience = {
        retarget: {
          campaignId: r.campaignId ?? 0,
          filter: r.filter,
          ...(r.filter === 'clicked' ? { optionId: r.optionId.trim() } : {}),
        },
      };
    } else if (this.segmentId() !== null) {
      body.segmentId = this.segmentId()!;
    }
    return body;
  }

  /**
   * Make a parsed sheet the audience, whether it was just uploaded or reused from
   * Storage: a fresh import with the server's guessed phone and name columns.
   */
  adoptImport(preview: ImportPreview): void {
    this.clearImport();
    this.preview.set(preview);
    this.mapping.set({ phone: preview.guess.phone ?? '', name: preview.guess.name ?? '' });
  }

  /** Clear the import so a new file starts fresh (keeps the message). */
  clearImport(): void {
    this.preview.set(null);
    this.audit.set(null);
    this.excludedRows.set([]);
    this.extraColumns.set([]);
    this.mapping.set({ phone: '', name: '' });
    this.previewIndex.set(0);
  }

  reset(): void {
    this.setAttachment(null);
    this.clearImport();
    this.step.set(1);
    this.source.set('file');
    this.countryCode.set(this.defaultCc);
    this.autoClean.set(true);
    this.dedupeDays.set(0);
    this.retarget.set({ campaignId: null, filter: 'failed', optionId: '' });
    this.retargetCampaign.set(null);
    this.segmentId.set(null);
    this.segment.set(null);
    this.name.set(defaultName());
    this.message.set(DEFAULT_MESSAGE);
    this.fallbacks.set({ name: 'Valued Customer' });
    this.interactive.set(null);
    this.templateId.set(null);
    this.templateMode.set('free');
    this.pickMetaTemplate(null);
    this.pickMetaTemplate(null, 'fallback');
    this.pacing.set('balanced');
    this.scheduleMode.set('now');
    this.date.set(today());
    this.time.set('10:00');
    this.spreadFrom.set(addDays(today(), 1));
    this.spreadTo.set(addDays(today(), 7));
    this.spreadTime.set('09:00');
    this.timezone.set(localZone());
    this.onePerNumber.set(true);
    this.result.set(null);
    this.seed.set(1);
  }
}
