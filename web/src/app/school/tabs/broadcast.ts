import { Component, OnDestroy, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Audience, BroadcastKind, ClassInfo, SchoolApi, SchoolArea, SchoolMe, SendResult } from '../school-api';
import { Tilt } from '../tilt';

const KINDS: { id: BroadcastKind; label: string; icon: string; tone: string; blurb: string }[] = [
  { id: 'emergency', label: 'Emergency closure', icon: 'emergency_home', tone: 'bad', blurb: 'Weather, safety or sudden closures.' },
  { id: 'bus', label: 'Bus delay', icon: 'airport_shuttle', tone: 'warn', blurb: 'Late pick-up or changed drop times.' },
  { id: 'general', label: 'General', icon: 'campaign', tone: 'info', blurb: 'Important updates for families.' },
];

const TEMPLATES: { label: string; kind: BroadcastKind; text: string }[] = [
  { label: 'Heavy rain closure', kind: 'emergency', text: 'Due to heavy rain, school will remain closed today. Stay safe. Classes resume as normal once the weather clears - we will confirm on WhatsApp.' },
  { label: 'Bus running late', kind: 'bus', text: 'The school bus is running late by about 15 minutes today. Please wait at your usual stop. We apologise for the delay.' },
  { label: 'School reopens', kind: 'general', text: 'School reopens on Monday, [date]. Regular timings and transport will resume. See you there!' },
];

@Component({
  selector: 'school-broadcast',
  imports: [FormsModule, Tilt],
  templateUrl: './broadcast.html',
  styleUrl: './broadcast.scss',
})
export class BroadcastTab implements OnDestroy {
  private readonly api = inject(SchoolApi);

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  protected readonly kinds = KINDS;
  protected readonly templates = TEMPLATES;
  protected readonly kind = signal<BroadcastKind>('emergency');
  protected readonly message = signal('');
  protected readonly audMode = signal<'all' | 'classes' | 'routes'>('all');
  protected readonly pickedClasses = signal<string[]>([]);
  protected readonly pickedRoutes = signal<string[]>([]);
  protected readonly routes = signal<string[]>([]);
  protected readonly routesLoading = signal(true);
  protected readonly file = signal<{ name: string; mediaId: string } | null>(null);
  protected readonly uploading = signal(false);
  protected readonly arming = signal(false);
  protected readonly sending = signal(false);
  protected readonly result = signal<SendResult | null>(null);
  protected readonly error = signal('');
  private armTimer?: ReturnType<typeof setTimeout>;

  protected readonly current = computed(() => KINDS.find((k) => k.id === this.kind())!);
  protected readonly audience = computed<Audience | null>(() => {
    if (this.audMode() === 'all') return { all: true };
    if (this.audMode() === 'classes') return this.pickedClasses().length ? { classKeys: this.pickedClasses() } : null;
    return this.pickedRoutes().length ? { routes: this.pickedRoutes() } : null;
  });
  protected readonly groups = computed(() => {
    const a = this.audience();
    if (!a) return 0;
    if ('all' in a) return this.classes().length || 1;
    return 'classKeys' in a ? a.classKeys.length : a.routes.length;
  });
  protected readonly groupLabel = computed(() => (this.audMode() === 'all' ? 'all parents' : `${this.groups()} group${this.groups() === 1 ? '' : 's'}`));
  protected readonly ready = computed(() => !!(this.message().trim() && this.audience()));

  constructor() {
    this.api.students().subscribe({
      next: (r) => {
        this.routes.set([...new Set(r.students.map((s) => s.busRoute).filter(Boolean))].sort());
        this.routesLoading.set(false);
      },
      error: (e: Error) => { this.error.set(e.message); this.routesLoading.set(false); },
    });
  }

  ngOnDestroy() { clearTimeout(this.armTimer); }

  protected useTemplate(t: (typeof TEMPLATES)[number]) {
    this.kind.set(t.kind);
    this.message.set(t.text);
  }

  protected toggle(list: 'pickedClasses' | 'pickedRoutes', key: string, on: boolean) {
    this[list].update((l) => (on ? [...l, key] : l.filter((k) => k !== key)));
  }

  protected pick(event: Event) {
    const input = event.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    this.uploading.set(true);
    this.api.uploadMedia(f).subscribe({
      next: (r) => { this.file.set({ name: f.name, mediaId: r.mediaId }); this.uploading.set(false); },
      error: (e: Error) => { this.error.set(e.message); this.uploading.set(false); },
    });
  }

  /** Two-step send: the first press arms the button for four seconds. */
  protected send() {
    const audience = this.audience();
    if (!this.ready() || !audience || this.sending()) return;
    if (!this.arming()) {
      this.arming.set(true);
      clearTimeout(this.armTimer);
      this.armTimer = setTimeout(() => this.arming.set(false), 4000);
      return;
    }
    clearTimeout(this.armTimer);
    this.arming.set(false);
    this.sending.set(true);
    this.error.set('');
    this.result.set(null);
    this.api.broadcast({ kind: this.kind(), message: this.message().trim(), audience, mediaId: this.file()?.mediaId ?? null }).subscribe({
      next: (r) => { this.result.set(r); this.sending.set(false); },
      error: (e: Error) => { this.error.set(e.message); this.sending.set(false); },
    });
  }
}
