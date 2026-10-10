import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type { Subscription } from 'rxjs';

import { Store } from '../../core/store';
import { SchoolApi } from '../school-api';
import type {
  AttendanceRow,
  AttendanceStatus,
  ClassInfo,
  ImportResult,
  SchoolArea,
  SchoolMe,
  SendResult,
  StudentAttendance,
} from '../school-api';
import { Tilt } from '../tilt';

/**
 * The four marks, in the order teachers tap them. `tone` drives every colour
 * for the status (summary tile, segmented button, row stripe, calendar cell):
 * present = success, absent = danger, late = warning, excused = info.
 */
const STATUSES: readonly { value: AttendanceStatus; label: string; short: string; tone: string }[] =
  [
    { value: 'present', label: 'Present', short: 'P', tone: 'tone-ok' },
    { value: 'absent', label: 'Absent', short: 'A', tone: 'tone-bad' },
    { value: 'late', label: 'Late', short: 'L', tone: 'tone-warn' },
    { value: 'excused', label: 'Excused', short: 'E', tone: 'tone-info' },
  ];

/**
 * Daily roll call for one class: mark each student, save the sheet, then
 * WhatsApp the parents of anyone absent (optionally late).
 *
 * Marks stay local until saved, so live store refreshes are skipped while the
 * sheet is dirty, and alerts are blocked until it is saved — otherwise parents
 * would be messaged from stale marks. Already-alerted students are skipped
 * server-side, so re-sending is safe.
 */
@Component({
  selector: 'school-attendance',
  imports: [Tilt],
  templateUrl: './attendance.html',
  styleUrl: './attendance.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AttendanceTab {
  private readonly api = inject(SchoolApi);
  private readonly store = inject(Store);

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  protected readonly statuses = STATUSES;
  protected readonly date = signal(new Date().toLocaleDateString('en-CA'));
  protected readonly rows = signal<AttendanceRow[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly saving = signal(false);
  protected readonly dirty = signal(false);
  protected readonly message = signal('');

  protected readonly importing = signal(false);
  protected readonly importResult = signal<ImportResult | null>(null);

  protected readonly notifyLate = signal(false);
  protected readonly notifyConfirm = signal(false);
  protected readonly notifying = signal(false);
  protected readonly notifyResult = signal<SendResult | null>(null);
  protected readonly notifyError = signal('');

  /** Student whose monthly history drawer is open; null = drawer closed. */
  protected readonly student = signal<AttendanceRow | null>(null);
  protected readonly month = signal(new Date().toLocaleDateString('en-CA').slice(0, 7));
  protected readonly history = signal<StudentAttendance | null>(null);
  protected readonly historyLoading = signal(false);
  protected readonly historyError = signal('');

  protected readonly className = computed(() => {
    const c = this.classes().find((x) => x.key === this.classKey());
    return c ? `${c.className}${c.section}` : this.classKey();
  });
  protected readonly summary = computed(() => {
    const out = { present: 0, absent: 0, late: 0, excused: 0, unmarked: 0 };
    for (const r of this.rows()) out[r.status ?? 'unmarked']++;
    return out;
  });
  protected readonly toAlert = computed(
    () =>
      this.rows().filter(
        (r) =>
          (r.status === 'absent' || (this.notifyLate() && r.status === 'late')) && !r.alertedAt,
      ).length,
  );
  protected readonly calendar = computed(() => {
    const h = this.history();
    if (!h) return [];
    const [y, m] = h.month.split('-').map(Number);
    const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday first
    const days = new Date(y, m, 0).getDate();
    const byDate = new Map(h.days.map((d) => [d.date, d.status]));
    const cells: { day: number | null; date: string; status: AttendanceStatus | null }[] = [];
    for (let i = 0; i < lead; i++) cells.push({ day: null, date: `x${i}`, status: null });
    for (let d = 1; d <= days; d++) {
      const date = `${h.month}-${String(d).padStart(2, '0')}`;
      cells.push({ day: d, date, status: byDate.get(date) ?? null });
    }
    return cells;
  });

  /** In-flight sheet request, cancelled when class/date changes so a slow old response can't overwrite the new sheet. */
  private sub?: Subscription;

  constructor() {
    effect(() => {
      const key = this.classKey();
      const date = this.date();
      untracked(() => this.load(key, date));
    });
    // Live refresh, but never over an unsaved sheet.
    this.store.watch(['school', 'objects'], () => {
      if (!this.dirty() && !this.saving()) this.load(this.classKey(), this.date(), true);
    });
  }

  protected load(key = this.classKey(), date = this.date(), quiet = false) {
    this.sub?.unsubscribe();
    if (!quiet) {
      this.error.set('');
      this.message.set('');
      this.dirty.set(false);
    }
    if (!key) {
      this.rows.set([]);
      return;
    }
    if (!quiet) this.loading.set(true);
    this.sub = this.api.attendance(key, date).subscribe({
      next: (sheet) => {
        this.rows.set(sheet.rows);
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.rows.set([]);
        this.loading.set(false);
      },
    });
  }

  protected pickDate(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    if (v) this.date.set(v);
  }

  protected set(row: AttendanceRow, status: AttendanceStatus) {
    this.rows.update((rows) =>
      rows.map((r) =>
        r.studentId === row.studentId
          ? { ...r, status, arrivedAt: status === 'late' ? r.arrivedAt : null }
          : r,
      ),
    );
    this.dirty.set(true);
  }

  protected setArrival(row: AttendanceRow, e: Event) {
    const arrivedAt = (e.target as HTMLInputElement).value || null;
    this.rows.update((rows) =>
      rows.map((r) => (r.studentId === row.studentId ? { ...r, arrivedAt } : r)),
    );
    this.dirty.set(true);
  }

  protected allPresent() {
    this.rows.update((rows) =>
      rows.map((r) => ({ ...r, status: 'present' as const, arrivedAt: null })),
    );
    this.dirty.set(true);
  }

  protected save() {
    const marks = this.rows()
      .filter((r) => r.status)
      .map((r) => ({
        studentId: r.studentId,
        status: r.status!,
        arrivedAt: r.status === 'late' ? r.arrivedAt : null,
      }));
    if (!marks.length) {
      this.message.set('Mark at least one student first.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.api.markAttendance({ date: this.date(), classKey: this.classKey(), marks }).subscribe({
      next: (sheet) => {
        this.rows.set(sheet.rows);
        this.saving.set(false);
        this.dirty.set(false);
        this.message.set(`Saved ${marks.length} marks for class ${this.className()}.`);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.saving.set(false);
      },
    });
  }

  protected importFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.importing.set(true);
    this.importResult.set(null);
    this.error.set('');
    this.api.importAttendance(file, this.date()).subscribe({
      next: (r) => {
        this.importResult.set(r);
        this.importing.set(false);
        this.load();
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.importing.set(false);
      },
    });
  }

  protected notify() {
    this.notifying.set(true);
    this.notifyError.set('');
    this.notifyResult.set(null);
    const kinds: ('absent' | 'late')[] = this.notifyLate() ? ['absent', 'late'] : ['absent'];
    this.api.notifyAttendance({ date: this.date(), classKey: this.classKey(), kinds }).subscribe({
      next: (r) => {
        this.notifyResult.set(r);
        this.notifying.set(false);
        this.notifyConfirm.set(false);
        this.load();
      },
      error: (err: Error) => {
        this.notifyError.set(err.message);
        this.notifying.set(false);
      },
    });
  }

  protected openHistory(row: AttendanceRow) {
    this.student.set(row);
    this.loadHistory();
  }

  protected pickMonth(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    if (!v) return;
    this.month.set(v);
    this.loadHistory();
  }

  protected loadHistory() {
    const row = this.student();
    if (!row) return;
    this.historyLoading.set(true);
    this.historyError.set('');
    this.history.set(null);
    this.api.studentAttendance(row.studentId, this.month()).subscribe({
      next: (h) => {
        this.history.set(h);
        this.historyLoading.set(false);
      },
      error: (err: Error) => {
        this.historyError.set(err.message);
        this.historyLoading.set(false);
      },
    });
  }

  protected tone(status: AttendanceStatus | null) {
    return STATUSES.find((s) => s.value === status)?.tone ?? 'tone-mute';
  }
}
