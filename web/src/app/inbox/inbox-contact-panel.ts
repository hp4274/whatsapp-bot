import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Observable } from 'rxjs';

import { Contact2, ContactsApi } from '../core/api';
import { User } from '../core/auth';
import { Conversation, ConversationNote, ConversationStatus, InboxApi } from './inbox-api';
import { hue, initials } from './inbox-list';

/** What brought the customer here, derived from the thread by the page. */
export interface ThreadContext {
  campaigns: { id: string; at: string }[];
  rules: { rule: string; body: string; at: string }[];
  buttons: { title: string; campaignId: string | null; at: string }[];
}

/** Segmented-control order: the lifecycle a conversation moves through. */
const STATUSES: readonly ConversationStatus[] = ['open', 'pending', 'closed'];

/**
 * Right-hand details: conversation state, contact record (tags + custom fields), campaign context, notes.
 *
 * Holds no source of truth: every write emits the server's answer upward so the
 * page, list and thread all agree, and only the field draft lives here.
 */
@Component({
  selector: 'app-inbox-contact-panel',
  templateUrl: './inbox-contact-panel.html',
  styleUrl: './inbox-contact-panel.scss',
  host: { role: 'complementary', 'aria-label': 'Contact details' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InboxContactPanel {
  private readonly api = inject(InboxApi);
  private readonly contacts = inject(ContactsApi);

  readonly conversation = input.required<Conversation>();
  readonly name = input('');
  readonly contact = input<Contact2 | null>(null);
  readonly contactLoading = input(false);
  readonly notes = input<ConversationNote[]>([]);
  readonly team = input<User[]>([]);
  readonly me = input<User | null>(null);
  readonly canEditContact = input(false);
  readonly context = input<ThreadContext>({ campaigns: [], rules: [], buttons: [] });
  readonly changed = output<Conversation>();
  readonly contactChanged = output<Contact2>();
  readonly notesChanged = output<void>();
  readonly close = output<void>();

  protected readonly statuses = STATUSES;
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal('');
  protected readonly noteDraft = signal('');
  protected readonly convTag = signal('');
  protected readonly contactTag = signal('');
  /** Editable copy of the contact's custom fields, as rows so keys can be renamed. */
  protected readonly fields = signal<{ key: string; value: string }[]>([]);
  protected readonly fieldsDirty = signal(false);

  protected readonly initials = computed(() =>
    initials({ name: this.name(), phone: this.conversation().phone }),
  );
  protected readonly hue = computed(() => hue(this.conversation().phone));
  protected readonly assignees = computed(() => {
    const me = this.me();
    const list = this.team().length ? this.team() : me ? [me] : [];
    const assigned = this.conversation().assignedTo;
    // Keep an unknown assignee selectable so the select never lies about the value.
    if (assigned != null && !list.some((u) => u.id === assigned)) {
      return [...list, { id: assigned, name: `User #${assigned}`, email: '' } as User];
    }
    return list;
  });
  protected readonly optIn = computed(() => {
    const c = this.contact();
    if (!c) return null;
    if (c.optedOut || c.optInStatus === 'opted_out')
      return { label: 'Opted out', tone: 'bad', icon: 'ban' };
    if (c.optInStatus === 'opted_in')
      return { label: 'Opted in', tone: 'good', icon: 'discount-check' };
    return { label: 'Opt-in unknown', tone: 'meh', icon: 'help-circle' };
  });

  constructor() {
    effect(() => {
      const c = this.contact();
      this.fields.set(
        Object.entries(c?.customFields ?? {}).map(([key, value]) => ({
          key,
          value: String(value),
        })),
      );
      this.fieldsDirty.set(false);
    });
  }

  // Conversation ----------------------------------------------------------
  protected setStatus(status: ConversationStatus) {
    const c = this.conversation();
    if (c.status !== status) this.run('status', this.api.setStatus(c.id, status));
  }

  protected assign(value: string) {
    this.run(
      'assign',
      this.api.assign(this.conversation().id, value === '' ? null : Number(value)),
    );
  }

  protected addConvTag() {
    const tag = this.convTag().trim();
    if (!tag) return;
    this.convTag.set('');
    this.run('ctag', this.api.tags(this.conversation().id, [tag]));
  }

  protected removeConvTag(tag: string) {
    this.run('ctag', this.api.tags(this.conversation().id, [], [tag]));
  }

  private run(key: string, call: Observable<{ conversation: Conversation }>) {
    this.busy.set(key);
    this.error.set('');
    call.subscribe({
      next: ({ conversation }) => {
        this.busy.set(null);
        this.changed.emit(conversation);
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.error.set(err.message);
      },
    });
  }

  // Contact ---------------------------------------------------------------
  protected addContactTag() {
    const c = this.contact();
    const tag = this.contactTag().trim();
    if (!c || !tag) return;
    this.contactTag.set('');
    this.runContact('tag', this.contacts.tag(c.id, [tag]));
  }

  protected removeContactTag(tag: string) {
    const c = this.contact();
    if (c) this.runContact('tag', this.contacts.tag(c.id, [], [tag]));
  }

  protected editField(i: number, part: 'key' | 'value', value: string) {
    this.fields.update((rows) => rows.map((r, j) => (j === i ? { ...r, [part]: value } : r)));
    this.fieldsDirty.set(true);
  }

  protected addField() {
    this.fields.update((rows) => [...rows, { key: '', value: '' }]);
    this.fieldsDirty.set(true);
  }

  protected removeField(i: number) {
    this.fields.update((rows) => rows.filter((_, j) => j !== i));
    this.fieldsDirty.set(true);
  }

  protected saveFields() {
    const c = this.contact();
    if (!c) return;
    const customFields = Object.fromEntries(
      this.fields()
        .filter((r) => r.key.trim())
        .map((r) => [r.key.trim(), r.value.trim()]),
    );
    // PUT replaces only the keys it is given; custom fields are replaced as a whole.
    this.runContact('fields', this.contacts.update(c.id, { customFields }));
  }

  private runContact(key: string, call: Observable<{ contact: Contact2 }>) {
    this.busy.set(key);
    this.error.set('');
    call.subscribe({
      next: ({ contact }) => {
        this.busy.set(null);
        this.contactChanged.emit(contact);
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.error.set(err.message);
      },
    });
  }

  // Notes -----------------------------------------------------------------
  protected addNote() {
    const body = this.noteDraft().trim();
    if (!body) return;
    this.busy.set('note');
    this.api.addNote(this.conversation().id, body).subscribe({
      next: () => {
        this.busy.set(null);
        this.noteDraft.set('');
        this.notesChanged.emit();
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.error.set(err.message);
      },
    });
  }

  protected noteKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.addNote();
    }
  }

  protected userName(id: number | null): string {
    if (id == null) return 'Unassigned';
    if (id === this.me()?.id) return 'You';
    const u = this.team().find((t) => t.id === id);
    return u ? u.name || u.email : `User #${id}`;
  }

  protected when(at: string): string {
    return new Date(at).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  }
}
