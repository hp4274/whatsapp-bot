/**
 * Everything the campaign composer knows, as signals. One instance per app
 * (providedIn root) so a half-built campaign survives leaving the page, and
 * the serialisable part is autosaved to localStorage so it survives a reload.
 */

import { Injectable, WritableSignal, computed, effect, inject, signal, untracked } from '@angular/core';
import { Observable, forkJoin, of, throwError } from 'rxjs';
import { catchError, map, switchMap, tap } from 'rxjs/operators';

import {
  Api,
  Campaign,
  CampaignCreate,
  CampaignStartResult,
  CampaignsApi,
  Contact,
  ContactFilter,
  ContactsApi,
  ImportAudit,
  ImportPreview,
  CampaignRecurrence,
  CampaignVariant,
  PacingPreset,
  RetargetFilter,
  Segment,
} from '../core/api';
import { Auth } from '../core/auth';
import { Store } from '../core/store';
import { StorageApi } from '../storage/storage-api';
import { TemplatesApi } from '../templates/templates-api';
import {
  InteractiveDraft,
  ReplyRule,
  validateInteractive,
} from './interactive/interactive.model';
import {
  blank,
  hasVariation,
  plainPlaceholders,
  substitute,
  withFallbacks,
  zonedTimeToUtc,
} from './wa-format';

/**
 * `contacts` is the contact book: a saved segment (`segmentId`) or an inline
 * tag filter (`contactFilter`). `segment` is the older segment-only source,
 * kept so existing reads still work.
 */
export type AudienceSource = 'file' | 'retarget' | 'segment' | 'contacts';
/** 1 Who, 2 Message, 3 When & send. The result screen shows whenever `result` is set. */
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

/** What the result screen shows; the skip fields are copied from the start response. */
export interface SendResult extends Pick<
  CampaignStartResult,
  | 'skippedOptOut'
  | 'skippedMuted'
  | 'skippedFrequency'
  | 'skippedNoOptIn'
  | 'pacingClamped'
  | 'policyNotes'
  | 'carried'
> {
  campaign: Campaign;
  started: boolean;
  queued?: number;
  skipped?: number;
  overQuota?: number;
  error?: string;
}

export const DEFAULT_MESSAGE = 'Hi {name}, ';
/** Appended (after a blank line) when "Add opt-out line" is on; the STOP reply itself is handled server-side. */
export const OPT_OUT_TEXT = 'Reply STOP to stop messages';
/** Identical text to more people than this gets a warning (the QR limit comes from the server). */
const VARY_ABOVE = 50;
/** QR numbers before the server's safety arrives: its QR_VARY_ABOVE. */
const QR_VARY_ABOVE = 15;
/** Stand-in contact for the preview before any audience is loaded. */
const SAMPLE: Contact = { name: 'Asha', phone: '919876543210', extra: {} };
/** Statuses the server lets `PUT /campaigns/:id` change. */
const EDITABLE: readonly Campaign['status'][] = ['draft', 'scheduled'];
/** Typing bursts collapse into one localStorage write. */
const AUTOSAVE_MS = 500;
/** Bump when the snapshot shape changes; older snapshots are ignored, not migrated. */
const SNAPSHOT_VERSION = 1;

export type ScheduleMode = 'now' | 'later' | 'spread';
export type RepeatEvery = '' | CampaignRecurrence['every'];
export type VariantKey = CampaignVariant['key'];

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

/** The body with the opt-out line at the end, once, however often it is applied. */
export function withOptOut(body: string): string {
  const text = body.replace(/\s+$/, '');
  return text.endsWith(OPT_OUT_TEXT) ? text : `${text}\n\n${OPT_OUT_TEXT}`;
}

/** The body without a trailing opt-out line, and whether it had one. */
export function withoutOptOut(body: string): { text: string; had: boolean } {
  const text = body.replace(/\s+$/, '');
  if (!text.endsWith(OPT_OUT_TEXT)) return { text: body, had: false };
  return { text: text.slice(0, -OPT_OUT_TEXT.length).replace(/\s+$/, ''), had: true };
}

const digits = (phone: string) => phone.replace(/\D/g, '');

/**
 * Typed numbers, one per line with an optional name after a comma, tab or
 * semicolon. A number of 10 digits or fewer without "+" gets the country code,
 * matching the server's rule; junk and repeats are dropped.
 */
export function parseExtraNumbers(text: string, countryCode: string): Contact[] {
  const out: Contact[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const [raw = '', ...rest] = line.split(/[,\t;]/);
    let phone = digits(raw);
    if (!raw.trim().startsWith('+') && phone.length <= 10) phone = countryCode + phone;
    if (phone.length < 8 || phone.length > 15 || seen.has(phone)) continue;
    seen.add(phone);
    // "+" so the server never adds its own default country code on top.
    out.push({ phone: `+${phone}`, name: rest.join(' ').trim(), extra: {} });
  }
  return out;
}

/** A filter that narrows something; an empty one would mean every contact. */
export function hasCriteria(filter: ContactFilter): boolean {
  return (
    !!filter.tags?.length ||
    !!filter.anyTags?.length ||
    !!filter.notTags?.length ||
    !!filter.status ||
    !!filter.optInStatus ||
    !!filter.source ||
    !!filter.search?.trim() ||
    !!filter.ids?.length ||
    Object.keys(filter.custom ?? {}).length > 0
  );
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

/** A UTC instant as the wall-clock `YYYY-MM-DD` and `HH:MM` in `timeZone`. */
function zonedParts(at: Date, timeZone: string): { date: string; time: string } {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(at)
        .map((p) => [p.type, p.value]),
    );
    return {
      date: `${parts['year']}-${parts['month']}-${parts['day']}`,
      time: `${parts['hour']}:${parts['minute']}`,
    };
  } catch {
    return { date: today(), time: '10:00' };
  }
}

/**
 * What autosave writes. Plain signals go in `signals` by name; the uploaded
 * sheet is too big for localStorage, so only its Storage id and mapping are
 * kept and the sheet is reopened from Storage on restore.
 */
interface DraftSnapshot {
  v: number;
  savedAt: number;
  signals: Record<string, unknown>;
  file: {
    storageId: number | null;
    importId: string;
    filename: string;
    mapping: { phone: string; name: string };
  } | null;
  attachment: Omit<DraftAttachment, 'previewUrl'> | null;
  retargetCampaign: Campaign | null;
}

@Injectable({ providedIn: 'root' })
export class CampaignDraft {
  private readonly api = inject(Api);
  private readonly campaignsApi = inject(CampaignsApi);
  private readonly contactsApi = inject(ContactsApi);
  private readonly templatesApi = inject(TemplatesApi);
  private readonly storageApi = inject(StorageApi);
  private readonly auth = inject(Auth);
  private readonly store = inject(Store);
  private initialised = false;
  private defaultCc = '91';
  /** Set once in init(), so a later sign-in switch never writes under the wrong key. */
  private storageKey = '';
  /** False until init() has read any earlier snapshot, so a fresh draft never overwrites it unseen. */
  private readonly armed = signal(false);
  /** An earlier session's snapshot waiting for Continue / Start fresh. */
  private readonly saved = signal<DraftSnapshot | null>(null);

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
  /**
   * A duplicated or edited campaign's stored recipient list. Saved campaigns
   * keep the resolved list, not the sheet, so it stands in for the import
   * until a new file replaces it.
   */
  readonly savedAudience = signal<Contact[] | null>(null);
  /** The campaign `savedAudience` came from, so a restored draft can fetch it again. */
  readonly audienceFrom = signal<number | null>(null);

  // Retarget / segment / contacts
  readonly retarget = signal<{
    campaignId: number | null;
    filter: RetargetFilter;
    optionId: string;
  }>({ campaignId: null, filter: 'failed', optionId: '' });
  readonly retargetCampaign = signal<Campaign | null>(null);
  readonly segmentId = signal<number | null>(null);
  readonly segment = signal<Segment | null>(null);
  /** Contacts source without a segment: the inline filter sent as `audience`. */
  readonly contactFilter = signal<ContactFilter>({});
  /** How many contacts `contactFilter` matches; set by the audience step after it counts. */
  readonly contactsCount = signal<number | null>(null);
  /** Numbers typed on top of any audience, one per line ("number, name"). */
  readonly extraNumbers = signal('');
  readonly extraList = computed(() => parseExtraNumbers(this.extraNumbers(), this.countryCode()));

  // Message
  readonly name = signal(defaultName());
  readonly message = signal(DEFAULT_MESSAGE);
  readonly fallbacks = signal<Record<string, string>>({ name: 'Valued Customer' });
  readonly attachment = signal<DraftAttachment | null>(null);
  readonly interactive = signal<InteractiveDraft | null>(null);
  readonly templateId = signal<number | null>(null);
  /** What happens when someone taps a button; saved with `PUT /campaigns/:id/reply-rules`. */
  readonly replyRules = signal<ReplyRule[]>([]);
  /**
   * Append OPT_OUT_TEXT to the body; only this box adds it. Ticked for the
   * business's first campaign, unticked once it has one (`optOutDefault`).
   */
  readonly optOutLine = signal(true);
  /** What a new draft starts with: false once the business has any campaign (checked in init). */
  private optOutDefault = true;
  /** Rewrite links so taps are counted; the server ignores it when it cannot. */
  readonly trackLinks = signal(false);
  /**
   * A/B test: version B's text, or null while the test is off. Version A is the
   * main message, so turning the test off never loses anything the user wrote.
   */
  readonly variantB = signal<string | null>(null);
  /** Optional third version; only meaningful while `variantB` is on. */
  readonly variantC = signal<string | null>(null);
  /** The version the editor and the phone preview are showing. Not autosaved. */
  readonly activeVersion = signal<VariantKey>('A');

  /** QR-linked number: buttons go as a text menu, and bulk text must vary. */
  readonly qrNumber = computed(() => this.store.qrNumber());
  /** A QR number's variation threshold today (server `safety.content`); null elsewhere. */
  readonly content = computed(() =>
    this.qrNumber() ? (this.store.safety()?.content ?? null) : null,
  );
  /** Identical text to more people than this is refused on QR, and warned about elsewhere. */
  readonly varyAbove = computed(
    () => this.content()?.varyAbove ?? (this.qrNumber() ? QR_VARY_ABOVE : VARY_ABOVE),
  );
  // Send
  /** The saved campaign this draft writes to: save() updates it instead of creating another. */
  readonly editingId = signal<number | null>(null);
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
  /** Run again on this cadence once a run finishes; '' for a one-off. */
  readonly repeatEvery = signal<RepeatEvery>('');
  /** Last day a repeat may start (`YYYY-MM-DD`); '' for no end. */
  readonly repeatUntil = signal('');
  readonly result = signal<SendResult | null>(null);

  // Preview cursor
  readonly previewIndex = signal(0);
  readonly seed = signal(1);

  /** Signals autosave keeps verbatim, by name. Loaded records stay small enough to keep whole. */
  private readonly kept: Record<string, WritableSignal<unknown>> = {
    step: this.step,
    source: this.source,
    countryCode: this.countryCode,
    autoClean: this.autoClean,
    dedupeDays: this.dedupeDays,
    extraColumns: this.extraColumns,
    audienceFrom: this.audienceFrom,
    retarget: this.retarget,
    segmentId: this.segmentId,
    segment: this.segment,
    contactFilter: this.contactFilter,
    contactsCount: this.contactsCount,
    extraNumbers: this.extraNumbers,
    name: this.name,
    message: this.message,
    fallbacks: this.fallbacks,
    interactive: this.interactive,
    templateId: this.templateId,
    replyRules: this.replyRules,
    optOutLine: this.optOutLine,
    trackLinks: this.trackLinks,
    variantB: this.variantB,
    variantC: this.variantC,
    editingId: this.editingId,
    pacing: this.pacing,
    scheduleMode: this.scheduleMode,
    date: this.date,
    time: this.time,
    spreadFrom: this.spreadFrom,
    spreadTo: this.spreadTo,
    spreadTime: this.spreadTime,
    timezone: this.timezone,
    onePerNumber: this.onePerNumber,
    repeatEvery: this.repeatEvery,
    repeatUntil: this.repeatUntil,
  } as unknown as Record<string, WritableSignal<unknown>>;

  /** The earlier session's draft the "Continue where you left off" banner offers. */
  readonly savedDraft = computed(() => {
    const s = this.saved();
    return s ? { name: String(s.signals['name'] ?? ''), savedAt: s.savedAt } : null;
  });

  /** Every placeholder the message may use. */
  readonly variables = computed(() => {
    const preview = this.preview();
    if (this.source() !== 'file') return ['name', 'phone'];
    if (!preview) {
      const first = this.savedAudience()?.[0];
      return [
        'name',
        'phone',
        ...Object.keys(first?.extra ?? {}).filter((k) => k !== 'name' && k !== 'phone'),
      ];
    }
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
    if (this.source() !== 'file') return [];
    const preview = this.preview();
    if (!preview) return this.savedAudience() ?? [];
    const audit = this.audit();
    if (!audit) return [];
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

  /** The file's contacts plus the typed numbers it doesn't already have. */
  readonly fileAudience = computed<Contact[]>(() => {
    const list = this.validContacts();
    const seen = new Set(list.map((c) => digits(c.phone)));
    return [...list, ...this.extraList().filter((c) => !seen.has(digits(c.phone)))];
  });

  /** Recipients the composer can count now (retarget audiences resolve at send time). */
  readonly audienceSize = computed(() => {
    const extra = this.extraList().length;
    switch (this.source()) {
      case 'file':
        return this.fileAudience().length;
      case 'segment':
        return (this.segment()?.count ?? 0) + extra;
      case 'contacts':
        return (
          (this.segmentId() !== null ? (this.segment()?.count ?? 0) : (this.contactsCount() ?? 0)) +
          extra
        );
      default:
        return extra;
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

  /** The free-form body as it is sent: the message plus the opt-out line when that is on. */
  readonly outgoingBody = computed(() =>
    this.optOutLine() ? withOptOut(this.message()) : this.message(),
  );

  /**
   * Every version as it is sent, A first. B and C count only while B has text:
   * an empty B means "no test", and C without B is dropped.
   */
  readonly versions = computed<CampaignVariant[]>(() => {
    const b = this.variantB() ?? '';
    if (!b.trim()) return [];
    const withLine = (text: string) => (this.optOutLine() ? withOptOut(text) : text);
    const out: CampaignVariant[] = [
      { key: 'A', body: this.outgoingBody() },
      { key: 'B', body: withLine(b) },
    ];
    const c = this.variantC() ?? '';
    if (c.trim()) out.push({ key: 'C', body: withLine(c) });
    return out;
  });

  /** The versions the A/B switch currently offers; empty while the test is off. */
  readonly versionKeys = computed<VariantKey[]>(() => {
    if (this.variantB() === null) return [];
    return this.variantC() === null ? ['A', 'B'] : ['A', 'B', 'C'];
  });

  /** The text of the version being edited, before the opt-out line. */
  readonly activeMessage = computed(() => {
    const key = this.shownVersion();
    if (key === 'B') return this.variantB() ?? '';
    if (key === 'C') return this.variantC() ?? '';
    return this.message();
  });

  /** `activeVersion`, unless that version no longer exists (the test was turned off). */
  readonly shownVersion = computed<VariantKey>(() =>
    this.versionKeys().includes(this.activeVersion()) ? this.activeVersion() : 'A',
  );

  setActiveMessage(text: string): void {
    const key = this.shownVersion();
    if (key === 'B') this.variantB.set(text);
    else if (key === 'C') this.variantC.set(text);
    else this.message.set(text);
  }

  /** Any version of the message has a link, so "Track link clicks" has something to track. */
  readonly hasLink = computed(() =>
    [this.message(), this.variantB() ?? '', this.variantC() ?? ''].some((t) =>
      /(?:https?:\/\/|www\.)\S+/i.test(t),
    ),
  );

  /** What the phone preview shows: the version being edited, with the opt-out line. */
  readonly previewText = computed(() => {
    const text = this.activeMessage();
    return this.optOutLine() ? withOptOut(text) : text;
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
    const text =
      this.message() +
      (this.variantB() ?? '') +
      (this.variantC() ?? '') +
      JSON.stringify(this.interactive() ?? {});
    return vars.filter((v) => text.includes(`{${v}}`) || text.includes(`{${v}|`));
  });

  readonly usedFallbacks = computed(() =>
    this.usedVariables().filter((v) => !blank(this.fallbacks()[v])),
  );

  readonly interactiveErrors = computed(() => validateInteractive(this.interactive()));

  readonly warnings = computed<DraftWarning[]>(() => {
    const out: DraftWarning[] = [];
    const size = this.estimatedSize();
    if (!this.message().trim()) out.push({ tone: 'danger', text: 'The message is empty.' });
    if (this.variantB() !== null && !this.variantB()!.trim()) {
      out.push({ tone: 'warning', text: 'Version B is empty, so everyone gets version A.' });
    }
    const missing = this.contactsMissing();
    if (missing > 0) {
      out.push({
        tone: 'warning',
        text: `${missing} contact${missing === 1 ? '' : 's'} would get a blank placeholder - their ${this.unresolvedKeysAll().join(', ') || 'value'} is empty.`,
      });
    }
    if (size > this.varyAbove() && !this.hasVariation()) {
      out.push({
        tone: 'warning',
        text: `Identical text to ${size} people is a spam signal - add {name} or {Hi|Hello}.`,
      });
    }
    for (const e of this.interactiveErrors()) out.push({ tone: 'danger', text: `Buttons: ${e}` });
    return out;
  });

  /** Every body that goes out (each A/B version), before the text menu. */
  private readonly bodies = computed(() =>
    this.versions().length ? this.versions().map((v) => v.body) : [this.outgoingBody()],
  );

  /** Keys that are blank for at least one contact. */
  readonly unresolvedKeysAll = computed(() => {
    const keys = plainPlaceholders(this.message());
    const fb = this.fallbacks();
    const list = this.validContacts().length ? this.validContacts() : [this.previewContact()];
    return keys.filter((k) => list.some((c) => blank(withFallbacks(this.rawContext(c), fb)[k])));
  });

  /**
   * Spreading only works on an explicit list (the uploaded file): the server
   * spreads only array audiences, and the others resolve at send time.
   */
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
        return this.fileAudience().length > 0;
      case 'segment':
        return this.segmentId() !== null;
      case 'contacts':
        return this.segmentId() !== null || hasCriteria(this.contactFilter());
      case 'retarget': {
        const r = this.retarget();
        return r.campaignId !== null && (r.filter !== 'clicked' || r.optionId.trim() !== '');
      }
    }
  });

  readonly messageReady = computed(
    () => this.message().trim().length > 0 && this.interactiveErrors().length === 0,
  );

  /** "When & send" opens only once both earlier steps are ready. */
  readonly composeReady = computed(() => this.audienceReady() && this.messageReady());

  /** Nothing worth offering back after a reload. */
  private readonly blankDraft = computed(
    () =>
      !this.preview() &&
      !this.savedAudience() &&
      this.retarget().campaignId === null &&
      this.segmentId() === null &&
      !hasCriteria(this.contactFilter()) &&
      this.message() === DEFAULT_MESSAGE &&
      !this.attachment() &&
      !this.interactive() &&
      this.templateId() === null &&
      this.variantB() === null &&
      this.editingId() === null,
  );

  constructor() {
    // Autosave. A sent draft is gone from storage at once; anything else is
    // written after a short pause so typing does not write per keystroke.
    effect((onCleanup) => {
      if (!this.armed()) {
        // Walking on past Who with the resume banner still up means choosing this draft:
        // the old one is dropped so this one autosaves instead of being lost.
        if (this.saved() && this.step() > 1 && !this.blankDraft()) {
          untracked(() => this.discardSaved());
        }
        return;
      }
      if (this.result() || this.blankDraft()) {
        this.forget();
        return;
      }
      const snapshot = this.snapshot();
      const timer = setTimeout(() => this.write(snapshot), AUTOSAVE_MS);
      onCleanup(() => clearTimeout(timer));
    });
  }

  /** Load the tenant's default country code and any autosaved draft, once. */
  init(): void {
    if (this.initialised) return;
    this.initialised = true;
    const user = this.auth.user();
    this.storageKey = `wsender.campaignDraft.${this.auth.tenantId() ?? 0}.${user?.id ?? 0}`;
    const saved = this.read();
    this.saved.set(saved);
    this.armed.set(saved === null);
    // After the first campaign the box starts unticked. A saved draft or an edit keeps its own choice.
    this.campaignsApi.list().subscribe({
      next: ({ campaigns }) => {
        if (!campaigns.length) return;
        this.optOutDefault = false;
        if (!this.saved() && this.editingId() == null) this.optOutLine.set(false);
      },
      error: () => undefined,
    });
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

  /**
   * A restored or duplicated attachment has no local File to preview: fetch an image back so the
   * phone preview is not blank. The type is checked on the blob since saved metadata may lack it.
   */
  private loadPreview(mediaId: string): void {
    this.templatesApi.mediaBlob(mediaId).subscribe({
      next: (blob) => {
        const current = this.attachment();
        if (current?.mediaId !== mediaId || !blob.type.startsWith('image/')) return;
        this.setAttachment({ ...current, previewUrl: URL.createObjectURL(blob) });
      },
      error: () => undefined,
    });
  }

  /** The POST /api/campaigns (or PUT /api/campaigns/:id) body for the current draft. */
  buildCreate(): CampaignCreate {
    const source = this.source();
    const attachment = this.attachment();
    const scheduled = this.scheduledAt();
    const optOut = this.optOutLine();
    const body: CampaignCreate = {
      name: this.name().trim() || defaultName(),
      body: optOut ? withOptOut(this.message()) : this.message(),
      mediaId: attachment?.mediaId ?? null,
      audience: [],
      status: scheduled ? 'scheduled' : 'draft',
      scheduledAt: scheduled ? scheduled.toISOString() : null,
      templateId: this.templateId(),
      // An edit may be moving off a segment, so the field is always sent.
      segmentId: null,
      options: {
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
        optOutLine: optOut,
        trackLinks: this.trackLinks() && !this.qrNumber(),
        // Always sent, so an edit that turns the test or the repeat off clears the stored one.
        variants: this.versions().length ? this.versions() : null,
        recurrence: null,
        // A file merges typed numbers into its own list; other audiences resolve at send time.
        extraNumbers:
          source !== 'file' && this.extraList().length
            ? this.extraList().map(({ phone, name }) => ({ phone, name }))
            : null,
      },
    };
    // Spread and repeat are exclusive (the server refuses both): the spread wins here.
    if (this.repeatEvery() && !this.spreadActive()) {
      body.options = {
        ...body.options,
        recurrence: {
          every: this.repeatEvery() as CampaignRecurrence['every'],
          ...(this.repeatUntil() ? { until: this.repeatUntil() } : {}),
        },
      };
    }
    if (this.spreadActive()) {
      body.options = {
        ...body.options,
        spread: { from: this.spreadFrom(), to: this.spreadTo(), startTime: this.spreadTime() },
      };
    }
    if (source === 'file') {
      const preview = this.preview();
      const { phone, name } = this.mapping();
      // The import reference only carries file rows and columns, so added ones force the explicit list.
      if (
        preview &&
        !this.excludedRows().length &&
        !this.extraColumns().length &&
        !this.extraList().length
      ) {
        body.audience = {
          importId: preview.importId,
          mapping: { phone, name: name || null },
          countryCode: this.countryCode(),
          dedupeDays: this.dedupeDays(),
          autoClean: this.autoClean(),
          skipDuplicates: this.onePerNumber(),
        };
      } else {
        body.audience = this.fileAudience();
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
    } else if (source === 'contacts') {
      // A plain filter object: the server resolves it against the contact book at send time.
      body.audience = this.contactFilter();
    }
    return body;
  }

  /**
   * Save the draft: create it the first time and update it after, so a retry
   * or a second "Save draft" never makes another campaign. Reply rules go in
   * a second call because they are keyed by the saved campaign's id.
   */
  save(): Observable<Campaign> {
    const id = this.editingId();
    const body = this.buildCreate();
    const request =
      id !== null ? this.campaignsApi.update(id, body) : this.campaignsApi.create(body);
    return request.pipe(
      tap(({ campaign }) => this.editingId.set(campaign.id)),
      switchMap(({ campaign }) => {
        // Rules only mean something with buttons; an edit may be clearing earlier ones.
        const rules = this.interactive() ? this.replyRules() : [];
        if (!rules.length && id === null) return of(campaign);
        return this.campaignsApi.saveReplyRules(campaign.id, rules).pipe(
          map(() => campaign),
          catchError((err: Error) =>
            throwError(
              () =>
                new Error(`The campaign was saved, but its auto-replies were not: ${err.message}`),
            ),
          ),
        );
      }),
    );
  }

  /** The segment record (name, live count) for an id; null when it no longer exists. */
  loadSegment(id: number): Observable<Segment | null> {
    return this.contactsApi.segments().pipe(
      map(({ segments }) => segments.find((s) => s.id === id) ?? null),
      tap((segment) => {
        if (this.segmentId() === id) this.segment.set(segment);
      }),
    );
  }

  /**
   * Load a saved campaign into the draft. `duplicate` starts a new campaign
   * from it ("Copy of ..."); `edit` keeps its id so save() updates it, and
   * refuses a campaign that has already started.
   */
  prefillFrom(id: number, mode: 'duplicate' | 'edit'): Observable<Campaign> {
    return this.campaignsApi.get(id).pipe(
      switchMap(({ campaign }) => {
        // A spread between batches is 'scheduled', but the server refuses a new list once it has sent any.
        const started = (campaign.options?.spread?.cursor ?? 0) > 0;
        if (mode === 'edit' && (!EDITABLE.includes(campaign.status) || started)) {
          return throwError(
            () => new Error(`"${campaign.name}" has already started - duplicate it instead.`),
          );
        }
        this.applyCampaign(campaign, mode);
        // The records behind ids. A lookup that fails leaves its part for the user to re-pick.
        const quiet = <T>(o: Observable<T>) => o.pipe(catchError(() => of(null)));
        const options = campaign.options ?? {};
        const loads: Observable<unknown>[] = [
          quiet(this.campaignsApi.replyRules(campaign.id)).pipe(
            tap((r) => this.replyRules.set(r?.rules ?? [])),
          ),
        ];
        if (campaign.segmentId !== null) loads.push(quiet(this.loadSegment(campaign.segmentId)));
        const retargetId = this.retarget().campaignId;
        if (this.source() === 'retarget' && retargetId !== null) {
          loads.push(
            quiet(this.campaignsApi.get(retargetId)).pipe(
              tap((r) => r && this.retargetCampaign.set(r.campaign)),
            ),
          );
        }
        return forkJoin(loads).pipe(map(() => campaign));
      }),
    );
  }

  /** The synchronous part of prefillFrom: everything the campaign record itself holds. */
  applyCampaign(campaign: Campaign, mode: 'duplicate' | 'edit'): void {
    this.reset();
    const options = campaign.options ?? {};
    this.editingId.set(mode === 'edit' ? campaign.id : null);
    this.name.set(mode === 'duplicate' ? `Copy of ${campaign.name}` : campaign.name);

    // Audience
    const audience = campaign.audience as unknown;
    const isObject = !!audience && typeof audience === 'object' && !Array.isArray(audience);
    if (campaign.segmentId !== null) {
      this.source.set('contacts');
      this.segmentId.set(campaign.segmentId);
    } else if (isObject && 'retarget' in (audience as object)) {
      const r = (
        audience as { retarget: { campaignId: number; filter: RetargetFilter; optionId?: string } }
      ).retarget;
      this.source.set('retarget');
      this.retarget.set({ campaignId: r.campaignId, filter: r.filter, optionId: r.optionId ?? '' });
    } else if (Array.isArray(audience)) {
      this.source.set('file');
      this.savedAudience.set(audience as Contact[]);
      this.audienceFrom.set(campaign.id);
    } else if (isObject) {
      this.source.set('contacts');
      this.contactFilter.set(audience as ContactFilter);
    }

    // Message
    const { text, had } = withoutOptOut(campaign.body ?? '');
    this.message.set(text);
    this.optOutLine.set(options.optOutLine === true || had);
    this.templateId.set(campaign.templateId);
    if (campaign.mediaId) {
      const meta = options.mediaMeta;
      this.setAttachment({
        mediaId: campaign.mediaId,
        filename: meta?.filename ?? 'Attachment',
        mimetype: meta?.mimetype ?? '',
        size: meta?.size ?? 0,
        previewUrl: '',
      });
      this.loadPreview(campaign.mediaId);
    }
    this.interactive.set((options.interactive as InteractiveDraft | null) ?? null);
    this.trackLinks.set(options.trackLinks === true);
    const [, b, c] = options.variants ?? [];
    if (b) {
      this.variantB.set(withoutOptOut(b.body).text);
      this.variantC.set(c ? withoutOptOut(c.body).text : null);
    }
    if (options.extraNumbers?.length) {
      this.extraNumbers.set(
        options.extraNumbers.map((e) => (e.name ? `${e.phone}, ${e.name}` : e.phone)).join('\n'),
      );
    }
    if (options.recurrence) {
      this.repeatEvery.set(options.recurrence.every);
      this.repeatUntil.set(options.recurrence.until ?? '');
    }
    if (options.fallbacks && Object.keys(options.fallbacks).length)
      this.fallbacks.set(options.fallbacks);

    // Send. A duplicate starts as "now": the original's dates are usually past.
    this.pacing.set(options.pacing ?? 'balanced');
    if (options.timezone) this.timezone.set(options.timezone);
    this.dedupeDays.set(options.dedupeDays ?? 0);
    this.onePerNumber.set(options.skipDuplicates !== false);
    if (mode === 'edit') {
      if (options.spread) {
        this.scheduleMode.set('spread');
        this.spreadFrom.set(options.spread.from);
        this.spreadTo.set(options.spread.to);
        this.spreadTime.set(options.spread.startTime);
      } else if (campaign.status === 'scheduled' && campaign.scheduledAt) {
        const at = zonedParts(new Date(campaign.scheduledAt), this.timezone());
        this.scheduleMode.set('later');
        this.date.set(at.date);
        this.time.set(at.time);
      }
    }
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
    this.savedAudience.set(null);
    this.audienceFrom.set(null);
    this.previewIndex.set(0);
  }

  /** Throw the draft away, autosave included. */
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
    this.contactFilter.set({});
    this.contactsCount.set(null);
    this.extraNumbers.set('');
    this.name.set(defaultName());
    this.message.set(DEFAULT_MESSAGE);
    this.fallbacks.set({ name: 'Valued Customer' });
    this.interactive.set(null);
    this.templateId.set(null);
    this.replyRules.set([]);
    this.optOutLine.set(this.optOutDefault);
    this.trackLinks.set(false);
    this.variantB.set(null);
    this.variantC.set(null);
    this.activeVersion.set('A');
    this.editingId.set(null);
    this.pacing.set('balanced');
    this.scheduleMode.set('now');
    this.date.set(today());
    this.time.set('10:00');
    this.spreadFrom.set(addDays(today(), 1));
    this.spreadTo.set(addDays(today(), 7));
    this.spreadTime.set('09:00');
    this.timezone.set(localZone());
    this.onePerNumber.set(true);
    this.repeatEvery.set('');
    this.repeatUntil.set('');
    this.result.set(null);
    this.seed.set(1);
    this.forget();
  }

  /**
   * Continue the earlier session's draft. The uploaded sheet is reopened from
   * Storage and a duplicated list is fetched again; the observable errors
   * with a plain message when either is gone (everything else is restored).
   */
  restore(): Observable<void> {
    const snap = this.saved();
    this.saved.set(null);
    this.armed.set(true);
    if (!snap) return of(undefined);
    this.reset();
    for (const [key, value] of Object.entries(snap.signals)) this.kept[key]?.set(value);
    if (snap.attachment) {
      this.setAttachment({ ...snap.attachment, previewUrl: '' });
      this.loadPreview(snap.attachment.mediaId);
    }
    this.retargetCampaign.set(snap.retargetCampaign);
    const loads: Observable<unknown>[] = [];
    const file = snap.file;
    if (file) {
      const extra = this.extraColumns();
      const reopen =
        file.storageId === null
          ? throwError(() => new Error('not kept'))
          : this.storageApi.use(file.storageId).pipe(
              tap(({ preview }) => {
                if (!preview) throw new Error('no preview');
                this.adoptImport(preview);
                this.mapping.set(file.mapping);
                this.extraColumns.set(extra);
                // The audit (who is valid) is not kept and only the Who step runs it,
                // so a later step would show an empty audience until it is opened.
                this.step.set(1);
              }),
            );
      loads.push(
        reopen.pipe(
          catchError(() => {
            this.step.set(1);
            return throwError(
              () => new Error(`"${file.filename}" could not be reopened - upload it again.`),
            );
          }),
        ),
      );
    }
    const from = this.audienceFrom();
    if (from !== null && !file) {
      loads.push(
        this.campaignsApi.get(from).pipe(
          tap(({ campaign }) => {
            if (Array.isArray(campaign.audience))
              this.savedAudience.set(campaign.audience as Contact[]);
          }),
          catchError(() => {
            this.step.set(1);
            return throwError(
              () =>
                new Error(
                  'The saved recipient list could not be loaded - choose who gets it again.',
                ),
            );
          }),
        ),
      );
    }
    return loads.length ? forkJoin(loads).pipe(map(() => undefined)) : of(undefined);
  }

  /** Start fresh: drop the earlier session's draft and autosave this one from now on. */
  discardSaved(): void {
    this.saved.set(null);
    this.armed.set(true);
    this.forget();
  }

  private snapshot(): DraftSnapshot {
    const signals: Record<string, unknown> = {};
    for (const [key, s] of Object.entries(this.kept)) signals[key] = s();
    const preview = this.preview();
    const attachment = this.attachment();
    const retarget = this.retargetCampaign();
    return {
      v: SNAPSHOT_VERSION,
      savedAt: Date.now(),
      signals,
      file: preview
        ? {
            storageId: preview.storageId ?? null,
            importId: preview.importId,
            filename: preview.filename,
            mapping: this.mapping(),
          }
        : null,
      attachment: attachment
        ? {
            mediaId: attachment.mediaId,
            filename: attachment.filename,
            mimetype: attachment.mimetype,
            size: attachment.size,
            storageId: attachment.storageId,
          }
        : null,
      // The detail payload carries the whole recipient list; only the summary is needed.
      retargetCampaign: retarget ? { ...retarget, audience: null } : null,
    };
  }

  // Storage can be full, disabled or blocked (private mode); the draft then lives in memory only.
  private read(): DraftSnapshot | null {
    try {
      const raw = localStorage.getItem(this.storageKey);
      const snap = raw ? (JSON.parse(raw) as DraftSnapshot) : null;
      return snap?.v === SNAPSHOT_VERSION && snap.signals ? snap : null;
    } catch {
      return null;
    }
  }

  private write(snapshot: DraftSnapshot): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(snapshot));
    } catch {
      // Quota or privacy mode: keep going without autosave.
    }
  }

  /** Remove the autosave, but never an earlier session's that is still waiting for an answer. */
  private forget(): void {
    if (!this.armed() || !this.storageKey) return;
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
  }
}
