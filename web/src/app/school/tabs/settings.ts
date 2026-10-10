import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Store } from '../../core/store';
import { SchoolApi } from '../school-api';
import type { ClassInfo, SchoolArea, SchoolMe, SchoolSettings } from '../school-api';

const COMMANDS: [string, string][] = [
  ['ATTENDANCE', "This month's attendance for their child"],
  ['TIMETABLE', "Today's / this week's timetable"],
  ['HOMEWORK', "Today's homework"],
  ['HOLIDAYS', 'Upcoming holidays'],
  ['EXAMS', 'Exam date sheet'],
  ['RESULT', 'Latest result, privately'],
  ['FEES', 'Dues with a pay link'],
  ['LEAVE', 'Apply for leave: LEAVE <reason> <dates>'],
  ['PTM', 'Book a parent-teacher slot'],
  ['SCHOOL', 'Menu of everything above'],
];

/**
 * School settings: identity, timings, automations and fee-payment details.
 * The absent-alert switch and time are held separately and merged into
 * `absentAlertTime` on save (null = manual only). Live refreshes are skipped
 * while the form is dirty so edits are never clobbered.
 */
@Component({
  selector: 'school-settings',
  imports: [FormsModule],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsTab {
  private readonly api = inject(SchoolApi);
  private readonly store = inject(Store);

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  protected readonly commands = COMMANDS;
  protected readonly s = signal<SchoolSettings | null>(null);
  protected readonly autoAbsent = signal(false);
  protected readonly absentTime = signal('10:00');
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly dirty = signal(false);
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
    this.api.settings().subscribe({
      next: (r) => {
        // Never clobber unsaved edits on a live refresh.
        if (quiet && (this.dirty() || this.saving())) return;
        this.apply(r.settings);
        this.loading.set(false);
      },
      error: (e: Error) => {
        if (!quiet) this.error.set(e.message);
        this.loading.set(false);
      },
    });
  }

  private apply(s: SchoolSettings) {
    this.s.set({ ...s });
    this.autoAbsent.set(!!s.absentAlertTime);
    if (s.absentAlertTime) this.absentTime.set(s.absentAlertTime);
    this.dirty.set(false);
  }

  protected set<K extends keyof SchoolSettings>(key: K, value: SchoolSettings[K]) {
    this.s.update((s) => (s ? { ...s, [key]: value } : s));
    this.touch();
  }

  protected touch() {
    this.dirty.set(true);
    this.saved.set(false);
  }

  protected save() {
    const s = this.s();
    if (!s || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.api
      .saveSettings({ ...s, absentAlertTime: this.autoAbsent() ? this.absentTime() : null })
      .subscribe({
        next: (r) => {
          this.apply(r.settings);
          this.saving.set(false);
          this.saved.set(true);
        },
        error: (e: Error) => {
          this.error.set(e.message);
          this.saving.set(false);
        },
      });
  }
}
