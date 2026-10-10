import { Component, ElementRef, computed, inject, input, output, signal, viewChild, afterNextRender } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ContactsApi, ImportPreview, ImportResult } from '../core/api';
import { splitTags } from './contact-util';

type Step = 'upload' | 'map' | 'tags' | 'done';
type Kind = 'phone' | 'name' | 'email' | 'tags' | 'custom' | 'ignore';
interface Column { kind: Kind; key: string }

const STEPS: { id: Step; label: string }[] = [
  { id: 'upload', label: 'Upload' },
  { id: 'map', label: 'Map columns' },
  { id: 'tags', label: 'Tag' },
  { id: 'done', label: 'Result' },
];

/** Upload a sheet, say which column is which, tag the batch, see what happened. */
@Component({
  selector: 'app-import-wizard',
  imports: [FormsModule],
  templateUrl: './import-wizard.html',
  styleUrl: './import-wizard.scss',
  host: { '(document:keydown)': 'onKey($event)' },
})
export class ImportWizard {
  private readonly api = inject(ContactsApi);

  readonly knownTags = input<{ tag: string; count: number }[]>([]);
  readonly closed = output<void>();
  readonly imported = output<void>();

  protected readonly steps = STEPS;
  protected readonly step = signal<Step>('upload');
  protected readonly file = signal<File | null>(null);
  protected readonly preview = signal<ImportPreview | null>(null);
  protected readonly columns = signal<Column[]>([]);
  protected readonly tags = signal<string[]>([]);
  protected readonly tagText = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly dragging = signal(false);
  protected readonly result = signal<ImportResult | null>(null);

  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly opener = document.activeElement as HTMLElement | null;

  protected readonly stepIndex = computed(() => STEPS.findIndex((s) => s.id === this.step()));

  protected readonly targets = computed(() =>
    this.columns().map((c) => (c.kind === 'custom' ? `custom:${c.key.trim()}` : c.kind)));

  protected readonly mappingError = computed(() => {
    const cols = this.columns();
    const count = (k: Kind) => cols.filter((c) => c.kind === k).length;
    if (count('phone') !== 1) return count('phone') ? 'Only one column can be the phone number.' : 'Choose which column holds the phone number.';
    if (count('name') > 1) return 'Only one column can be the name.';
    if (count('email') > 1) return 'Only one column can be the email.';
    if (cols.some((c) => c.kind === 'custom' && !c.key.trim())) return 'Give every custom field a name.';
    const keys = cols.filter((c) => c.kind === 'custom').map((c) => c.key.trim());
    if (new Set(keys).size !== keys.length) return 'Two columns map to the same custom field.';
    return '';
  });

  /** The sample table, showing only the columns that will be imported. */
  protected readonly sample = computed(() => {
    const p = this.preview();
    if (!p) return { heads: [] as string[], rows: [] as string[][] };
    const keep = this.columns().map((c, i) => (c.kind === 'ignore' ? -1 : i)).filter((i) => i >= 0);
    return {
      heads: keep.map((i) => this.targetLabel(this.columns()[i])),
      rows: p.rows.slice(0, 5).map((row) => keep.map((i) => row[i] ?? '')),
    };
  });

  protected readonly invalid = computed(() => {
    const r = this.result();
    return r ? r.errors.length + (r.saved?.failed.length ?? 0) : 0;
  });

  protected readonly problems = computed(() => {
    const r = this.result();
    if (!r) return [];
    return [...r.errors, ...(r.saved?.failed ?? []).map((f) => `Row ${f.row}: ${f.error}`)].slice(0, 50);
  });

  protected readonly suggestions = computed(() =>
    this.knownTags().map((t) => t.tag).filter((t) => !this.tags().includes(t)).slice(0, 8));

  constructor() {
    afterNextRender(() => this.focusFirst());
  }

  // ---------------------------------------------------------------- upload --
  protected pick(event: Event) {
    const inputEl = event.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (file) this.upload(file);
  }

  protected drop(event: DragEvent) {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) this.upload(file);
  }

  private upload(file: File) {
    if (!/\.(csv|xlsx|xls|xlsm|txt)$/i.test(file.name)) {
      this.error.set('Choose a .csv or .xlsx file.');
      return;
    }
    this.file.set(file);
    this.error.set('');
    this.busy.set(true);
    this.api.importPreview(file).subscribe({
      next: (preview) => {
        this.busy.set(false);
        if (!preview.rowCount) {
          this.error.set('That file has a header row but no contacts under it.');
          return;
        }
        this.preview.set(preview);
        this.columns.set(preview.mapping.map(toColumn));
        this.go('map');
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }

  // ------------------------------------------------------------------- map --
  protected setKind(index: number, kind: Kind) {
    const header = this.preview()?.headers[index] ?? '';
    this.columns.set(this.columns().map((c, i) => {
      if (i === index) return { kind, key: kind === 'custom' ? (c.key || slug(header)) : c.key };
      // Phone, name and email are one column each: picking one frees the other.
      if (c.kind === kind && ['phone', 'name', 'email'].includes(kind)) return { kind: 'custom', key: c.key || slug(this.preview()?.headers[i] ?? '') };
      return c;
    }));
  }

  protected setKey(index: number, key: string) {
    this.columns.set(this.columns().map((c, i) => (i === index ? { ...c, key } : c)));
  }

  protected samples(index: number) {
    return (this.preview()?.rows ?? []).map((r) => r[index]).filter(Boolean).slice(0, 3);
  }

  protected targetLabel(c: Column) {
    if (c.kind === 'custom') return c.key || 'custom';
    return c.kind;
  }

  // ------------------------------------------------------------------ tags --
  protected addTag(event?: Event) {
    event?.preventDefault();
    const next = splitTags(this.tagText()).filter((t) => !this.tags().includes(t));
    this.tags.set([...this.tags(), ...next]);
    this.tagText.set('');
  }

  protected toggleSuggestion(tag: string) {
    this.tags.set(this.tags().includes(tag) ? this.tags().filter((t) => t !== tag) : [...this.tags(), tag]);
  }

  protected removeTag(tag: string) {
    this.tags.set(this.tags().filter((t) => t !== tag));
  }

  // ---------------------------------------------------------------- commit --
  protected commit() {
    const file = this.file();
    if (!file || this.mappingError()) return;
    if (this.tagText().trim()) this.addTag();
    this.busy.set(true);
    this.error.set('');
    this.api.importMapped(file, this.targets(), this.tags()).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.result.set(result);
        this.go('done');
        this.imported.emit();
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }

  protected restart() {
    this.file.set(null);
    this.preview.set(null);
    this.columns.set([]);
    this.result.set(null);
    this.tags.set([]);
    this.error.set('');
    this.go('upload');
  }

  protected go(step: Step) {
    this.step.set(step);
    queueMicrotask(() => this.focusFirst());
  }

  protected close() {
    if (this.busy()) return;
    this.closed.emit();
    this.opener?.focus?.();
  }

  // --------------------------------------------------------------- a11y --
  protected onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = this.focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private focusables(): HTMLElement[] {
    const root = this.panel()?.nativeElement;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')]
      .filter((el) => el.offsetParent !== null);
  }

  private focusFirst() {
    const root = this.panel()?.nativeElement;
    const target = root?.querySelector<HTMLElement>('[data-autofocus]') ?? this.focusables()[0];
    target?.focus({ preventScroll: true });
  }
}

function toColumn(target: string): Column {
  if (target.startsWith('custom:')) return { kind: 'custom', key: target.slice(7) };
  return { kind: (['phone', 'name', 'email', 'tags', 'ignore'].includes(target) ? target : 'ignore') as Kind, key: '' };
}

const slug = (header: string) => header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
