import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ContactsApi, ImportPreview, ImportResult } from '../core/api';
import { splitTags } from './contact-util';

type Step = 'upload' | 'map' | 'tags' | 'done';
/** `consent`: a column whose answer (anything but a no) opts the row in, its text kept as proof. */
type Kind = 'phone' | 'name' | 'email' | 'tags' | 'consent' | 'custom' | 'ignore';

/**
 * What the list check says per problem, worst first. Numbers are only flagged, never looked up on
 * WhatsApp: checking a whole list there is a spam signal of its own.
 */
const LIST_CHECKS: readonly {
  readonly kind: 'invalid' | 'duplicates' | 'landline' | 'foreign';
  readonly text: string;
  /** The same line for exactly one number. */
  readonly one: string;
}[] = [
  { kind: 'invalid', text: 'are not phone numbers and will be skipped', one: 'is not a phone number and will be skipped' },
  { kind: 'duplicates', text: 'appear more than once; each person is imported once', one: 'appears more than once; it is imported once' },
  // The server only runs this check on +91 numbers, so the wording names no country.
  { kind: 'landline', text: "don't look like mobile numbers (landlines or typos)", one: "doesn't look like a mobile number (landline or typo)" },
  { kind: 'foreign', text: 'are outside your default country', one: 'is outside your default country' },
];
interface Column {
  kind: Kind;
  key: string;
}

/** Column headings in the preview table, in the words the dropdown uses. */
const KIND_LABEL: Record<Exclude<Kind, 'custom' | 'ignore'>, string> = {
  phone: 'Phone number',
  name: 'Name',
  email: 'Email',
  tags: 'Tags',
  consent: 'Said yes to messages',
};

/** The most skipped rows listed after an import; the rest are counted, not shown. */
const PROBLEMS_SHOWN = 50;

/**
 * The server's phone errors ("not a valid E.164 number: 12 -> 9112") in plain words. Anything
 * it does not recognise passes through unchanged.
 */
export function plainReason(text: string): string {
  return text
    .replace(/not a valid E\.164 number: (.*?) -> \S*$/, '"$1" is not a valid phone number')
    .replace(/not a number: (.*)$/, '"$1" is not a valid phone number')
    .replace(/empty phone number$/, 'no phone number')
    .replace(/missing phone number$/, 'no phone number');
}

/** The stepper's order; `stepIndex` compares against it to tick finished steps. */
const STEPS: readonly { id: Step; label: string }[] = [
  { id: 'upload', label: 'Upload' },
  { id: 'map', label: 'Map columns' },
  { id: 'tags', label: 'Tag' },
  { id: 'done', label: 'Result' },
];

/**
 * Upload a sheet, say which column is which, tag the batch, see what happened.
 *
 * The file is sent twice — once for a preview the user maps, once for the real
 * import — so nothing is written until the mapping is valid and confirmed. It
 * traps Tab inside itself because it is a true modal over the page.
 */
@Component({
  selector: 'app-import-wizard',
  imports: [FormsModule],
  templateUrl: './import-wizard.html',
  styleUrl: './import-wizard.scss',
  host: { '(document:keydown)': 'onKey($event)' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImportWizard {
  private readonly api = inject(ContactsApi);

  readonly knownTags = input<{ tag: string; count: number }[]>([]);
  readonly closed = output<void>();
  readonly imported = output<void>();
  /** "From WhatsApp groups" under More options: the page swaps this wizard for the groups dialog. */
  readonly fromGroups = output<void>();

  protected readonly steps = STEPS;
  protected readonly step = signal<Step>('upload');
  /** The file `preview` was read from: set together, so the import always sends the file that was mapped. */
  protected readonly file = signal<File | null>(null);
  /** The file being read for a preview, for the "Reading ..." line. */
  protected readonly reading = signal('');
  protected readonly preview = signal<ImportPreview | null>(null);
  protected readonly columns = signal<Column[]>([]);
  protected readonly tags = signal<string[]>([]);
  protected readonly tagText = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly dragging = signal(false);
  protected readonly result = signal<ImportResult | null>(null);

  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  /** Focus goes back here on close. */
  private readonly opener = document.activeElement as HTMLElement | null;

  protected readonly stepIndex = computed(() => STEPS.findIndex((s) => s.id === this.step()));

  protected readonly targets = computed(() =>
    this.columns().map((c) => (c.kind === 'custom' ? `custom:${c.key.trim()}` : c.kind)),
  );

  protected readonly mappingError = computed(() => {
    const cols = this.columns();
    const count = (k: Kind) => cols.filter((c) => c.kind === k).length;
    if (count('phone') !== 1)
      return count('phone')
        ? 'Only one column can be the phone number.'
        : 'Choose which column holds the phone number.';
    if (count('name') > 1) return 'Only one column can be the name.';
    if (count('email') > 1) return 'Only one column can be the email.';
    if (cols.some((c) => c.kind === 'custom' && !c.key.trim()))
      return 'Give every extra detail a name.';
    const keys = cols.filter((c) => c.kind === 'custom').map((c) => c.key.trim());
    if (new Set(keys).size !== keys.length) return 'Two columns are saved as the same extra detail.';
    return '';
  });

  /** The sample table, showing only the columns that will be imported. */
  protected readonly sample = computed(() => {
    const p = this.preview();
    if (!p) return { heads: [] as string[], rows: [] as string[][] };
    const keep = this.columns()
      .map((c, i) => (c.kind === 'ignore' ? -1 : i))
      .filter((i) => i >= 0);
    return {
      heads: keep.map((i) => this.targetLabel(this.columns()[i])),
      rows: p.rows.slice(0, 5).map((row) => keep.map((i) => row[i] ?? '')),
    };
  });

  /** The list check for whichever column is mapped to the phone: one line per problem found. */
  protected readonly listCheck = computed(() => {
    const at = this.columns().findIndex((c) => c.kind === 'phone');
    const p = this.preview();
    if (at < 0 || !p?.quality) return null;
    const q = p.quality[at];
    // The server skips the check when fewer than half the first rows are valid numbers, which
    // is exactly the list that most needs a warning.
    const mostlyBad = !q && p.rows.some((r) => String(r[at] ?? '').trim());
    if (!q) return mostlyBad ? { checked: 0, lines: [], mostlyBad } : null;
    const lines = LIST_CHECKS.filter((c) => q[c.kind] > 0).map((c) => ({
      ...c,
      text: q[c.kind] === 1 ? c.one : c.text,
      n: q[c.kind],
      examples: q.examples[c.kind].join(', '),
    }));
    return { checked: q.checked, lines, mostlyBad };
  });

  protected readonly invalid = computed(() => {
    const r = this.result();
    return r ? r.errors.length + (r.saved?.failed.length ?? 0) : 0;
  });

  protected readonly problems = computed(() => {
    const r = this.result();
    if (!r) return [];
    return [...r.errors, ...(r.saved?.failed ?? []).map((f) => `Row ${f.row}: ${f.error}`)]
      .slice(0, PROBLEMS_SHOWN)
      .map(plainReason);
  });
  protected readonly problemsShown = PROBLEMS_SHOWN;

  /** Bumped per preview request, so only the last file picked or dropped is used. */
  private uploadSeq = 0;

  protected readonly suggestions = computed(() =>
    this.knownTags()
      .map((t) => t.tag)
      .filter((t) => !this.tags().includes(t))
      .slice(0, 8),
  );

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
    const seq = ++this.uploadSeq;
    this.reading.set(file.name);
    this.error.set('');
    this.busy.set(true);
    this.api.importPreview(file).subscribe({
      next: (preview) => {
        if (seq !== this.uploadSeq) return;
        this.busy.set(false);
        if (!preview.rowCount) {
          this.error.set('That file has a header row but no contacts under it.');
          return;
        }
        this.file.set(file);
        this.preview.set(preview);
        this.columns.set(preview.mapping.map(toColumn));
        this.go('map');
      },
      error: (err: Error) => {
        if (seq !== this.uploadSeq) return;
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }

  // ------------------------------------------------------------------- map --
  protected setKind(index: number, kind: Kind) {
    const header = this.preview()?.headers[index] ?? '';
    this.columns.set(
      this.columns().map((c, i) => {
        if (i === index) return { kind, key: kind === 'custom' ? c.key || slug(header) : c.key };
        // Phone, name, email and consent are one column each: picking one frees the other.
        if (c.kind === kind && ['phone', 'name', 'email', 'consent'].includes(kind))
          return { kind: 'custom', key: c.key || slug(this.preview()?.headers[i] ?? '') };
        return c;
      }),
    );
  }

  protected setKey(index: number, key: string) {
    this.columns.set(this.columns().map((c, i) => (i === index ? { ...c, key } : c)));
  }

  protected samples(index: number) {
    return (this.preview()?.rows ?? [])
      .map((r) => r[index])
      .filter(Boolean)
      .slice(0, 3);
  }

  protected targetLabel(c: Column) {
    if (c.kind === 'custom') return c.key || 'Extra detail';
    return c.kind === 'ignore' ? '' : KIND_LABEL[c.kind];
  }

  // ------------------------------------------------------------------ tags --
  protected addTag(event?: Event) {
    event?.preventDefault();
    const next = splitTags(this.tagText()).filter((t) => !this.tags().includes(t));
    this.tags.set([...this.tags(), ...next]);
    this.tagText.set('');
  }

  protected toggleSuggestion(tag: string) {
    this.tags.set(
      this.tags().includes(tag) ? this.tags().filter((t) => t !== tag) : [...this.tags(), tag],
    );
  }

  protected removeTag(tag: string) {
    this.tags.set(this.tags().filter((t) => t !== tag));
  }

  // ---------------------------------------------------------------- commit --
  protected commit() {
    const file = this.file();
    if (!file || this.busy() || this.mappingError()) return;
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
    return [
      ...root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
      ),
    ].filter((el) => el.offsetParent !== null);
  }

  private focusFirst() {
    const root = this.panel()?.nativeElement;
    const target = root?.querySelector<HTMLElement>('[data-autofocus]') ?? this.focusables()[0];
    target?.focus({ preventScroll: true });
  }
}

function toColumn(target: string): Column {
  if (target.startsWith('custom:')) return { kind: 'custom', key: target.slice(7) };
  return {
    kind: (['phone', 'name', 'email', 'tags', 'consent', 'ignore'].includes(target)
      ? target
      : 'ignore') as Kind,
    key: '',
  };
}

const slug = (header: string) =>
  header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
