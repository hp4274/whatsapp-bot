import { Component, output, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ClassInfo, PtmSlot, SchoolApi, SchoolArea, SchoolMe } from '../school-api';

@Component({
  selector: 'school-ptm',
  imports: [FormsModule],
  templateUrl: './ptm.html',
  styleUrl: './ptm.scss',
})
export class PtmTab {
  private readonly api = inject(SchoolApi);

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  protected readonly slots = signal<PtmSlot[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly creating = signal(false);
  protected readonly formError = signal('');
  protected readonly removing = signal<number | null>(null);
  protected readonly form = signal({ startsAt: '', durationMinutes: 10, count: 6, teacher: '', classKey: '' });

  /** Slots for the selected class (or all), grouped by local day. */
  protected readonly days = computed(() => {
    const key = this.classKey();
    const groups = new Map<string, PtmSlot[]>();
    const sorted = this.slots().filter((s) => !key || s.classKey === key).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (const s of sorted) {
      const day = new Date(s.startsAt).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
      groups.set(day, [...(groups.get(day) ?? []), s]);
    }
    return [...groups].map(([label, slots]) => ({
      label,
      slots,
      booked: slots.filter((s) => s.status === 'booked').length,
    }));
  });
  protected readonly totals = computed(() => {
    const t = { open: 0, booked: 0, cancelled: 0 };
    for (const d of this.days()) for (const s of d.slots) t[s.status]++;
    return t;
  });

  constructor() {
    this.load();
  }

  protected load() {
    this.loading.set(true);
    this.error.set('');
    this.api.ptmSlots().subscribe({
      next: ({ slots }) => {
        this.slots.set(slots);
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected patch(field: 'startsAt' | 'teacher' | 'classKey', value: string): void;
  protected patch(field: 'durationMinutes' | 'count', value: number): void;
  protected patch(field: string, value: string | number) {
    this.form.update((f) => ({ ...f, [field]: value }));
  }

  protected time(iso: string) {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  protected create() {
    const f = this.form();
    const classKey = f.classKey || this.classKey();
    if (!f.startsAt || !f.teacher.trim() || !classKey) {
      this.formError.set('Start time, teacher and class are required.');
      return;
    }
    if (!(f.durationMinutes >= 5 && f.durationMinutes <= 120) || !(f.count >= 1 && f.count <= 60)) {
      this.formError.set('Duration must be 5-120 minutes and count 1-60.');
      return;
    }
    this.formError.set('');
    this.creating.set(true);
    this.api.createPtmSlots({
      startsAt: new Date(f.startsAt).toISOString(),
      durationMinutes: f.durationMinutes,
      count: f.count,
      teacher: f.teacher.trim(),
      classKey,
    }).subscribe({
      next: ({ slots }) => {
        this.slots.update((list) => [...list, ...slots]);
        this.creating.set(false);
        this.message.set(`${slots.length} slots opened for class ${classKey}.`);
      },
      error: (err: Error) => {
        this.formError.set(err.message);
        this.creating.set(false);
      },
    });
  }

  protected remove(slot: PtmSlot) {
    this.removing.set(slot.id);
    this.api.removePtmSlot(slot.id).subscribe({
      next: () => {
        this.slots.update((list) => list.filter((s) => s.id !== slot.id));
        this.removing.set(null);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.removing.set(null);
      },
    });
  }
}
