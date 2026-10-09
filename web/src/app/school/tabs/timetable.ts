import { Component, output, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

import { ClassInfo, Day, SchoolApi, SchoolArea, SchoolMe, SendResult, TimetableEntry } from '../school-api';

const DAYS: Day[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface PeriodRow { period: string; startTime: string; endTime: string }
interface Cell { subject: string; teacher: string; room: string; status: TimetableEntry['status']; id?: number }

function addMinutes(hhmm: string, minutes: number) {
  const [h, m] = (hhmm || '09:00').split(':').map(Number);
  const t = h * 60 + m + minutes;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

@Component({
  selector: 'school-timetable',
  imports: [FormsModule],
  templateUrl: './timetable.html',
  styleUrl: './timetable.scss',
})
export class TimetableTab {
  private readonly api = inject(SchoolApi);
  private readonly pop = viewChild<ElementRef<HTMLElement>>('pop');

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  protected readonly days = DAYS;
  protected readonly today = DAYS[new Date().getDay() - 1] ?? null;
  protected readonly periods = signal<PeriodRow[]>([]);
  protected readonly cells = signal<Record<string, Cell | undefined>>({});
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly editing = signal(false);
  protected readonly saving = signal(false);
  protected readonly message = signal('');

  /** Popover state: which cell, the edit draft, and the change/cancel form. */
  protected readonly active = signal<{ day: Day; period: string } | null>(null);
  protected readonly draft = signal<Cell>({ subject: '', teacher: '', room: '', status: 'scheduled' });
  protected readonly change = signal({ status: 'changed' as 'changed' | 'cancelled', note: '', notify: true });
  protected readonly changing = signal(false);
  protected readonly changeResult = signal<SendResult | null>(null);
  protected readonly changeError = signal('');

  protected readonly className = computed(() => {
    const c = this.classes().find((x) => x.key === this.classKey());
    return c ? `${c.className}${c.section}` : this.classKey();
  });
  protected readonly canEdit = computed(() => {
    const t = this.me()?.title;
    return t === 'principal' || t === 'class_teacher';
  });

  private sub?: Subscription;

  constructor() {
    effect(() => {
      const key = this.classKey();
      untracked(() => this.load(key));
    });
  }

  protected key(day: Day, period: string) {
    return `${day}|${period}`;
  }

  protected load(key = this.classKey()) {
    this.sub?.unsubscribe();
    this.editing.set(false);
    this.error.set('');
    this.message.set('');
    if (!key) {
      this.periods.set([]);
      this.cells.set({});
      return;
    }
    this.loading.set(true);
    this.sub = this.api.timetable(key).subscribe({
      next: ({ entries }) => {
        this.apply(entries);
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  private apply(entries: TimetableEntry[]) {
    const periods = new Map<string, PeriodRow>();
    const cells: Record<string, Cell> = {};
    for (const e of entries) {
      if (!periods.has(e.period)) periods.set(e.period, { period: e.period, startTime: e.startTime, endTime: e.endTime });
      cells[this.key(e.day, e.period)] = { subject: e.subject, teacher: e.teacher, room: e.room, status: e.status ?? 'scheduled', id: e.id };
    }
    this.periods.set([...periods.values()].sort((a, b) => a.startTime.localeCompare(b.startTime)));
    this.cells.set(cells);
  }

  protected addPeriod() {
    this.periods.update((rows) => {
      const start = rows.at(-1)?.endTime ?? '09:00';
      let n = rows.length + 1;
      while (rows.some((r) => r.period === String(n))) n++;
      return [...rows, { period: String(n), startTime: start, endTime: addMinutes(start, 45) }];
    });
  }

  protected removePeriod(row: PeriodRow) {
    this.periods.update((rows) => rows.filter((r) => r !== row));
    this.cells.update((cells) => {
      const next = { ...cells };
      for (const d of DAYS) delete next[this.key(d, row.period)];
      return next;
    });
  }

  protected setTime(row: PeriodRow, field: 'startTime' | 'endTime', e: Event) {
    const value = (e.target as HTMLInputElement).value;
    this.periods.update((rows) => rows.map((r) => (r === row ? { ...r, [field]: value } : r)));
  }

  protected open(day: Day, period: string) {
    const cell = this.cells()[this.key(day, period)];
    if (!this.editing() && !cell?.subject) return;
    this.active.set({ day, period });
    this.draft.set(cell ? { ...cell } : { subject: '', teacher: '', room: '', status: 'scheduled' });
    this.change.set({ status: 'changed', note: '', notify: true });
    this.changeResult.set(null);
    this.changeError.set('');
    this.pop()?.nativeElement.showPopover();
  }

  protected close() {
    this.pop()?.nativeElement.hidePopover();
  }

  protected onToggle(e: Event) {
    if ((e as ToggleEvent).newState === 'closed') this.active.set(null);
  }

  protected patch(field: 'subject' | 'teacher' | 'room', value: string) {
    this.draft.update((d) => ({ ...d, [field]: value }));
  }

  protected patchChange(field: 'status' | 'note' | 'notify', value: string | boolean) {
    this.change.update((c) => ({ ...c, [field]: value }));
  }

  protected applyCell() {
    const a = this.active();
    if (!a) return;
    const d = this.draft();
    this.cells.update((cells) => {
      const next = { ...cells };
      const k = this.key(a.day, a.period);
      if (d.subject.trim()) next[k] = { ...d, subject: d.subject.trim() };
      else delete next[k];
      return next;
    });
    this.close();
  }

  protected save() {
    const cells = this.cells();
    const entries: TimetableEntry[] = [];
    for (const p of this.periods()) {
      for (const day of DAYS) {
        const c = cells[this.key(day, p.period)];
        if (c?.subject) entries.push({ id: c.id, day, period: p.period, startTime: p.startTime, endTime: p.endTime, subject: c.subject, teacher: c.teacher, room: c.room, status: c.status });
      }
    }
    this.saving.set(true);
    this.error.set('');
    this.api.saveTimetable(this.classKey(), entries).subscribe({
      next: ({ entries: saved }) => {
        this.apply(saved);
        this.saving.set(false);
        this.editing.set(false);
        this.message.set(`Timetable for class ${this.className()} saved.`);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.saving.set(false);
      },
    });
  }

  protected cancelEdit() {
    this.load();
  }

  protected sendChange() {
    const a = this.active();
    if (!a) return;
    const c = this.change();
    this.changing.set(true);
    this.changeError.set('');
    this.api.timetableChange({ classKey: this.classKey(), day: a.day, period: a.period, status: c.status, note: c.note.trim(), notify: c.notify }).subscribe({
      next: (r) => {
        this.cells.update((cells) => {
          const k = this.key(a.day, a.period);
          return { ...cells, [k]: { ...cells[k]!, status: r.entry?.status ?? c.status } };
        });
        this.changeResult.set({ sent: r.sent, skipped: r.skipped, failed: r.failed });
        this.changing.set(false);
      },
      error: (err: Error) => {
        this.changeError.set(err.message);
        this.changing.set(false);
      },
    });
  }

  protected print() {
    document.body.classList.add('tt-printing');
    addEventListener('afterprint', () => document.body.classList.remove('tt-printing'), { once: true });
    window.print();
  }
}
