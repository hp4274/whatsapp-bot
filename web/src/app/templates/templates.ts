import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Auth } from '../core/auth';
import { Tilt } from '../school/tilt';
import {
  APPROVAL_STATUSES, ApiError, TEMPLATE_TYPES, Template, TemplateDraft, TemplateType, TemplateVersion,
  TemplatesApi, render, usedIn, validate,
} from './templates-api';

type Panel = { mode: 'edit'; id: number | null } | { mode: 'history'; template: Template };

const TYPE_META: Record<TemplateType, { label: string; icon: string; tone: string }> = {
  text: { label: 'Text', icon: 'notes', tone: 'tone-ok' },
  media: { label: 'Media', icon: 'image', tone: 'tone-info' },
  provider_template: { label: 'Meta template', icon: 'verified', tone: 'tone-warn' },
  interactive: { label: 'Interactive', icon: 'touch_app', tone: 'tone-info' },
  notification: { label: 'Notification', icon: 'notifications', tone: 'tone-mute' },
};

const blank = (): TemplateDraft => ({
  name: '', templateType: 'text', body: '', variables: [], providerTemplateName: '', approvalStatus: 'draft',
});

@Component({
  selector: 'app-templates',
  imports: [FormsModule, Tilt],
  templateUrl: './templates.html',
  styleUrl: './templates.scss',
  host: { '(document:keydown.escape)': 'close()' },
})
export class TemplatesView {
  private readonly api = inject(TemplatesApi);
  private readonly auth = inject(Auth);

  protected readonly types = TEMPLATE_TYPES;
  protected readonly statuses = APPROVAL_STATUSES;
  protected readonly meta = TYPE_META;

  protected readonly templates = signal<Template[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly readOnly = signal(!this.auth.atLeast('admin'));
  protected readonly query = signal('');
  protected readonly typeFilter = signal<TemplateType | ''>('');
  protected readonly confirmDelete = signal<number | null>(null);
  protected readonly busy = signal(false);

  // panel state
  protected readonly panel = signal<Panel | null>(null);
  protected readonly draft = signal<TemplateDraft>(blank());
  protected readonly sample = signal<Record<string, string>>({});
  protected readonly panelError = signal('');
  protected readonly versions = signal<TemplateVersion[] | null>(null);
  protected readonly compat = signal<string[]>([]);

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const t = this.typeFilter();
    return this.templates().filter((x) =>
      (!t || x.templateType === t) && (!q || x.name.toLowerCase().includes(q) || x.body.toLowerCase().includes(q)));
  });
  protected readonly presentTypes = computed(() => TEMPLATE_TYPES.filter((t) => this.templates().some((x) => x.templateType === t)));
  protected readonly vars = computed(() => usedIn(this.draft().body));
  protected readonly problems = computed(() => validate(this.draft().body));
  protected readonly preview = computed(() => render(this.draft().body, this.sample()));

  constructor() {
    this.load();
  }

  load() {
    this.loading.set(true);
    this.error.set('');
    this.api.list().subscribe({
      next: ({ templates }) => { this.templates.set(templates); this.loading.set(false); },
      error: (e: Error) => { this.error.set(e.message); this.loading.set(false); },
    });
  }

  // ------------------------------------------------------------ editor --
  openNew() {
    this.draft.set(blank());
    this.sample.set({});
    this.panelError.set('');
    this.panel.set({ mode: 'edit', id: null });
  }

  openEdit(t: Template) {
    this.draft.set({
      name: t.name, templateType: t.templateType, body: t.body, variables: t.variables,
      providerTemplateName: t.providerTemplateName, approvalStatus: t.approvalStatus,
    });
    this.sample.set({});
    this.panelError.set('');
    this.panel.set({ mode: 'edit', id: t.id });
  }

  patch(change: Partial<TemplateDraft>) {
    this.draft.update((d) => ({ ...d, ...change }));
  }

  setSample(key: string, value: string) {
    this.sample.update((s) => ({ ...s, [key]: value }));
  }

  insertVar(area: HTMLTextAreaElement) {
    const at = area.selectionStart ?? area.value.length;
    const body = `${area.value.slice(0, at)}{name}${area.value.slice(area.selectionEnd ?? at)}`;
    this.patch({ body });
    queueMicrotask(() => { area.focus(); area.setSelectionRange(at + 1, at + 5); });
  }

  save() {
    const p = this.panel();
    if (p?.mode !== 'edit' || this.busy()) return;
    const d = this.draft();
    if (!d.name.trim()) { this.panelError.set('Give the template a name.'); return; }
    // Send the variables the body uses: the server validates the new body
    // against the declared list, and the old list would reject new placeholders.
    const body: TemplateDraft = { ...d, name: d.name.trim(), variables: this.vars() };
    this.busy.set(true);
    this.panelError.set('');
    const req = p.id == null ? this.api.create(body) : this.api.update(p.id, body);
    req.subscribe({
      next: ({ template }) => {
        this.templates.update((list) => p.id == null ? [...list, template] : list.map((x) => x.id === template.id ? template : x));
        this.busy.set(false);
        this.panel.set(null);
      },
      error: (e: ApiError) => { this.busy.set(false); this.panelError.set(this.writeFailed(e)); },
    });
  }

  // ----------------------------------------------------------- history --
  openHistory(t: Template) {
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
      error: (e: Error) => { this.versions.set([]); this.panelError.set(e.message); },
    });
  }

  revert(t: Template, version: number) {
    if (this.busy()) return;
    this.busy.set(true);
    this.panelError.set('');
    this.api.revert(t.id, version).subscribe({
      next: ({ template }) => {
        this.busy.set(false);
        this.templates.update((list) => list.map((x) => x.id === template.id ? template : x));
        this.openHistory(template);
      },
      error: (e: ApiError) => { this.busy.set(false); this.panelError.set(this.writeFailed(e)); },
    });
  }

  // ------------------------------------------------------------ delete --
  remove(t: Template) {
    if (this.busy()) return;
    this.busy.set(true);
    this.api.remove(t.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirmDelete.set(null);
        this.templates.update((list) => list.filter((x) => x.id !== t.id));
      },
      error: (e: ApiError) => { this.busy.set(false); this.confirmDelete.set(null); this.error.set(this.writeFailed(e)); },
    });
  }

  close() {
    if (!this.busy()) this.panel.set(null);
    this.confirmDelete.set(null);
  }

  protected ago(iso: string | null): string {
    if (!iso) return 'never';
    const s = (Date.now() - Date.parse(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)) / 1000;
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
