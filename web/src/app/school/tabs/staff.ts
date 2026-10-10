import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { Store } from '../../core/store';
import { SchoolApi } from '../school-api';
import type { ClassInfo, SchoolArea, SchoolMe, StaffMember, StaffTitle } from '../school-api';
import { Tilt } from '../tilt';

const TITLES: { id: StaffTitle; label: string; icon: string; access: string }[] = [
  {
    id: 'principal',
    label: 'Principal',
    icon: 'shield-check',
    access: 'Everything, including staff and school settings.',
  },
  {
    id: 'class_teacher',
    label: 'Class teacher',
    icon: 'presentation',
    access:
      'Attendance, timetable, homework, students, leave, results and PTM - for assigned classes only.',
  },
  {
    id: 'accounts',
    label: 'Accounts',
    icon: 'building-bank',
    access: 'Fee ledger, receipts and payment reminders.',
  },
  {
    id: 'front_desk',
    label: 'Front desk',
    icon: 'headset',
    access: 'Notices, leave requests, PTM bookings and broadcasts.',
  },
];

/** A staff member plus the local edit state of their row. */
interface Row extends StaffMember {
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  error: string;
}

/**
 * Staff & access: assigns each team member a school title (which decides the
 * portal areas they can open) and, for class teachers, their classes. Rows keep
 * their own dirty/saving flags so a live refresh never overwrites unsaved edits.
 */
@Component({
  selector: 'school-staff',
  imports: [FormsModule, RouterLink, Tilt],
  templateUrl: './staff.html',
  styleUrl: './staff.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StaffTab {
  private readonly api = inject(SchoolApi);
  private readonly store = inject(Store);

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  protected readonly titles = TITLES;
  protected readonly rows = signal<Row[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');

  constructor() {
    this.load();
    this.store.watch(['school'], () => this.load(true));
  }

  /** Retry after an error (the banner's action). */
  protected reload() {
    this.error.set('');
    this.loading.set(true);
    this.load();
  }

  private load(quiet = false) {
    this.api.staff().subscribe({
      next: (r) => {
        // Never clobber unsaved edits: skip a live refresh while any row is dirty or saving.
        if (quiet && this.rows().some((x) => x.dirty || x.saving)) return;
        this.rows.set(
          r.users.map((u) => ({ ...u, dirty: false, saving: false, saved: false, error: '' })),
        );
        this.loading.set(false);
      },
      error: (e: Error) => {
        if (!quiet) this.error.set(e.message);
        this.loading.set(false);
      },
    });
  }

  private patch(id: number, change: Partial<Row>) {
    this.rows.update((l) => l.map((r) => (r.id === id ? { ...r, ...change } : r)));
  }

  protected setTitle(row: Row, title: StaffTitle) {
    this.patch(row.id, { title, dirty: true, saved: false });
  }

  protected toggleClass(row: Row, key: string, on: boolean) {
    const classes = on ? [...row.classes, key] : row.classes.filter((k) => k !== key);
    this.patch(row.id, { classes, dirty: true, saved: false });
  }

  protected titleOf(id: StaffTitle) {
    return TITLES.find((t) => t.id === id) ?? TITLES[0];
  }

  protected save(row: Row) {
    this.patch(row.id, { saving: true, error: '' });
    const classes = row.title === 'class_teacher' ? row.classes : [];
    this.api.saveStaff(row.id, { title: row.title, classes }).subscribe({
      next: (r) => this.patch(row.id, { ...r.user, dirty: false, saving: false, saved: true }),
      error: (e: Error) => this.patch(row.id, { saving: false, error: e.message }),
    });
  }
}
