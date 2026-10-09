import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { ClassInfo, SchoolApi, SchoolArea, SchoolMe, StaffMember, StaffTitle } from '../school-api';
import { Tilt } from '../tilt';

const TITLES: { id: StaffTitle; label: string; icon: string; access: string }[] = [
  { id: 'principal', label: 'Principal', icon: 'shield_person', access: 'Everything, including staff and school settings.' },
  { id: 'class_teacher', label: 'Class teacher', icon: 'co_present', access: 'Attendance, timetable, homework, students, leave, results and PTM - for assigned classes only.' },
  { id: 'accounts', label: 'Accounts', icon: 'account_balance', access: 'Fee ledger, receipts and payment reminders.' },
  { id: 'front_desk', label: 'Front desk', icon: 'support_agent', access: 'Notices, leave requests, PTM bookings and broadcasts.' },
];

interface Row extends StaffMember { dirty: boolean; saving: boolean; saved: boolean; error: string }

@Component({
  selector: 'school-staff',
  imports: [FormsModule, RouterLink, Tilt],
  templateUrl: './staff.html',
  styleUrl: './staff.scss',
})
export class StaffTab {
  private readonly api = inject(SchoolApi);

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  protected readonly titles = TITLES;
  protected readonly rows = signal<Row[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');

  constructor() {
    this.api.staff().subscribe({
      next: (r) => { this.rows.set(r.users.map((u) => ({ ...u, dirty: false, saving: false, saved: false, error: '' }))); this.loading.set(false); },
      error: (e: Error) => { this.error.set(e.message); this.loading.set(false); },
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

  protected titleOf(id: StaffTitle) { return TITLES.find((t) => t.id === id) ?? TITLES[0]; }

  protected save(row: Row) {
    this.patch(row.id, { saving: true, error: '' });
    const classes = row.title === 'class_teacher' ? row.classes : [];
    this.api.saveStaff(row.id, { title: row.title, classes }).subscribe({
      next: (r) => this.patch(row.id, { ...r.user, dirty: false, saving: false, saved: true }),
      error: (e: Error) => this.patch(row.id, { saving: false, error: e.message }),
    });
  }
}
