import { DatePipe } from '@angular/common';
import { Component, effect, inject, input, output, signal } from '@angular/core';
import { Store } from '../../core/store';
import { FormsModule } from '@angular/forms';

import { ClassInfo, LeaveRequest, SchoolApi, SchoolArea, SchoolMe } from '../school-api';
import { Tilt } from '../tilt';

type LeaveStatus = LeaveRequest['status'];

@Component({
  selector: 'school-leave',
  imports: [FormsModule, DatePipe, Tilt],
  templateUrl: './leave.html',
  styleUrl: './leave.scss',
})
export class LeaveTab {
  private readonly api = inject(SchoolApi);
  private readonly store = inject(Store);

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  protected readonly statuses: LeaveStatus[] = ['pending', 'approved', 'rejected'];
  protected readonly status = signal<LeaveStatus>('pending');
  protected readonly requests = signal<LeaveRequest[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly toast = signal('');

  /** The card whose decision row is open, and which way. */
  protected readonly deciding = signal<{ id: number; decision: 'approve' | 'reject' } | null>(null);
  protected readonly note = signal('');
  protected readonly busy = signal<number | null>(null);
  protected readonly leaving = signal<{ id: number; dir: 'approve' | 'reject' } | null>(null);

  private toastTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => this.load(this.status()));
    this.store.watch(['school', 'objects', 'tickets', 'inbox'], () => this.load(this.status(), true));
  }

  private load(status: LeaveStatus, quiet = false) {
    if (!quiet) {
      this.loading.set(true);
      this.error.set('');
    }
    this.api.leave(status).subscribe({
      next: (r) => {
        const key = this.classKey();
        this.requests.set(key ? r.requests.filter((q) => q.classKey === key) : r.requests);
        this.loading.set(false);
      },
      error: (e: Error) => { this.error.set(e.message); this.loading.set(false); },
    });
  }

  protected open(id: number, decision: 'approve' | 'reject') {
    this.deciding.set({ id, decision });
    this.note.set('');
  }

  protected decide(req: LeaveRequest) {
    const d = this.deciding();
    if (!d) return;
    this.busy.set(req.ticketId);
    this.error.set('');
    this.api.decideLeave(req.ticketId, { decision: d.decision, note: this.note().trim() || undefined }).subscribe({
      next: (r) => {
        this.leaving.set({ id: req.ticketId, dir: d.decision });
        this.deciding.set(null);
        this.busy.set(null);
        this.showToast(r.notified ? `${d.decision === 'approve' ? 'Approved' : 'Rejected'} - parent notified on WhatsApp` : 'Decision saved - parent could not be reached on WhatsApp');
        setTimeout(() => {
          this.requests.update((l) => l.filter((x) => x.ticketId !== req.ticketId));
          this.leaving.set(null);
        }, 420);
      },
      error: (e: Error) => { this.error.set(e.message); this.busy.set(null); },
    });
  }

  private showToast(msg: string) {
    this.toast.set(msg);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3600);
  }

  protected days(r: LeaveRequest) {
    if (!r.fromDate) return null;
    const to = r.toDate || r.fromDate;
    return Math.round((Date.parse(to) - Date.parse(r.fromDate)) / 86400000) + 1;
  }
}
