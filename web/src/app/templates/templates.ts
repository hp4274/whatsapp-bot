import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { validateInteractive } from '../campaign/interactive/interactive.model';
import { Auth } from '../core/auth';
import { Store } from '../core/store';
import { Tilt } from '../school/tilt';
import { ButtonsEditor } from './buttons-editor';
import { MetaMappingEditor } from './meta-mapping';
import { HeaderMedia, TemplatePreview } from './template-preview';
import {
  APPROVAL_STATUSES,
  ApiError,
  ReviewStatus,
  SpamScore,
  Starter,
  TEMPLATE_CATEGORIES,
  TEMPLATE_TYPES,
  Template,
  TemplateCategory,
  TemplateDraft,
  TemplateType,
  TemplateVersion,
  TemplatesApi,
  render,
  usedIn,
  validate,
} from './templates-api';

/** The drawer shows either the editor (id null = new) or one template's version history. */
type Panel =
  | { mode: 'edit'; id: number | null }
  | { mode: 'history'; template: Template }
  | { mode: 'library' };

/** Platform review pill per status; '' (never reviewed) shows nothing. */
const REVIEW_META: Record<Exclude<ReviewStatus, ''>, { label: string; tone: string; icon: string }> = {
  pending: { label: 'Pending review', tone: 'tone-warn', icon: 'hourglass' },
  approved: { label: 'Approved', tone: 'tone-ok', icon: 'circle-check' },
  rejected: { label: 'Rejected', tone: 'tone-bad', icon: 'circle-x' },
};

/** Label, icon and tone per template type, for cards and filters. */
const TYPE_META: Record<TemplateType, { label: string; icon: string; tone: string }> = {
  text: { label: 'Text', icon: 'notes', tone: 'tone-ok' },
  media: { label: 'Media', icon: 'photo', tone: 'tone-info' },
  provider_template: { label: 'Meta template', icon: 'discount-check', tone: 'tone-warn' },
  interactive: { label: 'Interactive', icon: 'hand-finger', tone: 'tone-info' },
  notification: { label: 'Notification', icon: 'bell', tone: 'tone-mute' },
};

/** Meta's own wording, shortened: picking the wrong one gets a template re-filed or rejected. */
const CATEGORY_META: Record<
  TemplateCategory,
  { label: string; icon: string; tone: string; guide: string }
> = {
  marketing: {
    label: 'Marketing',
    icon: 'speakerphone',
    tone: 'tone-warn',
    guide:
      'Offers, launches, newsletters, re-engagement - anything promotional. Billed at the marketing rate; recipients can mute or block.',
  },
  utility: {
    label: 'Utility',
    icon: 'receipt',
    tone: 'tone-info',
    guide:
      'Updates on something the customer already started: orders, bookings, payments, account alerts. Any promotion and Meta re-files it as marketing.',
  },
  authentication: {
    label: 'Authentication',
    icon: 'password',
    tone: 'tone-ok',
    guide:
      'One-time passcodes only. Keep it to the code and its expiry - no links, media or extra copy. Pair with a "Copy code" button.',
  },
};

/** A fresh draft; marketing is the default because it is what most new templates are. */
const blank = (): TemplateDraft => ({
  name: '',
  templateType: 'text',
  body: '',
  variables: [],
  providerTemplateName: '',
  approvalStatus: 'draft',
  category: 'marketing',
  sampleValues: {},
  headerMediaId: null,
  interactive: null,
});

const kindOf = (mime: string): HeaderMedia['kind'] =>
  mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'document';

/**
 * Reusable WhatsApp messages: a filterable card grid, an editor drawer with a
 * live phone preview, and a version history you can restore from.
 *
 * Writes are admin-only; a 403 flips the page into read-only rather than
 * leaving buttons that always fail. Header media is previewed through one
 * object URL at a time, revoked on replace and on destroy.
 */
@Component({
  selector: 'app-templates',
  imports: [FormsModule, Tilt, TemplatePreview, ButtonsEditor, MetaMappingEditor],
  templateUrl: './templates.html',
  styleUrl: './templates.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'close()' },
})
export class TemplatesView {
  private readonly api = inject(TemplatesApi);
  private readonly auth = inject(Auth);
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly types = TEMPLATE_TYPES;
  protected readonly statuses = APPROVAL_STATUSES;
  protected readonly categories = TEMPLATE_CATEGORIES;
  protected readonly meta = TYPE_META;
  protected readonly cat = CATEGORY_META;
  protected readonly review = REVIEW_META;

  protected readonly templates = signal<Template[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly readOnly = signal(!this.auth.atLeast('admin'));
  protected readonly query = signal('');
  protected readonly typeFilter = signal<TemplateType | ''>('');
  protected readonly categoryFilter = signal<TemplateCategory | ''>('');
  protected readonly confirmDelete = signal<number | null>(null);
  protected readonly busy = signal(false);

  // panel state
  protected readonly panel = signal<Panel | null>(null);
  protected readonly draft = signal<TemplateDraft>(blank());
  protected readonly panelError = signal('');
  protected readonly versions = signal<TemplateVersion[] | null>(null);
  protected readonly compat = signal<string[]>([]);

  // starter library
  protected readonly starters = signal<Starter[] | null>(null);
  protected readonly copying = signal<number | null>(null);

  /** Server spam score for the open draft; null until the first answer. */
  protected readonly spam = signal<(SpamScore & { limit: number }) | null>(null);
  /** Warn within 15 points of the limit; 100 means the check is off, so stay neutral. */
  protected readonly spamTone = computed(() => {
    const s = this.spam();
    if (!s || s.limit >= 100) return 'tone-mute';
    if (s.score > s.limit) return 'tone-bad';
    return s.score >= s.limit - 15 ? 'tone-warn' : 'tone-ok';
  });
  protected readonly spamWhy = computed(
    () => this.spam()?.reasons.map((r) => `${r.reason} (+${r.points})`).join(', ') ?? '',
  );

  // header media
  protected readonly media = signal<HeaderMedia | null>(null);
  protected readonly uploading = signal(false);
  protected readonly mediaError = signal('');
  protected readonly pasteId = signal('');
  /** The object URL currently held by `media`, so it can be revoked. */
  private objectUrl: string | null = null;

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const t = this.typeFilter();
    const c = this.categoryFilter();
    return this.templates().filter(
      (x) =>
        (!t || x.templateType === t) &&
        (!c || x.category === c) &&
        (!q || x.name.toLowerCase().includes(q) || x.body.toLowerCase().includes(q)),
    );
  });
  protected readonly presentTypes = computed(() =>
    TEMPLATE_TYPES.filter((t) => this.templates().some((x) => x.templateType === t)),
  );
  protected readonly categoryCounts = computed(() => {
    const counts = { marketing: 0, utility: 0, authentication: 0 } as Record<
      TemplateCategory,
      number
    >;
    for (const t of this.templates()) counts[t.category] = (counts[t.category] ?? 0) + 1;
    return counts;
  });
  protected readonly editing = computed(() => {
    const p = this.panel();
    return p?.mode === 'edit' && p.id != null
      ? (this.templates().find((t) => t.id === p.id) ?? null)
      : null;
  });
  protected readonly vars = computed(() => usedIn(this.draft().body));
  protected readonly problems = computed(() => validate(this.draft().body));
  protected readonly ixProblems = computed(() => validateInteractive(this.draft().interactive));
  protected readonly preview = computed(() => render(this.draft().body, this.draft().sampleValues));

  constructor() {
    this.load();
    this.store.watch(['templates'], () => this.load(true));
    this.destroyRef.onDestroy(() => this.setMedia(null));
    // Score the draft as it is typed, debounced so a keystroke is not a request.
    effect((onCleanup) => {
      if (this.panel()?.mode !== 'edit') return;
      const { body, interactive } = this.draft();
      const timer = setTimeout(
        () =>
          this.api.spamScore({ body, interactive }).subscribe({
            next: (s) => this.spam.set(s),
            error: () => this.spam.set(null),
          }),
        400,
      );
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected load(quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.error.set('');
    this.api.list().subscribe({
      next: ({ templates }) => {
        this.templates.set(templates);
        this.loading.set(false);
      },
      error: (e: Error) => {
        this.error.set(e.message);
        this.loading.set(false);
      },
    });
  }

  protected clearFilters(): void {
    this.query.set('');
    this.typeFilter.set('');
    this.categoryFilter.set('');
  }

  // ------------------------------------------------------------ editor --
  protected openNew(): void {
    this.draft.set(blank());
    this.resetMedia();
    this.panelError.set('');
    this.panel.set({ mode: 'edit', id: null });
  }

  protected openEdit(t: Template): void {
    this.draft.set({
      name: t.name,
      templateType: t.templateType,
      body: t.body,
      variables: t.variables,
      providerTemplateName: t.providerTemplateName,
      approvalStatus: t.approvalStatus,
      category: t.category ?? 'marketing',
      sampleValues: { ...(t.sampleValues ?? {}) },
      headerMediaId: t.headerMediaId ?? null,
      interactive: t.interactive ?? null,
      language: t.language ?? '',
      paramMapping: t.paramMapping ?? {},
    });
    this.resetMedia();
    if (t.headerMediaId) this.loadMedia(t.headerMediaId);
    this.panelError.set('');
    this.panel.set({ mode: 'edit', id: t.id });
  }

  protected patch(change: Partial<TemplateDraft>): void {
    this.draft.update((d) => ({ ...d, ...change }));
  }

  protected setSample(key: string, value: string): void {
    this.draft.update((d) => ({ ...d, sampleValues: { ...d.sampleValues, [key]: value } }));
  }

  protected insertVar(area: HTMLTextAreaElement): void {
    const at = area.selectionStart ?? area.value.length;
    const body = `${area.value.slice(0, at)}{name}${area.value.slice(area.selectionEnd ?? at)}`;
    this.patch({ body });
    queueMicrotask(() => {
      area.focus();
      area.setSelectionRange(at + 1, at + 5);
    });
  }

  /** Wrap the selection in a WhatsApp format marker (*, _, ~, ```). */
  protected wrap(area: HTMLTextAreaElement, mark: string): void {
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? start;
    const body = `${area.value.slice(0, start)}${mark}${area.value.slice(start, end)}${mark}${area.value.slice(end)}`;
    this.patch({ body });
    queueMicrotask(() => {
      area.focus();
      area.setSelectionRange(start + mark.length, end + mark.length);
    });
  }

  protected save(): void {
    const p = this.panel();
    if (p?.mode !== 'edit' || this.busy()) return;
    const d = this.draft();
    if (!d.name.trim()) {
      this.panelError.set('Give the template a name.');
      return;
    }
    const vars = this.vars();
    // Send the variables the body uses: the server validates the new body
    // against the declared list, and the old list would reject new placeholders.
    const body: TemplateDraft = {
      ...d,
      name: d.name.trim(),
      variables: vars,
      sampleValues: Object.fromEntries(
        Object.entries(d.sampleValues).filter(([k, v]) => vars.includes(k) && v.trim()),
      ),
    };
    this.busy.set(true);
    this.panelError.set('');
    const req = p.id == null ? this.api.create(body) : this.api.update(p.id, body);
    req.subscribe({
      next: ({ template }) => {
        this.templates.update((list) =>
          p.id == null
            ? [...list, template]
            : list.map((x) => (x.id === template.id ? template : x)),
        );
        this.busy.set(false);
        this.panel.set(null);
        this.setMedia(null);
      },
      error: (e: ApiError) => {
        this.busy.set(false);
        this.panelError.set(this.writeFailed(e));
      },
    });
  }

  // ----------------------------------------------------------- library --
  protected openLibrary(): void {
    this.panelError.set('');
    this.panel.set({ mode: 'library' });
    this.api.library().subscribe({
      next: ({ starters }) => this.starters.set(starters),
      error: (e: Error) => {
        this.starters.set([]);
        this.panelError.set(e.message);
      },
    });
  }

  /** Copy a starter under a free name, then open it in the editor to make it the tenant's own. */
  protected copyStarter(s: Starter): void {
    if (this.copying() != null) return;
    const taken = new Set(this.templates().map((t) => t.name));
    let name = s.name;
    for (let n = 2; taken.has(name); n += 1) name = `${s.name} ${n}`;
    this.copying.set(s.id);
    this.panelError.set('');
    this.api.copyStarter(s.id, name).subscribe({
      next: ({ template }) => {
        this.copying.set(null);
        this.templates.update((list) => [...list, template]);
        this.openEdit(template);
      },
      error: (e: ApiError) => {
        this.copying.set(null);
        this.panelError.set(this.writeFailed(e));
      },
    });
  }

  protected useInCampaign(t: Template): void {
    this.router.navigate(['/campaign'], { queryParams: { template: t.id } });
  }

  // ------------------------------------------------------- header media --
  protected onFile(input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.uploading.set(true);
    this.mediaError.set('');
    this.api.upload(file).subscribe({
      next: (m) => {
        this.uploading.set(false);
        this.patch({ headerMediaId: m.mediaId });
        this.setMedia({
          kind: kindOf(m.mimetype || file.type),
          name: m.filename,
          url: URL.createObjectURL(file),
        });
      },
      error: (e: ApiError) => {
        this.uploading.set(false);
        this.mediaError.set(e.message);
      },
    });
  }

  protected attachPasted(): void {
    const id = this.pasteId().trim();
    if (!id) return;
    this.patch({ headerMediaId: id });
    this.pasteId.set('');
    this.loadMedia(id);
  }

  protected removeMedia(): void {
    this.patch({ headerMediaId: null });
    this.resetMedia();
  }

  private loadMedia(id: string) {
    this.mediaError.set('');
    this.setMedia({ kind: 'image', name: id, url: null });
    this.api.mediaBlob(id).subscribe({
      next: (blob) => {
        if (this.draft().headerMediaId !== id) return;
        this.setMedia({ kind: kindOf(blob.type), name: id, url: URL.createObjectURL(blob) });
      },
      error: () => {
        if (this.draft().headerMediaId !== id) return;
        this.mediaError.set(`Media ${id} was not found. Upload the file again.`);
      },
    });
  }

  private resetMedia() {
    this.setMedia(null);
    this.mediaError.set('');
    this.pasteId.set('');
  }

  /** One object URL at a time, revoked when replaced. */
  private setMedia(m: HeaderMedia | null) {
    if (this.objectUrl && this.objectUrl !== m?.url) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = m?.url ?? null;
    this.media.set(m);
  }

  // ----------------------------------------------------------- history --
  protected openHistory(t: Template): void {
    this.versions.set(null);
    this.compat.set([]);
    this.panelError.set('');
    this.panel.set({ mode: 'history', template: t });
    this.api.get(t.id).subscribe({
      next: ({ template, versions, compatibility }) => {
        this.panel.set({ mode: 'history', template });
        this.versions.set(versions);
        this.compat.set(compatibility);
      },
      error: (e: Error) => {
        this.versions.set([]);
        this.panelError.set(e.message);
      },
    });
  }

  protected revert(t: Template, version: number): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.panelError.set('');
    this.api.revert(t.id, version).subscribe({
      next: ({ template }) => {
        this.busy.set(false);
        this.templates.update((list) => list.map((x) => (x.id === template.id ? template : x)));
        this.openHistory(template);
      },
      error: (e: ApiError) => {
        this.busy.set(false);
        this.panelError.set(this.writeFailed(e));
      },
    });
  }

  // ------------------------------------------------------------ delete --
  protected remove(t: Template): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.api.remove(t.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirmDelete.set(null);
        this.templates.update((list) => list.filter((x) => x.id !== t.id));
      },
      error: (e: ApiError) => {
        this.busy.set(false);
        this.confirmDelete.set(null);
        this.error.set(this.writeFailed(e));
      },
    });
  }

  protected close(): void {
    if (!this.busy() && this.panel()) {
      this.panel.set(null);
      this.spam.set(null);
      this.setMedia(null);
    }
    this.confirmDelete.set(null);
  }

  protected ago(iso: string | null): string {
    if (!iso) return 'never';
    const s =
      (Date.now() - Date.parse(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)) / 1000;
    if (!(s >= 0)) return new Date(iso).toLocaleDateString();
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  /** A 403 from a non-admin means "you can look, not touch"; anything else is the server's own words. */
  private writeFailed(e: ApiError): string {
    if (e.status === 403 && !this.auth.atLeast('admin')) {
      this.readOnly.set(true);
      return 'Only admins can change templates. You can still browse and copy them.';
    }
    return e.message;
  }
}
