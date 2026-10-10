import {
  Component, ElementRef, Injector, OnDestroy, afterNextRender, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { Contact2, TenancyApi } from '../core/api';
import { Auth, User } from '../core/auth';
import { Store } from '../core/store';
import { InboxComposer } from './inbox-composer';
import { InboxContactPanel, ThreadContext } from './inbox-contact-panel';
import { Conversation, ConversationFilter, ConversationNote, InboxApi, InboxStats, SenderSummary, ThreadItem } from './inbox-api';
import { InboxList, Row, Segment, SegmentCounts, StatusFilter, hue, initials } from './inbox-list';
import { InboxMedia } from './inbox-media';

type Entry = { item: ThreadItem; who: 'in' | 'human' | 'bot'; day: string | null };

const POLL_MS = 30_000;
const TICKS: Record<string, { icon: string; label: string; tone?: string }> = {
  QUEUED: { icon: 'schedule', label: 'Queued' }, PENDING: { icon: 'schedule', label: 'Pending' },
  SCHEDULED: { icon: 'schedule', label: 'Scheduled' }, SENDING: { icon: 'schedule', label: 'Sending' },
  SENT: { icon: 'done', label: 'Sent' }, SANDBOX: { icon: 'science', label: 'Sandbox (not delivered)' },
  DELIVERED: { icon: 'done_all', label: 'Delivered' }, READ: { icon: 'done_all', label: 'Read', tone: 'read' },
  FAILED: { icon: 'error', label: 'Failed', tone: 'fail' }, CANCELLED: { icon: 'block', label: 'Cancelled', tone: 'fail' },
};
const SHORTCUTS: [string[], string][] = [
  [['j'], 'Next conversation'], [['k'], 'Previous conversation'], [['r'], 'Reply'], [['/'], 'Quick replies'],
  [['e'], 'Close conversation'], [['i'], 'Toggle contact details'], [['Esc'], 'Leave field / close panel'], [['?'], 'This help'],
];

@Component({
  selector: 'app-inbox',
  imports: [RouterLink, InboxList, InboxComposer, InboxContactPanel, InboxMedia],
  templateUrl: './inbox.html',
  styleUrl: './inbox.scss',
  host: { '(document:keydown)': 'shortcut($event)' },
})
export class InboxView implements OnDestroy {
  private readonly api = inject(InboxApi);
  private readonly core = inject(TenancyApi);
  private readonly auth = inject(Auth);
  protected readonly store = inject(Store);
  private readonly injector = inject(Injector);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly composer = viewChild(InboxComposer);
  private readonly helpClose = viewChild<ElementRef<HTMLButtonElement>>('helpClose');

  protected readonly shortcuts = SHORTCUTS;
  protected readonly me = this.auth.user;
  protected readonly canEditContact = computed(() => this.auth.atLeast('admin'));

  // List ------------------------------------------------------------------
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly segment = signal<Segment>('all');
  protected readonly status = signal<StatusFilter>('all');
  protected readonly search = signal('');
  private readonly items = signal<Conversation[]>([]);
  private readonly senders = signal<Map<string, SenderSummary>>(new Map());
  protected readonly stats = signal<InboxStats | null>(null);
  protected readonly now = signal(Date.now());
  protected readonly team = signal<User[]>([]);

  protected readonly rows = computed<Row[]>(() => {
    const names = this.senders();
    const q = this.search().trim().toLowerCase();
    return this.items()
      .map((c) => ({ ...c, name: names.get(c.phone)?.senderName || '', preview: names.get(c.phone)?.lastBody || '' }))
      .filter((r) => !q || r.phone.includes(q) || r.name.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q));
  });
  protected readonly counts = computed<SegmentCounts>(() => {
    const s = this.stats();
    return s ? { unread: s.unread, mine: s.mine, unassigned: s.unassigned, paused: s.botPaused } : {};
  });
  protected readonly isFirstRun = computed(() => (this.stats()?.total ?? 0) === 0 && this.items().length === 0
    && this.segment() === 'all' && this.status() === 'all');

  // Selected conversation -------------------------------------------------
  protected readonly selectedId = signal<number | null>(null);
  protected readonly selected = computed(() => this.items().find((c) => c.id === this.selectedId()) ?? null);
  protected readonly selectedRow = computed(() => this.rows().find((r) => r.id === this.selectedId()) ?? null);
  protected readonly thread = signal<ThreadItem[]>([]);
  protected readonly threadLoading = signal(false);
  protected readonly threadError = signal('');
  protected readonly notes = signal<ConversationNote[]>([]);
  protected readonly panelOpen = signal(typeof matchMedia === 'function' && matchMedia('(min-width: 1280px)').matches);
  protected readonly contact = signal<Contact2 | null>(null);
  protected readonly contactLoading = signal(false);
  protected readonly actionError = signal('');
  protected readonly busy = signal<string | null>(null);
  protected readonly newBelow = signal(false);
  protected readonly announce = signal('');
  protected readonly dragging = signal(false);
  protected readonly helpOpen = signal(false);

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
  /** What brought this customer here: campaigns they got, and buttons/keywords that matched a rule. */
  protected readonly context = computed<ThreadContext>(() => {
    const campaigns = new Map<string, string>();
    const rules: ThreadContext['rules'] = [];
    const buttons: ThreadContext['buttons'] = [];
    for (const t of this.thread()) {
      if (t.button) buttons.push({ title: t.button.title || t.body, campaignId: t.button.campaignId, at: t.at });
      if (t.campaignId) campaigns.set(t.campaignId, t.at);
      if (t.repliedRule) rules.push({ rule: t.repliedRule, body: t.body.slice(0, 60), at: t.at });
    }
    return { campaigns: [...campaigns].map(([id, at]) => ({ id, at })).reverse().slice(0, 5), rules: rules.reverse().slice(0, 5), buttons: buttons.reverse().slice(0, 5) };
  });

  private timer: ReturnType<typeof setInterval> | null = null;
  private listSeq = 0;
  private threadSeq = 0;
  private lastRevision = -1;
  private contactFor: number | null = null;

  constructor() {
    if (this.auth.atLeast('admin')) {
      this.core.users().subscribe({ next: ({ users }) => this.team.set(users.filter((u) => !u.disabled)), error: () => undefined });
    }
    // Filter chips and status are server-side: refetch when either changes (and once on start).
    effect(() => {
      this.segment();
      this.status();
      untracked(() => this.refresh());
    });
    // SSE: a message, receipt or history change means the list and the open thread are stale.
    effect(() => {
      const rev = this.store.historyRevision();
      untracked(() => {
        if (this.lastRevision >= 0 && rev !== this.lastRevision) this.tick();
        this.lastRevision = rev;
      });
    });
    this.store.watch(['inbox', 'conversations'], () => this.tick(), 250);
    // Belt and braces: SSE can drop silently, so poll while the page is open.
    this.timer = setInterval(() => {
      this.now.set(Date.now());
      if (typeof document === 'undefined' || !document.hidden) this.tick();
    }, POLL_MS);
    // The contact record behind the open conversation (feeds the panel and quick-reply placeholders).
    effect(() => {
      const id = this.selected()?.contactId ?? null;
      untracked(() => this.loadContact(id));
    });
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
    forkJoin({
      list: this.api.list(this.filter()),
      stats: this.api.stats().pipe(catchError(() => of({ stats: null }))),
      senders: this.api.senders().pipe(catchError(() => of({ conversations: [] as SenderSummary[] }))),
    }).subscribe({
      next: ({ list, stats, senders }) => {
        if (seq !== this.listSeq) return;
        // Keep the open conversation even if it no longer matches the filter (e.g. just closed).
        const open = this.selected();
        const fresh = list.conversations;
        this.items.set(open && !fresh.some((c) => c.id === open.id) ? [...fresh, open] : fresh);
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

  private filter(): ConversationFilter {
    const seg = this.segment();
    const status = this.status();
    return {
      status: status === 'all' ? null : status,
      unread: seg === 'unread',
      botPaused: seg === 'paused',
      assignedTo: seg === 'mine' ? (this.me()?.id ?? null) : seg === 'unassigned' ? 'none' : null,
      limit: 300,
    };
  }

  protected open(row: Conversation) {
    if (this.selectedId() !== row.id) {
      this.selectedId.set(row.id);
      this.thread.set([]);
      this.notes.set([]);
      this.actionError.set('');
      this.newBelow.set(false);
      this.loadThread(row.id, false);
      this.loadNotes(row.id);
    }
    if (row.unreadCount > 0) {
      this.patch({ ...row, unreadCount: 0 });
      this.api.markRead(row.id).subscribe({ next: ({ conversation }) => this.patch(conversation), error: () => undefined });
    }
  }

  protected back() {
    this.selectedId.set(null);
    this.panelOpen.set(false);
  }

  protected loadNotes(id: number) {
    this.api.notes(id).subscribe({ next: ({ notes }) => this.selectedId() === id && this.notes.set(notes), error: () => undefined });
  }

  private loadContact(id: number | null) {
    if (id === this.contactFor) return;
    this.contactFor = id;
    this.contact.set(null);
    if (id == null) return;
    this.contactLoading.set(true);
    this.api.contact(id).subscribe({
      next: ({ contact }) => {
        if (this.contactFor === id) this.contact.set(contact);
        this.contactLoading.set(false);
      },
      error: () => this.contactLoading.set(false),
    });
  }

  protected loadThread(id: number, silent: boolean) {
    const seq = ++this.threadSeq;
    if (!silent) {
      this.threadLoading.set(true);
      this.threadError.set('');
    }
    const pinned = this.atBottom();
    const lastId = this.thread().at(-1)?.messageId;
    this.api.thread(id).subscribe({
      next: ({ conversation, thread }) => {
        if (seq !== this.threadSeq || this.selectedId() !== id) return;
        const fresh = silent && lastId !== undefined ? thread.slice(thread.findIndex((t) => t.messageId === lastId) + 1) : [];
        this.thread.set(thread);
        this.patch(conversation);
        this.threadLoading.set(false);
        this.threadError.set('');
        const incoming = fresh.filter((t) => t.direction === 'inbound');
        if (incoming.length) {
          const who = this.selectedRow()?.name || conversation.phone;
          this.announce.set(`New message from ${who}: ${incoming.at(-1)!.body || 'attachment'}`);
        }
        // Follow new messages only when the agent was already at the bottom.
        if (!silent || (fresh.length && pinned)) this.scrollToBottom(!silent);
        else if (fresh.length) this.newBelow.set(true);
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

  private atBottom(): boolean {
    const el = this.scroller()?.nativeElement;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  protected onScroll() {
    if (this.newBelow() && this.atBottom()) this.newBelow.set(false);
  }

  protected scrollToBottom(instant: boolean) {
    this.newBelow.set(false);
    afterNextRender({
      read: () => {
        const el = this.scroller()?.nativeElement;
        const still = instant || matchMedia('(prefers-reduced-motion: reduce)').matches;
        el?.scrollTo({ top: el.scrollHeight, behavior: still ? 'auto' : 'smooth' });
      },
    }, { injector: this.injector });
  }

  protected patch(conversation: Conversation) {
    this.items.update((list) => list.map((c) => (c.id === conversation.id ? conversation : c)));
  }

  protected onChanged(conversation: Conversation) {
    this.patch(conversation);
    this.refresh(true);
  }

  protected onSent(conversation: Conversation) {
    this.patch(conversation);
    this.loadThread(conversation.id, true);
    this.scrollToBottom(false);
  }

  // Actions ---------------------------------------------------------------
  protected toggleBot() {
    const c = this.selected();
    if (!c) return;
    this.busy.set('bot');
    this.actionError.set('');
    (c.botPaused ? this.api.handback(c.id) : this.api.takeover(c.id)).subscribe({
      next: ({ conversation }) => {
        this.busy.set(null);
        this.onChanged(conversation);
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.actionError.set(err.message);
      },
    });
  }

  private resolve() {
    const c = this.selected();
    if (!c || c.status === 'closed') return;
    this.api.setStatus(c.id, 'closed').subscribe({
      next: ({ conversation }) => {
        this.onChanged(conversation);
        this.announce.set('Conversation closed');
      },
      error: (err: Error) => this.actionError.set(err.message),
    });
  }

  // Drag and drop onto the thread ----------------------------------------
  protected onDrag(e: DragEvent, over: boolean) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    this.dragging.set(over);
  }

  protected onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragging.set(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) this.composer()?.attach(file);
  }

  // Keyboard --------------------------------------------------------------
  protected shortcut(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const target = e.target as HTMLElement | null;
    const typing = !!target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
    if (e.key === 'Escape') {
      if (this.helpOpen()) this.helpOpen.set(false);
      else if (this.composer()?.closeQuick()) { /* closed the picker */ }
      else if (typing) target!.blur();
      else if (this.panelOpen()) this.panelOpen.set(false);
      else return;
      e.preventDefault();
      return;
    }
    if (typing || this.helpOpen() && e.key !== '?') return;
    const handled = this.runShortcut(e.key);
    if (handled) e.preventDefault();
  }

  private runShortcut(key: string): boolean {
    switch (key) {
      case 'j': case 'k': {
        const rows = this.rows();
        if (!rows.length) return false;
        const at = rows.findIndex((r) => r.id === this.selectedId());
        const next = at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (key === 'j' ? 1 : -1)));
        this.open(rows[next]);
        return true;
      }
      case 'r': this.composer()?.focus(); return !!this.composer();
      case '/': this.composer()?.openQuick(); return !!this.composer();
      case 'e': this.resolve(); return !!this.selected();
      case 'i': this.panelOpen.update((v) => !v); return !!this.selected();
      case '?':
        this.helpOpen.update((v) => !v);
        if (this.helpOpen()) afterNextRender({ write: () => this.helpClose()?.nativeElement.focus() }, { injector: this.injector });
        return true;
      default: return false;
    }
  }

  // View helpers ----------------------------------------------------------
  protected tick$(status: string | null) {
    return status ? TICKS[status.toUpperCase()] ?? { icon: 'done', label: status.toLowerCase() } : null;
  }

  protected initials(row: { name: string; phone: string }): string {
    return initials(row);
  }

  protected hue(phone: string): number {
    return hue(phone);
  }

  protected userName(id: number | null): string {
    if (id == null) return 'Unassigned';
    if (id === this.me()?.id) return 'You';
    const u = this.team().find((t) => t.id === id);
    return u ? u.name || u.email : `User #${id}`;
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
}

function dayLabel(at: string): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
