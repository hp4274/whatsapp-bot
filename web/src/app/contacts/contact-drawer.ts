import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Contact2, ContactsApi, TimelineEntry } from '../core/api';
import { Store } from '../core/store';
import { absoluteTime, displayPhone, hue, initials, relativeTime, splitTags } from './contact-util';

interface FieldRow {
  key: string;
  value: string;
}

/**
 * Everything about one person: profile, tags, fields, consent and history.
 *
 * Reloads on live store events so a reply or opt-out shows up while it is open,
 * but keeps an unsaved custom-field draft rather than clobbering it.
 */
@Component({
  selector: 'app-contact-drawer',
  imports: [FormsModule],
  templateUrl: './contact-drawer.html',
  styleUrl: './contact-drawer.scss',
  host: { '(document:keydown.escape)': 'onEscape()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContactDrawer {
  private readonly api = inject(ContactsApi);
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  readonly contactId = input.required<number>();
  readonly fieldKeys = input<string[]>([]);
  readonly knownTags = input<{ tag: string; count: number }[]>([]);
  readonly canWrite = input(true);

  readonly closed = output<void>();
  readonly changed = output<void>();
  readonly deleted = output<number>();

  protected readonly contact = signal<Contact2 | null>(null);
  protected readonly timeline = signal<TimelineEntry[] | null>(null);
  protected readonly error = signal('');
  protected readonly saving = signal(false);

  protected readonly editing = signal(false);
  protected readonly profile = signal({ name: '', email: '' });
  protected readonly tagText = signal('');
  protected readonly fields = signal<FieldRow[]>([]);
  protected readonly consentStep = signal<'' | 'out' | 'in'>('');
  protected readonly reason = signal('');
  protected readonly confirmDelete = signal(false);
  protected readonly copied = signal(false);

  protected readonly fieldsDirty = computed(() => {
    const c = this.contact();
    return c ? JSON.stringify(toObject(this.fields())) !== JSON.stringify(c.customFields) : false;
  });
  protected readonly fieldError = computed(() => {
    const keys = this.fields()
      .map((f) => f.key.trim())
      .filter(Boolean);
    return new Set(keys).size !== keys.length ? 'Each field name can only be used once.' : '';
  });

  protected readonly displayPhone = displayPhone;
  protected readonly initials = initials;
  protected readonly hue = hue;
  protected readonly ago = relativeTime;
  protected readonly absolute = absoluteTime;

  private readonly closeBtn = viewChild<ElementRef<HTMLButtonElement>>('closeBtn');
  /** Focus returns here when the drawer goes away, whoever closed it. */
  private readonly opener = document.activeElement as HTMLElement | null;

  constructor() {
    effect(() => {
      const id = this.contactId();
      untracked(() => {
        this.contact.set(null);
        this.timeline.set(null);
        this.editing.set(false);
        this.consentStep.set('');
        this.confirmDelete.set(false);
        this.load(id, true);
      });
    });
    effect(() => {
      if (this.contact())
        queueMicrotask(() => this.closeBtn()?.nativeElement.focus({ preventScroll: true }));
    });
    this.store.watch(['contacts', 'optouts', 'messages', 'inbox', 'conversations'], () =>
      this.load(this.contactId(), false),
    );
    this.destroyRef.onDestroy(() => this.opener?.focus?.());
  }

  private load(id: number, resetFields: boolean) {
    this.api.get(id).subscribe({
      next: ({ contact }) => {
        if (id !== this.contactId()) return;
        const keepDraft = !resetFields && this.fieldsDirty();
        this.contact.set(contact);
        if (!keepDraft) this.fields.set(toRows(contact.customFields));
        if (!this.editing()) this.profile.set({ name: contact.name, email: contact.email });
        this.error.set('');
      },
      error: (err: Error) => this.error.set(err.message),
    });
    this.api.timeline(id).subscribe({
      next: ({ timeline }) => {
        if (id === this.contactId()) this.timeline.set(timeline);
      },
      error: () => this.timeline.set([]),
    });
  }

  protected close() {
    this.closed.emit();
  }

  /** Escape backs out of an open confirmation first, then closes the drawer. */
  protected onEscape() {
    if (this.consentStep()) this.consentStep.set('');
    else if (this.confirmDelete()) this.confirmDelete.set(false);
    else if (this.editing()) this.editing.set(false);
    else this.close();
  }

  /** Every write lands here: show the fresh contact and tell the page. */
  private done(contact: Contact2) {
    this.saving.set(false);
    this.contact.set(contact);
    this.error.set('');
    this.changed.emit();
  }

  private fail(err: Error) {
    this.saving.set(false);
    this.error.set(err.message);
  }

  // ------------------------------------------------------------- profile --
  protected startEdit() {
    const c = this.contact();
    if (!c) return;
    this.profile.set({ name: c.name, email: c.email });
    this.editing.set(true);
  }

  protected saveProfile(event: Event) {
    event.preventDefault();
    const c = this.contact();
    if (!c) return;
    this.saving.set(true);
    const { name, email } = this.profile();
    this.api.update(c.id, { name: name.trim(), email: email.trim() }).subscribe({
      next: ({ contact }) => {
        this.editing.set(false);
        this.done(contact);
      },
      error: (e: Error) => this.fail(e),
    });
  }

  protected async copyPhone() {
    const c = this.contact();
    if (!c) return;
    try {
      await navigator.clipboard.writeText(displayPhone(c.phone));
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1600);
    } catch {
      // Clipboard can be blocked; the number is on screen to select by hand.
    }
  }

  // ---------------------------------------------------------------- tags --
  protected addTags(event?: Event) {
    event?.preventDefault();
    const c = this.contact();
    const tags = splitTags(this.tagText()).filter((t) => !c?.tags.includes(t));
    this.tagText.set('');
    if (!c || !tags.length) return;
    this.saving.set(true);
    this.api
      .tag(c.id, tags)
      .subscribe({ next: ({ contact }) => this.done(contact), error: (e: Error) => this.fail(e) });
  }

  protected removeTag(tag: string) {
    const c = this.contact();
    if (!c) return;
    this.saving.set(true);
    this.api
      .tag(c.id, [], [tag])
      .subscribe({ next: ({ contact }) => this.done(contact), error: (e: Error) => this.fail(e) });
  }

  protected tagKey(event: KeyboardEvent) {
    if (event.key === ',') {
      event.preventDefault();
      this.addTags();
    } else if (event.key === 'Backspace' && !this.tagText()) {
      const last = this.contact()?.tags.at(-1);
      if (last) this.removeTag(last);
    }
  }

  // -------------------------------------------------------------- fields --
  protected setField(index: number, patch: Partial<FieldRow>) {
    this.fields.set(this.fields().map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  protected addField() {
    this.fields.set([...this.fields(), { key: '', value: '' }]);
    queueMicrotask(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>('app-contact-drawer .field-key');
      inputs[inputs.length - 1]?.focus();
    });
  }

  protected removeField(index: number) {
    this.fields.set(this.fields().filter((_, i) => i !== index));
  }

  protected resetFields() {
    const c = this.contact();
    if (c) this.fields.set(toRows(c.customFields));
  }

  protected saveFields() {
    const c = this.contact();
    if (!c || this.fieldError()) return;
    this.saving.set(true);
    // PUT replaces, so a removed row really is removed.
    this.api.update(c.id, { customFields: toObject(this.fields()) }).subscribe({
      next: ({ contact }) => {
        this.fields.set(toRows(contact.customFields));
        this.done(contact);
      },
      error: (e: Error) => this.fail(e),
    });
  }

  // ------------------------------------------------------------- consent --
  protected toggleConsent() {
    const c = this.contact();
    if (!c) return;
    this.reason.set('');
    this.consentStep.set(c.optedOut ? 'in' : 'out');
  }

  protected confirmConsent(event?: Event) {
    event?.preventDefault();
    const c = this.contact();
    const step = this.consentStep();
    if (!c || !step) return;
    this.saving.set(true);
    this.api.consent(c.id, step === 'out', this.reason().trim()).subscribe({
      next: ({ contact }) => {
        this.consentStep.set('');
        this.done(contact);
      },
      error: (e: Error) => this.fail(e),
    });
  }

  // -------------------------------------------------------------- delete --
  protected remove() {
    const c = this.contact();
    if (!c) return;
    this.saving.set(true);
    this.api.remove(c.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.deleted.emit(c.id);
      },
      error: (e: Error) => this.fail(e),
    });
  }

  // ------------------------------------------------------------ timeline --
  protected icon(e: TimelineEntry) {
    if (e.kind === 'button_click') return 'hand-finger';
    if (e.direction === 'inbound') return e.kind === 'media' ? 'photo' : 'message-circle';
    if (e.status === 'FAILED') return 'alert-circle';
    if (e.status === 'READ') return 'checks';
    return e.kind === 'campaign' ? 'speakerphone' : 'send';
  }

  protected label(e: TimelineEntry) {
    if (e.kind === 'button_click') return 'Tapped a button';
    if (e.direction === 'inbound') return e.kind === 'media' ? 'Sent media' : 'Replied';
    return e.kind === 'campaign' ? 'Campaign message' : `${e.kind.replace(/_/g, ' ')} message`;
  }

  protected statusTone(status: string | null) {
    if (!status) return 'tone-mute';
    if (status === 'FAILED') return 'tone-bad';
    if (['SENT', 'DELIVERED', 'READ'].includes(status)) return 'tone-ok';
    return status === 'SANDBOX' ? 'tone-warn' : 'tone-info';
  }
}

function toRows(fields: Record<string, string>): FieldRow[] {
  return Object.entries(fields).map(([key, value]) => ({ key, value }));
}

function toObject(rows: FieldRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    const k = key.trim();
    if (k) out[k] = value;
  }
  return out;
}
