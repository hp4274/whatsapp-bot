import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { Store } from '../../core/store';
import { FormsModule } from '@angular/forms';
import { Observable, map } from 'rxjs';

import { ClassInfo, Fee, FeeTotals, SchoolApi, SchoolArea, SchoolMe, SendResult, Student } from '../school-api';

const METHODS = ['cash', 'UPI', 'card', 'netbanking', 'cheque'];

interface FeeForm { classKey: string; studentId: number; term: string; amount: number; dueAt: string; payLink: string }

@Component({
  selector: 'school-fees',
  imports: [FormsModule, DatePipe, DecimalPipe],
  templateUrl: './fees.html',
  styleUrl: './fees.scss',
})
export class FeesTab {
  private readonly api = inject(SchoolApi);
  private readonly store = inject(Store);

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  protected readonly methods = METHODS;
  protected readonly fClass = signal('');
  protected readonly fStatus = signal('');
  protected readonly fTerm = signal('');

  protected readonly fees = signal<Fee[]>([]);
  protected readonly totals = signal<FeeTotals | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly flash = signal('');
  protected readonly remindResult = signal<SendResult | null>(null);
  protected readonly selected = signal<Set<number>>(new Set());

  protected readonly payingId = signal<number | null>(null);
  protected readonly payMethod = signal('UPI');
  protected readonly justPaid = signal<number | null>(null);
  protected readonly busy = signal(false);
  protected readonly copied = signal<number | null>(null);

  // create panel
  protected readonly panel = signal<'' | 'single' | 'bulk'>('');
  protected readonly students = signal<Student[]>([]);
  protected readonly form = signal<FeeForm>({ classKey: '', studentId: 0, term: '', amount: 0, dueAt: '', payLink: '' });

  protected readonly terms = computed(() => [...new Set(this.fees().map((f) => f.term))].sort());
  protected readonly currency = computed(() => this.totals()?.currency || this.fees()[0]?.currency || 'INR');
  protected readonly allChecked = computed(() => this.fees().length > 0 && this.fees().every((f) => this.selected().has(f.id)));

  constructor() {
    effect(() => this.fClass.set(this.classKey()));
    effect(() => this.load(this.fClass(), this.fStatus(), this.fTerm()));
    this.store.watch(['school', 'objects'], () => this.load(this.fClass(), this.fStatus(), this.fTerm(), true));
  }

  protected reload() { this.load(this.fClass(), this.fStatus(), this.fTerm()); }

  private load(cls: string, status: string, term: string, quiet = false) {
    if (!quiet) this.loading.set(true);
    this.api.fees({ class: cls || undefined, status: status || undefined, term: term || undefined }).subscribe({
      next: (r) => {
        this.fees.set(r.fees);
        this.totals.set(r.totals);
        if (!quiet) this.selected.set(new Set());
        this.loading.set(false);
      },
      error: (e: Error) => { this.error.set(e.message); this.loading.set(false); },
    });
  }

  protected tone(s: Fee['status']) {
    return { paid: 'ok', pending: 'warn', overdue: 'bad', waived: 'mute' }[s];
  }

  protected toggle(id: number, on: boolean) {
    this.selected.update((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });
  }
  protected toggleAll(on: boolean) {
    this.selected.set(on ? new Set(this.fees().map((f) => f.id)) : new Set());
  }

  protected openPanel(kind: 'single' | 'bulk') {
    this.panel.set(this.panel() === kind ? '' : kind);
    const cls = this.fClass() || this.classes()[0]?.key || '';
    this.form.update((f) => ({ ...f, classKey: cls, studentId: 0 }));
    if (kind === 'single') this.loadStudents(cls);
  }

  protected setForm<K extends keyof FeeForm>(key: K, value: FeeForm[K]) {
    this.form.update((f) => ({ ...f, [key]: value }));
    if (key === 'classKey' && this.panel() === 'single') this.loadStudents(value as string);
  }

  private loadStudents(cls: string) {
    this.students.set([]);
    this.api.students(cls || undefined).subscribe({
      next: (r) => this.students.set(r.students),
      error: (e: Error) => this.error.set(e.message),
    });
  }

  protected create() {
    const f = this.form();
    if (!f.term.trim() || !(f.amount > 0) || !f.dueAt) return;
    this.busy.set(true);
    this.error.set('');
    const req: Observable<string> = this.panel() === 'bulk'
      ? this.api.bulkFees({ classKey: f.classKey, term: f.term.trim(), amount: f.amount, dueAt: f.dueAt })
          .pipe(map((r) => `${r.created} fee entries created for ${f.classKey}.`))
      : this.api.createFee({ studentId: f.studentId, term: f.term.trim(), amount: f.amount, dueAt: f.dueAt, payLink: f.payLink.trim() || undefined })
          .pipe(map((r) => `Fee created for ${r.fee.studentName}.`));
    req.subscribe({
      next: (msg) => {
        this.flash.set(msg);
        this.panel.set('');
        this.busy.set(false);
        this.reload();
      },
      error: (e: Error) => { this.error.set(e.message); this.busy.set(false); },
    });
  }

  protected markPaid(fee: Fee) {
    this.busy.set(true);
    this.error.set('');
    this.api.markPaid(fee.id, { method: this.payMethod() }).subscribe({
      next: (r) => {
        this.fees.update((l) => l.map((x) => (x.id === fee.id ? r.fee : x)));
        this.justPaid.set(fee.id);
        this.payingId.set(null);
        this.busy.set(false);
        this.flash.set(`Marked paid · receipt ${r.fee.receiptNo ?? ''} ${r.receiptSent ? 'sent on WhatsApp' : 'saved (parent not on WhatsApp)'}.`);
        this.api.fees({ class: this.fClass() || undefined, status: this.fStatus() || undefined, term: this.fTerm() || undefined })
          .subscribe({ next: (t) => this.totals.set(t.totals), error: () => {} });
      },
      error: (e: Error) => { this.error.set(e.message); this.busy.set(false); },
    });
  }

  protected remind(body: { ids?: number[]; status?: 'pending' | 'overdue' }) {
    this.busy.set(true);
    this.error.set('');
    this.remindResult.set(null);
    this.api.remindFees(body).subscribe({
      next: (r) => { this.remindResult.set(r); this.busy.set(false); },
      error: (e: Error) => { this.error.set(e.message); this.busy.set(false); },
    });
  }

  protected remindSelected() { this.remind({ ids: [...this.selected()] }); }

  protected async copy(fee: Fee) {
    if (!fee.payLink) return;
    try {
      await navigator.clipboard.writeText(fee.payLink);
      this.copied.set(fee.id);
      setTimeout(() => this.copied() === fee.id && this.copied.set(null), 1600);
    } catch {
      this.error.set('Could not copy - your browser blocked clipboard access.');
    }
  }
}
