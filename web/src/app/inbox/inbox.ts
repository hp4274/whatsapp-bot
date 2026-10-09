import {
  Component, ElementRef, Injector, OnDestroy, afterNextRender, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { TenancyApi } from '../core/api';
import { Auth, User } from '../core/auth';
import { Store } from '../core/store';
import {
  Conversation, ConversationNote, ConversationStatus, InboxApi, InboxStats, SenderSummary, ThreadItem,
} from './inbox-api';

type Filter = 'all' | 'unread' | ConversationStatus;
type Row = Conversation & { name: string; preview: string };
type Entry = { item: ThreadItem; who: 'in' | 'human' | 'bot'; day: string | null };

const POLL_MS = 5000;
const STATUSES: ConversationStatus[] = ['open', 'pending', 'closed'];

@Component({
  selector: 'app-inbox',
  imports: [FormsModule, RouterLink],
  templateUrl: './inbox.html',
  styleUrl: './inbox.scss',
})
export class InboxView implements OnDestroy {
  private readonly api = inject(InboxApi);
  private readonly core = inject(TenancyApi);
  private readonly auth = inject(Auth);
  protected readonly store = inject(Store);
  private readonly injector = inject(Injector);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  protected readonly statuses = STATUSES;
  protected readonly filters: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'unread', label: 'Unread' },
    { key: 'open', label: 'Open' }, { key: 'pending', label: 'Pending' }, { key: 'closed', label: 'Closed' },
  ];

  // List ------------------------------------------------------------------
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly filter = signal<Filter>('all');
  protected readonly search = signal('');
  private readonly items = signal<Conversation[]>([]);
  private readonly senders = signal<Map<string, SenderSummary>>(new Map());
  protected readonly stats = signal<InboxStats | null>(null);
  protected readonly now = signal(Date.now());

  protected readonly rows = computed<Row[]>(() => {
    const names = this.senders();
    const q = this.search().trim().toLowerCase();
    return this.items()
      .map((c) => ({ ...c, name: names.get(c.phone)?.senderName || '', preview: names.get(c.phone)?.lastBody || '' }))
      .filter((r) => !q || r.phone.includes(q) || r.name.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q));
  });
  protected readonly isFirstRun = computed(() => (this.stats()?.total ?? 0) === 0 && this.items().length === 0);

  // Selected conversation -------------------------------------------------
  protected readonly selectedId = signal<number | null>(null);
  protected readonly selected = computed(() => this.items().find((c) => c.id === this.selectedId()) ?? null);
  protected readonly selectedRow = computed(() => this.rows().find((r) => r.id === this.selectedId()) ?? null);
  protected readonly thread = signal<ThreadItem[]>([]);
  protected readonly threadLoading = signal(false);
  protected readonly threadError = signal('');
  protected readonly notes = signal<ConversationNote[]>([]);
  protected readonly notesOpen = signal(typeof matchMedia === 'function' && matchMedia('(min-width: 1280px)').matches);
  protected readonly noteDraft = signal('');
  protected readonly draft = signal('');
  protected readonly sending = signal(false);
  protected readonly actionError = signal('');
  protected readonly busy = signal<string | null>(null);
  protected readonly team = signal<User[]>([]);
  protected readonly me = this.auth.user;

  protected readonly entries = computed<Entry[]>(() => {
    let last = '';
    return this.thread().map((item) => {
      const day = dayLabel(item.at);
      const entry: Entry = {
        item,
        who: item.direction === 'inbound' ? 'in' : item.kind === 'transactional' ? 'human' : 'bot',
        day: day !== last ? day : null,
      };
      last = day;
      return entry;
    });
  });
  protected readonly draftRows = computed(() => Math.min(5, Math.max(1, this.draft().split('\n').length)));

  private timer: ReturnType<typeof setInterval> | null = null;
  private listSeq = 0;
  private threadSeq = 0;
  private lastRevision = -1;

  constructor() {
    this.refresh();
    if (this.auth.atLeast('admin')) {
      this.core.users().subscribe({ next: ({ users }) => this.team.set(users.filter((u) => !u.disabled)), error: () => undefined });
    }
    // SSE: a message, receipt or history change means the list and the open thread are stale.
    effect(() => {
      const rev = this.store.historyRevision();
      untracked(() => {
        if (this.lastRevision >= 0 && rev !== this.lastRevision) this.tick();
        this.lastRevision = rev;
      });
    });
    // Belt and braces: SSE can drop silently, so poll while the page is open.
    this.timer = setInterval(() => {
      this.now.set(Date.now());
      if (typeof document === 'undefined' || !document.hidden) this.tick();
    }, POLL_MS);
  }

  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private tick() {
    this.refresh(true);
    const id = this.selectedId();
    if (id != null) this.loadThread(id, true);
  }

  // Loading ---------------------------------------------------------------
  protected refresh(silent = false) {
    const seq = ++this.listSeq;
    if (!silent) this.loading.set(true);
    const f = this.filter();
    forkJoin({
      list: this.api.list({ status: STATUSES.includes(f as ConversationStatus) ? (f as ConversationStatus) : null, unread: f === 'unread', limit: 300 }),
      stats: this.api.stats().pipe(catchError(() => of({ stats: null }))),
      senders: this.api.senders().pipe(catchError(() => of({ conversations: [] as SenderSummary[] }))),
    }).subscribe({
      next: ({ list, stats, senders }) => {
        if (seq !== this.listSeq) return;
        this.items.set(list.conversations);
        if (stats.stats) this.stats.set(stats.stats);
        this.senders.set(new Map(senders.conversations.map((s) => [s.sender, s])));
        this.error.set('');
        this.loading.set(false);
      },
      error: (err: Error) => {
        if (seq !== this.listSeq) return;
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected setFilter(f: Filter) {
    if (this.filter() === f) return;
    this.filter.set(f);
    this.refresh();
  }

  protected open(row: Conversation) {
    if (this.selectedId() !== row.id) {
      this.selectedId.set(row.id);
      this.thread.set([]);
      this.notes.set([]);
      this.draft.set('');
      this.actionError.set('');
      this.loadThread(row.id, false);
      this.api.notes(row.id).subscribe({ next: ({ notes }) => this.selectedId() === row.id && this.notes.set(notes), error: () => undefined });
    }
    if (row.unreadCount > 0) {
      this.patch({ ...row, unreadCount: 0 });
      this.api.markRead(row.id).subscribe({ next: ({ conversation }) => this.patch(conversation), error: () => undefined });
    }
  }

  protected back() {
    this.selectedId.set(null);
    this.notesOpen.set(false);
  }

  protected loadThread(id: number, silent: boolean) {
    const seq = ++this.threadSeq;
    if (!silent) {
      this.threadLoading.set(true);
      this.threadError.set('');
    }
    const el = this.scroller()?.nativeElement;
    const pinned = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const before = this.thread().length;
    this.api.thread(id).subscribe({
      next: ({ conversation, thread }) => {
        if (seq !== this.threadSeq || this.selectedId() !== id) return;
        const grew = thread.length !== before || thread.at(-1)?.messageId !== this.thread().at(-1)?.messageId;
        this.thread.set(thread);
        this.patch(conversation);
        this.threadLoading.set(false);
        this.threadError.set('');
        // Follow new messages only when the agent was already at the bottom.
        if (!silent || (grew && pinned)) this.scrollToBottom(!silent);
        if (silent && conversation.unreadCount > 0 && !document.hidden) {
          this.api.markRead(id).subscribe({ next: (r) => this.patch(r.conversation), error: () => undefined });
        }
      },
      error: (err: Error) => {
        if (seq !== this.threadSeq) return;
        this.threadLoading.set(false);
        if (!silent) this.threadError.set(err.message);
      },
    });
  }

  private scrollToBottom(instant: boolean) {
    afterNextRender({
      read: () => {
        const el = this.scroller()?.nativeElement;
        const still = instant || matchMedia('(prefers-reduced-motion: reduce)').matches;
        el?.scrollTo({ top: el.scrollHeight, behavior: still ? 'auto' : 'smooth' });
      },
    }, { injector: this.injector });
  }

  private patch(conversation: Conversation) {
    this.items.update((list) => list.map((c) => (c.id === conversation.id ? conversation : c)));
  }

  // Actions ---------------------------------------------------------------
  protected onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    }
  }

  protected send() {
    const c = this.selected();
    const text = this.draft().trim();
    if (!c || !text || this.sending()) return;
    this.sending.set(true);
    this.actionError.set('');
    this.api.reply(c.id, text).subscribe({
      next: ({ conversation }) => {
        this.sending.set(false);
        this.draft.set('');
        this.patch(conversation);
        this.loadThread(c.id, true);
        this.scrollToBottom(false);
      },
      error: (err: Error) => {
        this.sending.set(false);
        this.actionError.set(err.message);
      },
    });
  }

  protected toggleBot() {
    const c = this.selected();
    if (!c) return;
    this.run('bot', c.botPaused ? this.api.handback(c.id) : this.api.takeover(c.id));
  }

  protected setStatus(status: ConversationStatus) {
    const c = this.selected();
    if (c && c.status !== status) this.run('status', this.api.setStatus(c.id, status), true);
  }

  protected assign(value: string) {
    const c = this.selected();
    if (c) this.run('assign', this.api.assign(c.id, value === '' ? null : Number(value)), true);
  }

  private run(key: string, call: ReturnType<InboxApi['assign']>, relist = false) {
    this.busy.set(key);
    this.actionError.set('');
    call.subscribe({
      next: ({ conversation }) => {
        this.busy.set(null);
        this.patch(conversation);
        if (relist) this.refresh(true);
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.actionError.set(err.message);
      },
    });
  }

  protected addNote() {
    const c = this.selected();
    const body = this.noteDraft().trim();
    if (!c || !body) return;
    this.busy.set('note');
    this.api.addNote(c.id, body).pipe(catchError((err: Error) => {
      this.actionError.set(err.message);
      return of(null);
    })).subscribe((res) => {
      this.busy.set(null);
      if (!res) return;
      this.noteDraft.set('');
      this.api.notes(c.id).subscribe({ next: ({ notes }) => this.notes.set(notes), error: () => undefined });
    });
  }

  // View helpers ----------------------------------------------------------
  protected assigneeOptions = computed(() => {
    const me = this.me();
    const list = this.team().length ? this.team() : me ? [me] : [];
    const assigned = this.selected()?.assignedTo;
    // Keep an unknown assignee selectable so the select never lies about the value.
    if (assigned != null && !list.some((u) => u.id === assigned)) {
      return [...list, { id: assigned, name: `User #${assigned}`, email: '' } as User];
    }
    return list;
  });

  protected userName(id: number | null): string {
    if (id == null) return 'Unassigned';
    if (id === this.me()?.id) return 'You';
    const u = this.team().find((t) => t.id === id);
    return u ? u.name || u.email : `User #${id}`;
  }

  protected initials(row: Row): string {
    const src = row.name.trim();
    if (!src) return row.phone.slice(-2);
    const parts = src.split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
  }

  protected hue(phone: string): number {
    let h = 0;
    for (const ch of phone) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  protected rel(at: string | null): string {
    if (!at) return '';
    const s = Math.max(0, Math.round((this.now() - Date.parse(at)) / 1000));
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    if (s < 604800) return `${Math.round(s / 86400)}d`;
    return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  protected waiting(seconds: number | null): string {
    if (seconds == null) return 'None';
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
    return `${Math.round(seconds / 86400)}d`;
  }

  protected clock(at: string): string {
    return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  protected noteTime(at: string): string {
    return new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }
}

function dayLabel(at: string): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
