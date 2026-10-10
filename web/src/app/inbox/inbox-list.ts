import { Component, ElementRef, afterRenderEffect, inject, input, model, output } from '@angular/core';

import { Conversation, ConversationStatus } from './inbox-api';

export type Segment = 'all' | 'unread' | 'mine' | 'unassigned' | 'paused';
export type StatusFilter = 'all' | ConversationStatus;
export type Row = Conversation & { name: string; preview: string };
export type SegmentCounts = Partial<Record<Segment, number>>;

const SEGMENTS: { key: Segment; label: string; icon: string }[] = [
  { key: 'all', label: 'All', icon: 'inbox' },
  { key: 'unread', label: 'Unread', icon: 'mark_chat_unread' },
  { key: 'mine', label: 'Mine', icon: 'person' },
  { key: 'unassigned', label: 'Unassigned', icon: 'person_off' },
  { key: 'paused', label: 'Bot paused', icon: 'pan_tool' },
];
const STATUS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'Any status' }, { key: 'open', label: 'Open' },
  { key: 'pending', label: 'Pending' }, { key: 'closed', label: 'Closed' },
];

/** The left pane: search, filter chips and the conversation rows. Stateless; the page owns the data. */
@Component({
  selector: 'app-inbox-list',
  templateUrl: './inbox-list.html',
  styleUrl: './inbox-list.scss',
})
export class InboxList {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly rows = input.required<Row[]>();
  readonly selectedId = input<number | null>(null);
  readonly loading = input(false);
  readonly counts = input<SegmentCounts>({});
  readonly now = input(Date.now());
  readonly segment = model<Segment>('all');
  readonly status = model<StatusFilter>('all');
  readonly search = model('');
  readonly select = output<Row>();

  protected readonly segments = SEGMENTS;
  protected readonly statuses = STATUS;

  constructor() {
    // j/k move the selection from the page; keep the active row on screen.
    afterRenderEffect(() => {
      if (this.selectedId() == null) return;
      this.host.nativeElement.querySelector('.ib-row.on')?.scrollIntoView({ block: 'nearest' });
    });
  }

  protected reset() {
    this.search.set('');
    this.segment.set('all');
    this.status.set('all');
  }

  protected emptyText(): string {
    if (this.search()) return `No conversations match "${this.search()}".`;
    const seg = SEGMENTS.find((s) => s.key === this.segment())?.label.toLowerCase();
    return `Nothing in ${seg === 'all' ? 'this view' : seg} right now.`;
  }

  protected initials(row: Row): string {
    return initials(row);
  }

  protected hue(phone: string): number {
    return hue(phone);
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
}

export function initials(row: { name: string; phone: string }): string {
  const src = row.name.trim();
  if (!src) return row.phone.slice(-2);
  const parts = src.split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function hue(phone: string): number {
  let h = 0;
  for (const ch of phone) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
