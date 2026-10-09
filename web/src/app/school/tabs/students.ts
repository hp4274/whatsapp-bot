import { Component, output, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

import { ClassInfo, ImportResult, SchoolApi, SchoolArea, SchoolMe, Student } from '../school-api';

type Draft = Pick<Student, 'rollNumber' | 'name' | 'className' | 'section' | 'fatherName' | 'motherName' | 'parentPhone' | 'busRoute' | 'hostel'> & { id?: number };
type Chip = { kind: 'route' | 'hostel'; value: string; label: string; count: number };

const EMPTY: Draft = { rollNumber: '', name: '', className: '', section: '', fatherName: '', motherName: '', parentPhone: '', busRoute: '', hostel: false };
const TEMPLATE_HEADERS = 'Roll No,Student Name,Class,Section,Father Name,Mother Name,Parent Phone,Bus Route,Hostel';
/** 10 digits, or + country code and 8-15 digits. Spaces and dashes are ignored. */
const PHONE = /^(\d{10}|\+\d{8,15})$/;

@Component({
  selector: 'school-students',
  imports: [FormsModule],
  templateUrl: './students.html',
  styleUrl: './students.scss',
})
export class StudentsTab {
  private readonly api = inject(SchoolApi);

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  protected readonly students = signal<Student[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly query = signal('');
  protected readonly chip = signal<Chip | null>(null);

  protected readonly drawer = signal(false);
  protected readonly draft = signal<Draft>({ ...EMPTY });
  protected readonly touched = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');
  protected readonly confirmId = signal<number | null>(null);
  protected readonly deleting = signal(false);

  protected readonly importing = signal(false);
  protected readonly importResult = signal<ImportResult | null>(null);

  protected readonly canEdit = computed(() => this.me()?.title === 'principal');

  protected readonly classChips = computed(() => this.classes().map((c) => ({ key: c.key, label: `Grade-${c.key}`, count: c.students })));
  protected readonly otherChips = computed<Chip[]>(() => {
    const routes = new Map<string, number>();
    let hostel = 0;
    for (const s of this.students()) {
      if (s.busRoute) routes.set(s.busRoute, (routes.get(s.busRoute) ?? 0) + 1);
      if (s.hostel) hostel++;
    }
    const chips: Chip[] = [...routes].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([value, count]) => ({ kind: 'route', value, label: `Bus-Route-${value.replace(/^route\s*/i, '').replace(/\s+/g, '-')}`, count }));
    if (hostel) chips.push({ kind: 'hostel', value: 'hostel', label: 'Hostelers', count: hostel });
    return chips;
  });

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const chip = this.chip();
    return this.students().filter((s) => {
      if (chip?.kind === 'route' && s.busRoute !== chip.value) return false;
      if (chip?.kind === 'hostel' && !s.hostel) return false;
      if (!q) return true;
      return [s.name, s.rollNumber, s.fatherName, s.motherName, s.parentPhone, s.busRoute, s.classKey]
        .some((v) => v?.toLowerCase().includes(q));
    });
  });

  protected readonly errors = computed(() => {
    const d = this.draft();
    const e: Partial<Record<keyof Draft, string>> = {};
    if (!d.name.trim()) e.name = 'Name is required';
    if (!d.rollNumber.trim()) e.rollNumber = 'Roll number is required';
    if (!d.className.trim()) e.className = 'Class is required';
    if (!d.section.trim()) e.section = 'Section is required';
    const phone = d.parentPhone.replace(/[\s-]/g, '');
    if (phone && !PHONE.test(phone)) e.parentPhone = 'Use 10 digits or +country code format';
    return e;
  });
  protected readonly shownErrors = computed(() => (this.touched() ? this.errors() : {}) as Partial<Record<keyof Draft, string>>);
  protected readonly valid = computed(() => !Object.keys(this.errors()).length);

  private sub?: Subscription;

  constructor() {
    effect(() => {
      const key = this.classKey();
      untracked(() => this.load(key));
    });
  }

  protected load(key = this.classKey()) {
    this.sub?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    this.chip.set(null);
    this.sub = this.api.students(key || undefined).subscribe({
      next: ({ students }) => {
        this.students.set(students);
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected toggleChip(c: Chip) {
    this.chip.set(this.chip()?.label === c.label ? null : c);
  }

  protected add() {
    const c = this.classes().find((x) => x.key === this.classKey());
    this.draft.set({ ...EMPTY, className: c?.className ?? '', section: c?.section ?? '' });
    this.openDrawer();
  }

  protected edit(s: Student) {
    this.draft.set({
      id: s.id, rollNumber: s.rollNumber, name: s.name, className: s.className, section: s.section,
      fatherName: s.fatherName, motherName: s.motherName, parentPhone: s.parentPhone, busRoute: s.busRoute, hostel: s.hostel,
    });
    this.openDrawer();
  }

  private openDrawer() {
    this.touched.set(false);
    this.saveError.set('');
    this.drawer.set(true);
  }

  protected patch<K extends keyof Draft>(field: K, value: Draft[K]) {
    this.draft.update((d) => ({ ...d, [field]: value }));
  }

  protected save() {
    this.touched.set(true);
    if (!this.valid()) return;
    const d = this.draft();
    const body = {
      ...d,
      name: d.name.trim(),
      rollNumber: d.rollNumber.trim(),
      className: d.className.trim(),
      section: d.section.trim().toUpperCase(),
      parentPhone: d.parentPhone.replace(/[\s-]/g, ''),
    };
    this.saving.set(true);
    this.saveError.set('');
    this.api.saveStudent(body).subscribe({
      next: ({ student }) => {
        this.students.update((list) => (d.id ? list.map((s) => (s.id === student.id ? student : s)) : [student, ...list]));
        this.saving.set(false);
        this.drawer.set(false);
        this.message.set(`${student.name} ${d.id ? 'updated' : 'added'}.`);
      },
      error: (err: Error) => {
        this.saveError.set(err.message);
        this.saving.set(false);
      },
    });
  }

  protected remove(s: Student) {
    this.deleting.set(true);
    this.api.removeStudent(s.id).subscribe({
      next: () => {
        this.students.update((list) => list.filter((x) => x.id !== s.id));
        this.deleting.set(false);
        this.confirmId.set(null);
        this.message.set(`${s.name} removed.`);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.deleting.set(false);
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
    this.api.importStudents(file).subscribe({
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

  protected downloadTemplate() {
    const sample = '1,Aarav Mehta,10,A,Rakesh Mehta,Neha Mehta,9876512001,4,No';
    const url = URL.createObjectURL(new Blob([`${TEMPLATE_HEADERS}\n${sample}\n`], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'students-template.csv' });
    a.click();
    URL.revokeObjectURL(url);
  }
}
