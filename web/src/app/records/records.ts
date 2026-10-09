import { Component, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Store } from '../core/store';

import { BusinessObject, FieldKind, FieldValue, ObjectEvent, ObjectInput, ObjectTypeSpec, RecordsApi } from './records-api';

interface FieldDef { name: string; kind: FieldKind; label: string; required: boolean }
type DraftValue = string | number | boolean | null;

const TYPE_ICON: Record<string, string> = {
  appointment: 'event_available', order: 'shopping_bag', lead: 'person_search',
  subscription: 'autorenew', event: 'celebration', payment: 'payments',
};
const FETCH_LIMIT = 500;

/** "scheduledAt" -> "Scheduled at", "no_show" -> "No show". */
export function humanize(key: string): string {
  const s = key.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function plural(label: string): string {
  if (/[^aeiou]y$/i.test(label)) return label.slice(0, -1) + 'ies';
  if (/(s|x|ch|sh)$/i.test(label)) return label + 'es';
  return label + 's';
}

/** ISO -> value for <input type="datetime-local"> in the viewer's zone. */
function toLocalInput(iso: unknown): string {
  if (typeof iso !== 'string' || !iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

@Component({
  selector: 'app-records',
  imports: [FormsModule],
  templateUrl: './records.html',
  styleUrl: './records.scss',
  host: { '(document:keydown.escape)': 'closeDrawer()' },
})
export class RecordsView {
  private readonly api = inject(RecordsApi);
  private readonly store = inject(Store);

  /** Bound from the `records/:type` route param. */
  readonly type = input<string>('');

  protected readonly humanize = humanize;
  private readonly specs = signal<Record<string, ObjectTypeSpec> | null>(null);
  protected readonly objects = signal<BusinessObject[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly statusFilter = signal('');
  protected readonly query = signal('');

  // drawer
  protected readonly drawerOpen = signal(false);
  protected readonly selected = signal<BusinessObject | null>(null);
  protected readonly draft = signal<Record<string, DraftValue>>({});
  protected readonly draftRef = signal('');
  protected readonly draftStatus = signal('');
  protected readonly fieldErrors = signal<Record<string, string>>({});
  protected readonly formError = signal('');
  protected readonly saving = signal(false);
  protected readonly confirmDelete = signal(false);
  protected readonly deleting = signal(false);
  protected readonly events = signal<ObjectEvent[]>([]);
  protected readonly eventsLoading = signal(false);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  private loadToken = 0;
  private eventsToken = 0;
  private lastFocus: HTMLElement | null = null;

  protected readonly typeKey = computed(() => this.type().toLowerCase());
  protected readonly spec = computed(() => this.specs()?.[this.typeKey()] ?? null);
  protected readonly label = computed(() => this.spec()?.label ?? humanize(this.typeKey() || 'record'));
  protected readonly pluralLabel = computed(() => plural(this.label()));
  protected readonly icon = computed(() => TYPE_ICON[this.typeKey()] ?? 'folder_open');

  protected readonly fields = computed<FieldDef[]>(() => {
    const s = this.spec();
    if (!s) return [];
    return Object.entries(s.fields).map(([name, kind]) => ({
      name, kind, label: humanize(name), required: s.required.includes(name),
    }));
  });

  /** First string, first datetime, first number; topped up with strings to three, in registry order. */
  protected readonly keyFields = computed<FieldDef[]>(() => {
    const all = this.fields().filter((f) => f.name !== 'notes' && f.kind !== 'boolean');
    const pick = new Set<FieldDef>();
    for (const kind of ['string', 'datetime', 'number'] as FieldKind[]) {
      const f = all.find((x) => x.kind === kind);
      if (f) pick.add(f);
    }
    for (const f of all) {
      if (pick.size >= 3) break;
      if (f.kind === 'string') pick.add(f);
    }
    return all.filter((f) => pick.has(f));
  });

  protected readonly statusCounts = computed(() => {
    const counts: Record<string, number> = {};
    for (const o of this.objects()) counts[o.status] = (counts[o.status] ?? 0) + 1;
    return counts;
  });

  protected readonly visible = computed(() => {
    const status = this.statusFilter();
    const q = this.query().trim().toLowerCase();
    return this.objects().filter((o) => {
      if (status && o.status !== status) return false;
      if (!q) return true;
      const hay = [o.reference, ...Object.values(o.data ?? {}).map((v) => String(v))].join(' ').toLowerCase();
      return hay.includes(q);
    });
  });

  protected readonly filtering = computed(() => !!this.statusFilter() || !!this.query().trim());

  constructor() {
    effect(() => {
      const type = this.typeKey();
      untracked(() => this.load(type));
    });
    this.store.watch(['objects'], () => this.quietReload());
  }

  /** Live refresh: refetch the list only, keeping filters, drawer and form state. */
  private quietReload() {
    const type = this.typeKey();
    if (!type || this.loading()) return;
    const token = this.loadToken;
    this.api.list(type, { limit: FETCH_LIMIT }).subscribe({
      next: (r) => {
        if (token !== this.loadToken) return;
        this.objects.set(r.objects);
        this.total.set(r.total);
      },
      error: () => undefined,
    });
  }

  // ---------- loading ----------

  protected reload() {
    this.load(this.typeKey());
  }

  private load(type: string) {
    const token = ++this.loadToken;
    this.closeDrawer();
    this.statusFilter.set('');
    this.query.set('');
    this.objects.set([]);
    this.total.set(0);
    this.error.set('');
    this.loading.set(true);
    if (!type) {
      this.loading.set(false);
      this.error.set('No record type selected.');
      return;
    }
    this.api.types().subscribe({
      next: (res) => {
        if (token !== this.loadToken) return;
        this.specs.set(res.types);
        if (!res.types[type]) {
          this.loading.set(false);
          this.error.set(`Unknown record type "${type}".`);
          return;
        }
        this.api.list(type, { limit: FETCH_LIMIT }).subscribe({
          next: (r) => {
            if (token !== this.loadToken) return;
            this.objects.set(r.objects);
            this.total.set(r.total);
            this.loading.set(false);
          },
          error: (e: Error) => this.fail(token, e),
        });
      },
      error: (e: Error) => this.fail(token, e),
    });
  }

  private fail(token: number, e: Error) {
    if (token !== this.loadToken) return;
    this.loading.set(false);
    this.error.set(e.message);
  }

  // ---------- list helpers ----------

  protected isClosed(status: string): boolean {
    return this.spec()?.closed.includes(status) ?? false;
  }

  protected display(o: BusinessObject, f: FieldDef): string {
    const v = o.data?.[f.name];
    if (isBlank(v)) return '—';
    if (f.kind === 'datetime') return this.formatDate(String(v));
    if (f.kind === 'number') return typeof v === 'number' ? v.toLocaleString() : String(v);
    return String(v);
  }

  protected formatDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }

  protected relative(iso: string): string {
    const d = new Date(iso).getTime();
    if (Number.isNaN(d)) return '';
    const secs = Math.round((d - Date.now()) / 1000);
    const abs = Math.abs(secs);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (abs < 60) return rtf.format(secs, 'second');
    if (abs < 3600) return rtf.format(Math.round(secs / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(secs / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(secs / 86400), 'day');
    return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  protected clearFilters() {
    this.statusFilter.set('');
    this.query.set('');
  }

  /** Pointer-driven tilt for the hero badge; CSS ignores it under reduced motion. */
  protected tilt(e: PointerEvent, el: HTMLElement) {
    if (e.pointerType === 'touch') return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--rx', `${(((e.clientY - r.top) / r.height - 0.5) * -10).toFixed(2)}deg`);
    el.style.setProperty('--ry', `${(((e.clientX - r.left) / r.width - 0.5) * 14).toFixed(2)}deg`);
  }

  protected untilt(el: HTMLElement) {
    el.style.removeProperty('--rx');
    el.style.removeProperty('--ry');
  }

  // ---------- drawer ----------

  protected openNew() {
    const s = this.spec();
    if (!s) return;
    this.resetDrawer();
    this.selected.set(null);
    const draft: Record<string, DraftValue> = {};
    for (const f of this.fields()) draft[f.name] = f.kind === 'boolean' ? false : f.kind === 'number' ? null : '';
    this.draft.set(draft);
    this.draftRef.set('');
    this.draftStatus.set(s.defaultStatus ?? s.statuses[0]);
    this.events.set([]);
    this.show();
  }

  protected openRecord(o: BusinessObject) {
    this.resetDrawer();
    this.fill(o);
    this.loadEvents(o);
    this.show();
  }

  private fill(o: BusinessObject) {
    this.selected.set(o);
    const draft: Record<string, DraftValue> = {};
    for (const f of this.fields()) {
      const v = o.data?.[f.name];
      if (f.kind === 'boolean') draft[f.name] = v === true;
      else if (f.kind === 'datetime') draft[f.name] = toLocalInput(v);
      else if (f.kind === 'number') draft[f.name] = typeof v === 'number' ? v : null;
      else draft[f.name] = isBlank(v) ? '' : String(v);
    }
    this.draft.set(draft);
    this.draftRef.set(o.reference);
    this.draftStatus.set(o.status);
  }

  private show() {
    this.lastFocus = document.activeElement as HTMLElement | null;
    this.drawerOpen.set(true);
    setTimeout(() => {
      const root = this.panel()?.nativeElement;
      (root?.querySelector<HTMLElement>('input:not([readonly]), select') ?? root)?.focus();
    });
  }

  private resetDrawer() {
    this.fieldErrors.set({});
    this.formError.set('');
    this.confirmDelete.set(false);
    this.saving.set(false);
    this.deleting.set(false);
    this.eventsToken++;
    this.eventsLoading.set(false);
  }

  protected closeDrawer() {
    if (!this.drawerOpen()) return;
    this.drawerOpen.set(false);
    this.resetDrawer();
    this.lastFocus?.focus?.();
    this.lastFocus = null;
  }

  protected setField(name: string, value: DraftValue) {
    this.draft.update((d) => ({ ...d, [name]: value }));
    if (this.fieldErrors()[name]) {
      this.fieldErrors.update((errs) => {
        const { [name]: _, ...rest } = errs;
        return rest;
      });
    }
  }

  private loadEvents(o: BusinessObject) {
    const token = ++this.eventsToken;
    this.eventsLoading.set(true);
    this.api.events(o.type, o.id).subscribe({
      next: (ev) => {
        if (token !== this.eventsToken) return;
        this.events.set([...ev].reverse());
        this.eventsLoading.set(false);
      },
      error: () => {
        if (token !== this.eventsToken) return;
        this.events.set([]);
        this.eventsLoading.set(false);
      },
    });
  }

  /** Draft -> wire values; also fills fieldErrors. Returns null when invalid. */
  private collect(): Record<string, FieldValue | null> | null {
    const out: Record<string, FieldValue | null> = {};
    const errs: Record<string, string> = {};
    const d = this.draft();
    for (const f of this.fields()) {
      const raw = d[f.name];
      if (f.kind === 'boolean') {
        out[f.name] = raw === true;
        continue;
      }
      if (isBlank(raw)) {
        if (f.required) errs[f.name] = `${f.label} is required`;
        out[f.name] = null;
        continue;
      }
      if (f.kind === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) errs[f.name] = `${f.label} must be a number`;
        else out[f.name] = n;
      } else if (f.kind === 'datetime') {
        const t = new Date(String(raw));
        if (Number.isNaN(t.getTime())) errs[f.name] = `${f.label} must be a valid date and time`;
        else out[f.name] = t.toISOString();
      } else {
        out[f.name] = String(raw).trim();
      }
    }
    this.fieldErrors.set(errs);
    return Object.keys(errs).length ? null : out;
  }

  protected save() {
    if (this.saving()) return;
    this.formError.set('');
    const values = this.collect();
    if (!values) {
      this.formError.set('Fix the highlighted fields.');
      return;
    }
    const type = this.typeKey();
    const current = this.selected();
    let req;
    if (!current) {
      const data: Record<string, FieldValue> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v === null || v === false) continue; // unset on create
        data[k] = v;
      }
      const body: ObjectInput = { status: this.draftStatus(), data };
      const ref = this.draftRef().trim();
      if (ref) body.reference = ref;
      req = this.api.create(type, body);
    } else {
      // Send only what changed; null removes a field.
      const data: Record<string, FieldValue | null> = {};
      for (const [k, v] of Object.entries(values)) {
        const before = current.data?.[k];
        const kind = this.spec()?.fields[k];
        const same = kind === 'boolean' ? (before === true) === v : (before ?? null) === v;
        if (!same) data[k] = v;
      }
      const patch: ObjectInput = {};
      if (Object.keys(data).length) patch.data = data;
      if (this.draftStatus() !== current.status) patch.status = this.draftStatus();
      if (!patch.data && !patch.status) {
        this.formError.set('Nothing changed.');
        return;
      }
      req = this.api.update(type, current.id, patch);
    }
    this.saving.set(true);
    req.subscribe({
      next: (saved) => {
        this.saving.set(false);
        if (saved.type !== this.typeKey()) return;
        if (current) {
          this.objects.update((list) => list.map((o) => (o.id === saved.id ? saved : o)));
        } else {
          this.objects.update((list) => [saved, ...list]);
          this.total.update((n) => n + 1);
        }
        this.fill(saved);
        this.loadEvents(saved);
      },
      error: (e: Error) => {
        this.saving.set(false);
        this.formError.set(e.message);
      },
    });
  }

  protected remove() {
    const current = this.selected();
    if (!current || this.deleting()) return;
    if (!this.confirmDelete()) {
      this.confirmDelete.set(true);
      return;
    }
    this.deleting.set(true);
    this.api.remove(current.type, current.id).subscribe({
      next: () => {
        this.objects.update((list) => list.filter((o) => o.id !== current.id));
        this.total.update((n) => Math.max(0, n - 1));
        this.closeDrawer();
      },
      error: (e: Error) => {
        this.deleting.set(false);
        this.confirmDelete.set(false);
        this.formError.set(e.message);
      },
    });
  }

  // ---------- timeline ----------

  protected eventIcon(e: ObjectEvent): string {
    if (e.change === 'created') return 'add_circle';
    if (e.change === 'due') return 'alarm';
    if (e.field === 'status') return 'swap_horiz';
    return 'edit';
  }

  protected eventTitle(e: ObjectEvent): string {
    if (e.change === 'created') return `Created as ${humanize(this.decode(e.to) || 'new')}`;
    if (e.change === 'due') return 'Became due';
    if (e.field === 'status') return 'Status changed';
    if (e.field) return `${humanize(e.field)} updated`;
    return humanize(e.change);
  }

  protected eventDetail(e: ObjectEvent): string {
    if (e.change === 'created' || !e.field) return '';
    const kind = this.spec()?.fields[e.field];
    const fmt = (v: string | null) => {
      const s = this.decode(v);
      if (!s) return 'empty';
      if (e.field === 'status') return humanize(s);
      if (kind === 'datetime') return this.formatDate(s);
      return s.length > 60 ? s.slice(0, 57) + '…' : s;
    };
    return `${fmt(e.from)} → ${fmt(e.to)}`;
  }

  /** Event values are stored encoded; unwrap JSON strings, keep anything else as-is. */
  private decode(v: string | null): string {
    if (v === null || v === undefined) return '';
    try {
      const parsed = JSON.parse(v);
      return parsed === null ? '' : typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed);
    } catch {
      return String(v);
    }
  }
}
