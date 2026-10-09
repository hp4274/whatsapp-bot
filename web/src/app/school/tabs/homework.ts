import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { Store } from '../../core/store';
import { FormsModule } from '@angular/forms';

import { ClassInfo, Homework, SchoolApi, SchoolArea, SchoolMe } from '../school-api';

@Component({
  selector: 'school-homework',
  imports: [FormsModule, DatePipe],
  templateUrl: './homework.html',
  styleUrl: './homework.scss',
})
export class HomeworkTab {
  private readonly api = inject(SchoolApi);
  private readonly store = inject(Store);

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  protected readonly cls = signal('');
  protected readonly subject = signal('');
  protected readonly title = signal('');
  protected readonly instructions = signal('');
  protected readonly dueAt = signal('');
  protected readonly mode = signal<'now' | 'schedule'>('now');
  protected readonly sendTime = signal('16:00');
  protected readonly file = signal<{ name: string; mediaId: string } | null>(null);
  protected readonly uploading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly flash = signal('');

  protected readonly list = signal<Homework[]>([]);
  protected readonly loading = signal(true);
  protected readonly removing = signal<number | null>(null);

  protected readonly valid = computed(() => !!(this.cls() && this.subject().trim() && this.title().trim()));
  protected readonly preview = computed(() => {
    const due = this.dueAt() ? new Date(this.dueAt() + 'T00:00').toDateString() : 'not set';
    const extra = this.instructions().trim() ? ` ${this.instructions().trim()}` : '';
    return `Homework for ${this.cls() || '{class}'} - ${this.subject().trim() || '{subject}'}: ${this.title().trim() || '{title}'}.${extra} Due: ${due}.`;
  });

  constructor() {
    effect(() => {
      const key = this.classKey() || this.classes()[0]?.key || '';
      this.cls.set(key);
    });
    effect(() => this.load(this.cls()));
    this.store.watch(['school', 'objects'], () => this.load(this.cls(), true));
    this.api.settings().subscribe({ next: (r) => r.settings.homeworkSendTime && this.sendTime.set(r.settings.homeworkSendTime), error: () => {} });
  }

  private load(key: string, quiet = false) {
    if (!quiet) this.loading.set(true);
    this.api.homework(key || undefined).subscribe({
      next: (r) => { this.list.set(r.homework); this.loading.set(false); },
      error: (e: Error) => { this.error.set(e.message); this.loading.set(false); },
    });
  }

  protected pick(event: Event) {
    const input = event.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    this.uploading.set(true);
    this.error.set('');
    this.api.uploadMedia(f).subscribe({
      next: (r) => { this.file.set({ name: f.name, mediaId: r.mediaId }); this.uploading.set(false); },
      error: (e: Error) => { this.error.set(e.message); this.uploading.set(false); },
    });
  }

  protected publish() {
    if (!this.valid() || this.busy()) return;
    let sendAt: string | null = null;
    if (this.mode() === 'schedule') {
      const [h, m] = this.sendTime().split(':').map(Number);
      const d = new Date();
      d.setHours(h, m, 0, 0);
      sendAt = d.toISOString();
    }
    this.busy.set(true);
    this.error.set('');
    this.api.publishHomework({
      classKey: this.cls(),
      subject: this.subject().trim(),
      title: this.title().trim(),
      instructions: this.instructions().trim(),
      dueAt: this.dueAt() || null,
      mediaId: this.file()?.mediaId ?? null,
      sendAt,
    }).subscribe({
      next: (r) => {
        this.list.update((l) => [r.homework, ...l]);
        this.flash.set(sendAt ? `Scheduled for ${this.sendTime()} today.` : 'Sent to parents on WhatsApp.');
        this.title.set('');
        this.instructions.set('');
        this.file.set(null);
        this.busy.set(false);
      },
      error: (e: Error) => { this.error.set(e.message); this.busy.set(false); },
    });
  }

  protected remove(h: Homework) {
    this.removing.set(h.id);
    this.api.removeHomework(h.id).subscribe({
      next: () => { this.list.update((l) => l.filter((x) => x.id !== h.id)); this.removing.set(null); },
      error: (e: Error) => { this.error.set(e.message); this.removing.set(null); },
    });
  }
}
