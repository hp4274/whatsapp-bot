import { DatePipe } from '@angular/common';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { Store } from '../../core/store';
import { FormsModule } from '@angular/forms';

import { Audience, ClassInfo, Notice, NoticeKind, SchoolApi, SchoolArea, SchoolMe } from '../school-api';
import { Tilt } from '../tilt';

type AudienceMode = 'all' | 'classes' | 'routes';

export const KINDS: { id: NoticeKind; label: string; icon: string; tone: string }[] = [
  { id: 'circular', label: 'Circular', icon: 'description', tone: 'info' },
  { id: 'holiday', label: 'Holiday', icon: 'beach_access', tone: 'ok' },
  { id: 'event', label: 'Event', icon: 'celebration', tone: 'warn' },
  { id: 'exam', label: 'Exam date sheet', icon: 'quiz', tone: 'bad' },
];

@Component({
  selector: 'school-notices',
  imports: [FormsModule, DatePipe, Tilt],
  templateUrl: './notices.html',
  styleUrl: './notices.scss',
})
export class NoticesTab {
  private readonly api = inject(SchoolApi);
  private readonly store = inject(Store);

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  protected readonly kinds = KINDS;
  protected readonly kind = signal<NoticeKind>('circular');
  protected readonly title = signal('');
  protected readonly body = signal('');
  protected readonly startsAt = signal('');
  protected readonly endsAt = signal('');
  protected readonly file = signal<{ name: string; mediaId: string } | null>(null);
  protected readonly uploading = signal(false);
  protected readonly audMode = signal<AudienceMode>('all');
  protected readonly pickedClasses = signal<string[]>([]);
  protected readonly routes = signal<string[]>([]);
  protected readonly routeDraft = signal('');
  protected readonly broadcast = signal(true);
  protected readonly scheduled = signal(false);
  protected readonly sendAt = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly flash = signal('');

  protected readonly notices = signal<Notice[]>([]);
  protected readonly loading = signal(true);
  protected readonly filter = signal<NoticeKind | ''>('');

  protected readonly filtered = computed(() => {
    const f = this.filter();
    return f ? this.notices().filter((n) => n.kind === f) : this.notices();
  });
  protected readonly upcoming = computed(() => {
    const today = new Date().toISOString().slice(0, 10);
    return this.notices()
      .filter((n) => n.kind !== 'circular' && n.startsAt && (n.endsAt || n.startsAt).slice(0, 10) >= today)
      .sort((a, b) => a.startsAt!.localeCompare(b.startsAt!));
  });
  protected readonly audience = computed<Audience | null>(() => {
    switch (this.audMode()) {
      case 'all': return { all: true };
      case 'classes': return this.pickedClasses().length ? { classKeys: this.pickedClasses() } : null;
      case 'routes': return this.routes().length ? { routes: this.routes() } : null;
    }
  });
  protected readonly valid = computed(() => !!(this.title().trim() && this.body().trim() && this.audience()));

  constructor() {
    this.load();
    this.store.watch(['school', 'objects'], () => this.load(true));
  }

  private load(quiet = false) {
    if (!quiet) this.loading.set(true);
    this.api.notices().subscribe({
      next: (r) => { this.notices.set(r.notices); this.loading.set(false); },
      error: (e: Error) => { this.error.set(e.message); this.loading.set(false); },
    });
  }

  protected kindOf(id: NoticeKind) { return KINDS.find((k) => k.id === id)!; }

  protected toggleClass(key: string, on: boolean) {
    this.pickedClasses.update((l) => (on ? [...l, key] : l.filter((k) => k !== key)));
  }

  protected addRoute() {
    const r = this.routeDraft().trim();
    if (r && !this.routes().includes(r)) this.routes.update((l) => [...l, r]);
    this.routeDraft.set('');
  }

  protected removeRoute(r: string) { this.routes.update((l) => l.filter((x) => x !== r)); }

  protected audienceLabel(a: Audience) {
    if ('all' in a) return 'All parents';
    if ('classKeys' in a) return a.classKeys.join(', ');
    return 'Routes ' + a.routes.join(', ');
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

  protected publish() {
    const audience = this.audience();
    if (!this.valid() || !audience || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.flash.set('');
    this.api.publishNotice({
      kind: this.kind(),
      title: this.title().trim(),
      body: this.body().trim(),
      startsAt: this.startsAt() || null,
      endsAt: this.endsAt() || null,
      audience,
      mediaId: this.file()?.mediaId ?? null,
      broadcast: this.broadcast(),
      sendAt: this.broadcast() && this.scheduled() && this.sendAt() ? new Date(this.sendAt()).toISOString() : null,
    }).subscribe({
      next: (r) => {
        this.notices.update((l) => [r.notice, ...l]);
        this.flash.set(
          r.sent !== undefined
            ? `Published - ${r.sent} sent, ${r.skipped ?? 0} skipped, ${r.failed ?? 0} failed.`
            : this.broadcast() && this.scheduled() ? 'Published and scheduled.' : 'Published to the archive.',
        );
        this.title.set('');
        this.body.set('');
        this.file.set(null);
        this.busy.set(false);
      },
      error: (e: Error) => { this.error.set(e.message); this.busy.set(false); },
    });
  }

  protected remove(n: Notice) {
    this.api.removeNotice(n.id).subscribe({
      next: () => this.notices.update((l) => l.filter((x) => x.id !== n.id)),
      error: (e: Error) => this.error.set(e.message),
    });
  }
}
