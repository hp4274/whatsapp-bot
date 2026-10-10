import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Store } from '../../core/store';
import { SchoolApi } from '../school-api';
import type {
  ClassInfo,
  ExamResult,
  ImportResult,
  SchoolArea,
  SchoolMe,
  SendResult,
} from '../school-api';

/**
 * Exam results: import a marksheet CSV, review the numbers, then dispatch each
 * parent only their own child's result. Dispatch is two-step (first press arms
 * the button) because it messages every parent in the selection at once.
 */
@Component({
  selector: 'school-results',
  imports: [FormsModule, DatePipe],
  templateUrl: './results.html',
  styleUrl: './results.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultsTab {
  private readonly api = inject(SchoolApi);
  private readonly store = inject(Store);

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  // upload
  protected readonly upExam = signal('');
  protected readonly upClass = signal('');
  protected readonly upFile = signal<File | null>(null);
  protected readonly uploading = signal(false);
  protected readonly importResult = signal<ImportResult | null>(null);

  // view
  protected readonly cls = signal('');
  protected readonly exam = signal('');
  protected readonly exams = signal<string[]>([]);
  protected readonly results = signal<ExamResult[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly dispatching = signal(false);
  protected readonly confirmDispatch = signal(false);
  protected readonly dispatchResult = signal<SendResult | null>(null);

  protected readonly subjects = computed(() => {
    const seen = new Set<string>();
    for (const r of this.results()) for (const b of r.breakdown) seen.add(b.subject);
    return [...seen];
  });
  protected readonly pending = computed(() => this.results().filter((r) => !r.dispatchedAt).length);
  protected readonly sample = computed(() => {
    const r = this.results()[0];
    if (!r) return '';
    const lines = r.breakdown.map((b) => `${b.subject}: ${b.marks}/${b.total}`).join('\n');
    return `Result - ${r.examName}\n${r.studentName} (${r.classKey}, Roll ${r.rollNumber})\n\n${lines}\n\nTotal: ${r.marks}/${r.totalMarks} · Grade ${r.grade}`;
  });

  constructor() {
    effect(() => {
      const k = this.classKey() || this.classes()[0]?.key || '';
      this.cls.set(k);
      this.upClass.set(k);
    });
    effect(() => this.load(this.cls(), this.exam()));
    this.store.watch(['school', 'objects'], () => this.load(this.cls(), this.exam(), true));
  }

  /** `quiet` skips the skeleton for background refreshes. */
  protected load(cls: string, exam: string, quiet = false) {
    if (!quiet) this.loading.set(true);
    this.api.results({ class: cls || undefined, exam: exam || undefined }).subscribe({
      next: (r) => {
        this.exams.set(r.exams);
        this.results.set(r.results);
        if (!exam && r.exams.length) this.exam.set(r.exams[0]);
        this.loading.set(false);
      },
      error: (e: Error) => {
        this.error.set(e.message);
        this.loading.set(false);
      },
    });
  }

  protected mark(r: ExamResult, subject: string) {
    const b = r.breakdown.find((x) => x.subject === subject);
    return b ? `${b.marks}` : '-';
  }

  protected pick(event: Event) {
    const input = event.target as HTMLInputElement;
    this.upFile.set(input.files?.[0] ?? null);
    input.value = '';
  }

  protected upload() {
    const f = this.upFile();
    if (!f || !this.upExam().trim() || !this.upClass()) return;
    this.uploading.set(true);
    this.error.set('');
    this.importResult.set(null);
    this.api.importResults(f, this.upExam().trim(), this.upClass()).subscribe({
      next: (r) => {
        this.importResult.set(r);
        this.uploading.set(false);
        this.upFile.set(null);
        this.cls.set(this.upClass());
        this.exam.set(this.upExam().trim());
      },
      error: (e: Error) => {
        this.error.set(e.message);
        this.uploading.set(false);
      },
    });
  }

  protected dispatch() {
    if (!this.confirmDispatch()) {
      this.confirmDispatch.set(true);
      setTimeout(() => this.confirmDispatch.set(false), 4000);
      return;
    }
    this.confirmDispatch.set(false);
    this.dispatching.set(true);
    this.error.set('');
    this.api
      .dispatchResults({ examName: this.exam(), classKey: this.cls() || undefined })
      .subscribe({
        next: (r) => {
          this.dispatchResult.set(r);
          this.dispatching.set(false);
          this.load(this.cls(), this.exam());
        },
        error: (e: Error) => {
          this.error.set(e.message);
          this.dispatching.set(false);
        },
      });
  }
}
