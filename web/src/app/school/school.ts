import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { Store } from '../core/store';
import { SchoolApi } from './school-api';
import type { ClassInfo, SchoolArea, SchoolMe, StaffTitle } from './school-api';
import { AttendanceTab } from './tabs/attendance';
import { BroadcastTab } from './tabs/broadcast';
import { FeesTab } from './tabs/fees';
import { HomeworkTab } from './tabs/homework';
import { LeaveTab } from './tabs/leave';
import { NoticesTab } from './tabs/notices';
import { OverviewTab } from './tabs/overview';
import { PtmTab } from './tabs/ptm';
import { ResultsTab } from './tabs/results';
import { SettingsTab } from './tabs/settings';
import { StaffTab } from './tabs/staff';
import { StudentsTab } from './tabs/students';
import { TimetableTab } from './tabs/timetable';

/**
 * Every school area in rail order. `group` is the rail heading; the server's
 * `me.areas` decides which of these a given staff role actually sees.
 */
const TABS: readonly { area: SchoolArea; label: string; icon: string; group: string }[] = [
  { area: 'overview', label: 'Overview', icon: 'layout-dashboard', group: 'Today' },
  { area: 'attendance', label: 'Attendance', icon: 'checklist', group: 'Today' },
  { area: 'timetable', label: 'Timetable', icon: 'calendar-week', group: 'Today' },
  { area: 'homework', label: 'Homework', icon: 'book-2', group: 'Today' },
  { area: 'notices', label: 'Notices', icon: 'speakerphone', group: 'Reach parents' },
  { area: 'students', label: 'Students', icon: 'users-group', group: 'People and money' },
  { area: 'fees', label: 'Fees', icon: 'cash', group: 'People and money' },
  { area: 'leave', label: 'Leave', icon: 'calendar-x', group: 'Reach parents' },
  { area: 'results', label: 'Results', icon: 'crown', group: 'People and money' },
  { area: 'broadcast', label: 'Broadcast', icon: 'antenna-bars-5', group: 'Reach parents' },
  { area: 'ptm', label: 'PTM', icon: 'heart-handshake', group: 'Reach parents' },
  { area: 'staff', label: 'Staff', icon: 'id-badge-2', group: 'Admin' },
  { area: 'settings', label: 'Settings', icon: 'adjustments-horizontal', group: 'Admin' },
];

/** Tabs that show the class switcher, and the ones that need a concrete class. */
const CLASS_TABS = new Set<SchoolArea>([
  'attendance',
  'timetable',
  'students',
  'homework',
  'fees',
  'results',
  'ptm',
]);
const CLASS_REQUIRED = new Set<SchoolArea>(['attendance', 'timetable']);

/** Display names for staff titles, shown as the role pill in the header. */
const TITLES: Record<StaffTitle, string> = {
  principal: 'Principal',
  class_teacher: 'Class teacher',
  accounts: 'Accounts',
  front_desk: 'Front desk',
};

/**
 * The school desk: one route that hosts every school area as a tab.
 *
 * Areas are role-gated by the server (`me.areas`), so the rail is built from
 * that list rather than hard-coded. The active tab lives in `?tab=` so a
 * reload or shared link lands on the same area, and the class switcher sits
 * here (not in each tab) so the chosen class survives moving between tabs.
 */
@Component({
  selector: 'app-school',
  imports: [
    OverviewTab,
    AttendanceTab,
    TimetableTab,
    HomeworkTab,
    NoticesTab,
    StudentsTab,
    FeesTab,
    LeaveTab,
    ResultsTab,
    BroadcastTab,
    PtmTab,
    StaffTab,
    SettingsTab,
  ],
  templateUrl: './school.html',
  styleUrl: './school.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SchoolView {
  private readonly api = inject(SchoolApi);
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** `?tab=` via withComponentInputBinding. */
  readonly tab = input<string>('');

  protected readonly me = signal<SchoolMe | null>(null);
  protected readonly classes = signal<ClassInfo[]>([]);
  protected readonly classKey = signal('');
  protected readonly loading = signal(true);
  protected readonly error = signal('');

  protected readonly tabs = computed(() => {
    const areas = this.me()?.areas ?? [];
    return TABS.filter((t) => areas.includes(t.area));
  });
  protected readonly groups = computed(() => {
    const out: { name: string; tabs: ReturnType<SchoolView['tabs']> }[] = [];
    for (const t of this.tabs()) {
      const g =
        out.find((x) => x.name === t.group) ??
        (out.push({ name: t.group, tabs: [] }), out[out.length - 1]);
      g.tabs.push(t);
    }
    return out;
  });
  protected readonly active = computed<SchoolArea>(() => {
    const tabs = this.tabs();
    return tabs.find((t) => t.area === this.tab())?.area ?? tabs[0]?.area ?? 'overview';
  });
  protected readonly activeMeta = computed(() => TABS.find((t) => t.area === this.active())!);
  protected readonly roleLabel = computed(() => (this.me() ? TITLES[this.me()!.title] : ''));

  /** Teachers limited to their own classes only ever see those. */
  protected readonly visibleClasses = computed(() => {
    const own = this.me()?.classes ?? [];
    return own.length ? this.classes().filter((c) => own.includes(c.key)) : this.classes();
  });
  protected readonly showPicker = computed(
    () => CLASS_TABS.has(this.active()) && this.visibleClasses().length > 0,
  );
  protected readonly classRequired = computed(() => CLASS_REQUIRED.has(this.active()));
  protected readonly tabClassKey = computed(() => {
    const key = this.classKey();
    const list = this.visibleClasses();
    if (key && list.some((c) => c.key === key)) return key;
    return this.classRequired() ? (list[0]?.key ?? '') : '';
  });

  constructor() {
    // store.watch registers its listener against this component's DestroyRef,
    // so it has to run in the injection context.
    this.load();
    this.store.watch(['school'], () => this.load(true));
  }

  /** `quiet` reloads keep the current screen up instead of flashing the skeleton. */
  protected load(quiet = false) {
    if (!quiet) {
      this.loading.set(true);
      this.error.set('');
    }
    this.api.me().subscribe({
      next: (me) => {
        this.me.set(me);
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
    this.api.classes().subscribe({
      next: ({ classes }) => this.classes.set(classes),
      error: () => this.classes.set([]),
    });
  }

  protected go(area: SchoolArea) {
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: area },
      queryParamsHandling: 'merge',
    });
  }

  protected pickClass(e: Event) {
    this.classKey.set((e.target as HTMLSelectElement).value);
  }
}
