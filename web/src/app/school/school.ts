import { Component, computed, inject, input, signal } from '@angular/core';
import { Store } from '../core/store';
import { ActivatedRoute, Router } from '@angular/router';

import { ClassInfo, SchoolApi, SchoolArea, SchoolMe, StaffTitle } from './school-api';
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

const TABS: { area: SchoolArea; label: string; icon: string; group: string }[] = [
  { area: 'overview', label: 'Overview', icon: 'space_dashboard', group: 'Today' },
  { area: 'attendance', label: 'Attendance', icon: 'fact_check', group: 'Today' },
  { area: 'timetable', label: 'Timetable', icon: 'calendar_view_week', group: 'Today' },
  { area: 'homework', label: 'Homework', icon: 'menu_book', group: 'Today' },
  { area: 'notices', label: 'Notices', icon: 'campaign', group: 'Reach parents' },
  { area: 'students', label: 'Students', icon: 'groups', group: 'People and money' },
  { area: 'fees', label: 'Fees', icon: 'payments', group: 'People and money' },
  { area: 'leave', label: 'Leave', icon: 'event_busy', group: 'Reach parents' },
  { area: 'results', label: 'Results', icon: 'workspace_premium', group: 'People and money' },
  { area: 'broadcast', label: 'Broadcast', icon: 'cell_tower', group: 'Reach parents' },
  { area: 'ptm', label: 'PTM', icon: 'handshake', group: 'Reach parents' },
  { area: 'staff', label: 'Staff', icon: 'badge', group: 'Admin' },
  { area: 'settings', label: 'Settings', icon: 'tune', group: 'Admin' },
];

/** Tabs that show the class switcher, and the ones that need a concrete class. */
const CLASS_TABS = new Set<SchoolArea>(['attendance', 'timetable', 'students', 'homework', 'fees', 'results', 'ptm']);
const CLASS_REQUIRED = new Set<SchoolArea>(['attendance', 'timetable']);

const TITLES: Record<StaffTitle, string> = {
  principal: 'Principal',
  class_teacher: 'Class teacher',
  accounts: 'Accounts',
  front_desk: 'Front desk',
};

@Component({
  selector: 'app-school',
  imports: [
    OverviewTab, AttendanceTab, TimetableTab, HomeworkTab, NoticesTab, StudentsTab, FeesTab,
    LeaveTab, ResultsTab, BroadcastTab, PtmTab, StaffTab, SettingsTab,
  ],
  templateUrl: './school.html',
  styleUrl: './school.scss',
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
      const g = out.find((x) => x.name === t.group) ?? (out.push({ name: t.group, tabs: [] }), out[out.length - 1]);
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
  protected readonly showPicker = computed(() => CLASS_TABS.has(this.active()) && this.visibleClasses().length > 0);
  protected readonly classRequired = computed(() => CLASS_REQUIRED.has(this.active()));
  protected readonly tabClassKey = computed(() => {
    const key = this.classKey();
    const list = this.visibleClasses();
    if (key && list.some((c) => c.key === key)) return key;
    return this.classRequired() ? (list[0]?.key ?? '') : '';
  });

  constructor() {
    this.load();
    this.store.watch(['school'], () => this.load(true));
  }

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
    this.router.navigate([], { relativeTo: this.route, queryParams: { tab: area }, queryParamsHandling: 'merge' });
  }

  protected pickClass(e: Event) {
    this.classKey.set((e.target as HTMLSelectElement).value);
  }
}
