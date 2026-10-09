import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TenancyApi } from '../core/api';
import { Auth, User } from '../core/auth';
import { Tilt } from '../school/tilt';
import {
  SLA_HOURS, TICKET_PRIORITIES, TICKET_STATUSES, Ticket, TicketDraft, TicketEvent, TicketFilter,
  TicketPatch, TicketPriority, TicketStats, TicketStatus, TicketsApi,
} from './tickets-api';

const CLOSED: TicketStatus[] = ['RESOLVED', 'CLOSED'];
const STATUS_LABEL: Record<TicketStatus, string> = {
  OPEN: 'Open', IN_PROGRESS: 'In progress', WAITING_CUSTOMER: 'Waiting on customer', RESOLVED: 'Resolved', CLOSED: 'Closed',
};
const STATUS_TONE: Record<TicketStatus, string> = {
  OPEN: 'tone-info', IN_PROGRESS: 'tone-ok', WAITING_CUSTOMER: 'tone-warn', RESOLVED: 'tone-mute', CLOSED: 'tone-mute',
};
const PRIORITY_TONE: Record<TicketPriority, string> = { low: 'tone-mute', normal: 'tone-info', high: 'tone-warn', urgent: 'tone-bad' };

const blankDraft = (): TicketDraft => ({ subject: '', category: '', priority: 'normal', assignedTo: null, contactId: null });

@Component({
  selector: 'app-tickets',
  imports: [FormsModule, Tilt],
  templateUrl: './tickets.html',
  styleUrl: './tickets.scss',
  host: { '(document:keydown.escape)': 'closeDetail()' },
})
export class TicketsView {
  private readonly api = inject(TicketsApi);
  private readonly auth = inject(Auth);
  private readonly tenancy = inject(TenancyApi);

  protected readonly statuses = TICKET_STATUSES;
  protected readonly priorities = TICKET_PRIORITIES;
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly statusTone = STATUS_TONE;
  protected readonly priorityTone = PRIORITY_TONE;
  protected readonly slaHours = SLA_HOURS;

  // list
  protected readonly tickets = signal<Ticket[]>([]);
  protected readonly stats = signal<TicketStats | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly filter = signal<TicketFilter>({ status: '', priority: '', assignedTo: '', overdue: false });
  protected readonly search = signal('');
  protected readonly team = signal<User[]>([]);
  /** Ticks every 30s so SLA countdowns stay honest without a reload. */
  protected readonly now = signal(Date.now());

  // detail
  protected readonly selected = signal<Ticket | null>(null);
  protected readonly events = signal<TicketEvent[]>([]);
  protected readonly eventsLoading = signal(false);
  protected readonly detailError = signal('');
  protected readonly saving = signal(false);
  protected readonly note = signal('');
  protected readonly pendingStatus = signal<TicketStatus | null>(null);
  protected readonly notify = signal(false);

  // create
  protected readonly creating = signal(false);
  protected readonly draft = signal<TicketDraft>(blankDraft());
  protected readonly submitted = signal(false);
  protected readonly createError = signal('');

  protected readonly me = this.auth.user;

  protected readonly visible = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.tickets();
    return this.tickets().filter((t) => `${t.reference} ${t.subject} ${t.category}`.toLowerCase().includes(q));
  });

  protected readonly openCount = computed(() => {
    const s = this.stats()?.byStatus;
    return s ? s.OPEN + s.IN_PROGRESS + s.WAITING_CUSTOMER : 0;
  });

  protected readonly filtered = computed(() => {
    const f = this.filter();
    return Boolean(f.status || f.priority || f.assignedTo || f.overdue || this.search().trim());
  });

  protected readonly draftInvalid = computed(() => {
    const d = this.draft();
    return !d.subject.trim() && !d.category.trim();
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    // /api/users is admin-only; agents can still assign to themselves.
    if (this.auth.atLeast('admin')) {
      this.tenancy.users().subscribe({ next: (r) => this.team.set(r.users.filter((u) => !u.disabled)), error: () => {} });
    }
    this.load();
  }

  // ------------------------------------------------------------- list --
  protected load() {
    this.loading.set(true);
    this.error.set('');
    this.api.list(this.filter()).subscribe({
      next: (list) => { this.tickets.set(list); this.loading.set(false); },
      error: (e: Error) => { this.error.set(e.message); this.loading.set(false); },
    });
    this.loadStats();
  }

  private loadStats() {
    this.api.stats().subscribe({ next: (s) => this.stats.set(s), error: () => {} });
  }

  protected setFilter(patch: Partial<TicketFilter>) {
    this.filter.update((f) => ({ ...f, ...patch }));
    this.load();
  }

  protected clearFilters() {
    this.search.set('');
    this.setFilter({ status: '', priority: '', assignedTo: '', overdue: false });
  }

  // ------------------------------------------------------------- helpers --
  protected assignees = computed(() => {
    const me = this.me();
    const list = [...this.team()];
    if (me && !list.some((u) => u.id === me.id)) list.unshift(me);
    return list;
  });

  protected userName(id: number | null): string {
    if (id == null) return 'Unassigned';
    if (id === this.me()?.id) return 'You';
    const u = this.team().find((x) => x.id === id);
    return u ? u.name || u.email : `User #${id}`;
  }

  protected initials(id: number | null): string {
    const name = this.userName(id);
    if (id == null) return '?';
    return name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  }

  /** Assigned to someone outside the visible team list (agents cannot list users). */
  protected orphan(t: Ticket): boolean {
    return t.assignedTo != null && !this.assignees().some((u) => u.id === t.assignedTo);
  }

  protected isClosed(t: Ticket) {
    return CLOSED.includes(t.status);
  }

  /** null when there is no live clock (closed or no SLA). */
  protected sla(t: Ticket): { overdue: boolean; label: string; pct: number } | null {
    if (!t.slaDueAt || this.isClosed(t)) return null;
    const due = Date.parse(t.slaDueAt);
    const start = Date.parse(t.createdAt);
    const left = due - this.now();
    const span = Math.max(due - start, 1);
    return {
      overdue: left < 0,
      label: left < 0 ? `Overdue ${dur(-left)}` : `${dur(left)} left`,
      pct: Math.round(Math.min(100, Math.max(0, ((this.now() - start) / span) * 100))),
    };
  }

  protected ago(iso: string): string {
    const ms = this.now() - Date.parse(iso);
    return ms < 60_000 ? 'just now' : `${dur(ms)} ago`;
  }

  protected median(s: TicketStats): string {
    return s.medianResolveSeconds == null ? '-' : dur(s.medianResolveSeconds * 1000);
  }

  protected describe(e: TicketEvent): string {
    switch (e.kind) {
      case 'created': return 'opened the ticket';
      case 'status': return `moved ${STATUS_LABEL[e.from as TicketStatus] ?? e.from} to ${STATUS_LABEL[e.to as TicketStatus] ?? e.to}`;
      case 'priority': return `changed priority ${e.from} to ${e.to}`;
      case 'assigned': return e.to ? `assigned to ${this.userName(Number(e.to))}` : 'unassigned the ticket';
      case 'message': return 'messaged the customer';
      default: return e.body && !e.from && !e.to ? 'added a note' : 'updated the ticket';
    }
  }

  protected eventIcon(kind: TicketEvent['kind']): string {
    return { created: 'add_circle', status: 'swap_horiz', priority: 'flag', assigned: 'person', message: 'chat', note: 'sticky_note_2' }[kind] ?? 'history';
  }

  protected actor(e: TicketEvent): string {
    return e.userId == null ? 'System' : this.userName(e.userId);
  }

  // ------------------------------------------------------------- detail --
  protected open(t: Ticket) {
    this.selected.set(t);
    this.detailError.set('');
    this.note.set('');
    this.pendingStatus.set(null);
    this.loadEvents(t.id);
  }

  protected closeDetail() {
    this.selected.set(null);
  }

  private loadEvents(id: number) {
    this.eventsLoading.set(true);
    this.api.events(id).subscribe({
      next: (ev) => { this.events.set(ev); this.eventsLoading.set(false); },
      error: (e: Error) => { this.detailError.set(e.message); this.eventsLoading.set(false); },
    });
  }

  protected changeStatus(t: Ticket, status: TicketStatus) {
    if (status === t.status) return;
    // Resolving or closing is the one change a customer may hear about; confirm it inline.
    if (CLOSED.includes(status)) {
      this.notify.set(false);
      this.pendingStatus.set(status);
      return;
    }
    this.patch(t, { status });
  }

  protected confirmStatus(t: Ticket) {
    const status = this.pendingStatus();
    if (!status) return;
    this.pendingStatus.set(null);
    this.patch(t, { status, notify: this.notify() && t.contactId != null });
  }

  protected patch(t: Ticket, patch: TicketPatch) {
    this.saving.set(true);
    this.detailError.set('');
    this.api.update(t.id, patch).subscribe({
      next: ({ ticket }) => {
        this.saving.set(false);
        this.replace(ticket);
        this.loadEvents(ticket.id);
        this.loadStats();
      },
      error: (e: Error) => { this.saving.set(false); this.detailError.set(e.message); },
    });
  }

  protected assign(t: Ticket, value: string) {
    this.patch(t, { assignedTo: value === '' ? null : Number(value) });
  }

  protected addNote(t: Ticket) {
    const body = this.note().trim();
    if (!body) return;
    this.saving.set(true);
    this.api.addNote(t.id, body).subscribe({
      next: (ev) => { this.saving.set(false); this.note.set(''); this.events.update((list) => [...list, ev]); },
      error: (e: Error) => { this.saving.set(false); this.detailError.set(e.message); },
    });
  }

  protected rate(t: Ticket, score: number) {
    this.saving.set(true);
    this.api.satisfaction(t.id, score).subscribe({
      next: (ticket) => { this.saving.set(false); this.replace(ticket); this.loadEvents(ticket.id); },
      error: (e: Error) => { this.saving.set(false); this.detailError.set(e.message); },
    });
  }

  private replace(ticket: Ticket) {
    this.tickets.update((list) => list.map((x) => (x.id === ticket.id ? ticket : x)));
    if (this.selected()?.id === ticket.id) this.selected.set(ticket);
  }

  // ------------------------------------------------------------- create --
  protected startCreate() {
    this.draft.set(blankDraft());
    this.submitted.set(false);
    this.createError.set('');
    this.creating.set(true);
  }

  protected setDraft(patch: Partial<TicketDraft>) {
    this.draft.update((d) => ({ ...d, ...patch }));
  }

  protected submitCreate() {
    this.submitted.set(true);
    if (this.draftInvalid()) return;
    const d = this.draft();
    this.saving.set(true);
    this.createError.set('');
    this.api.create({ ...d, subject: d.subject.trim(), category: d.category.trim() }).subscribe({
      next: (ticket) => {
        this.saving.set(false);
        this.creating.set(false);
        this.tickets.update((list) => [ticket, ...list]);
        this.loadStats();
        this.open(ticket);
      },
      error: (e: Error) => { this.saving.set(false); this.createError.set(e.message); },
    });
  }
}

/** 90061000 -> "1d 1h"; coarse on purpose, an SLA badge is not a stopwatch. */
function dur(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
