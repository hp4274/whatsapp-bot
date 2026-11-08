import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { DomSanitizer } from '@angular/platform-browser';
import type { SafeHtml } from '@angular/platform-browser';
import type { Subscription } from 'rxjs';

import { ConfirmDialog } from '../core/confirm-dialog';
import { AdminFeed } from './admin-feed';
import { AudiencePicker, insertWord } from './audience-picker';
import { WapzoApi } from './wapzo-api';
import type { AutomaticEmail, EmailLogEntry, EmailTemplate, WapzoBroadcastResult } from './wapzo-api';

/** The words an email fills in per person (server app.js /wapzo/email/send). */
const WORDS: readonly string[] = ['name', 'business', 'email'];

const STATUS: Readonly<Record<EmailLogEntry['status'], { readonly label: string; readonly tone: string }>> = {
  queued: { label: 'Waiting', tone: 'tone-info' },
  sent: { label: 'Sent', tone: 'tone-ok' },
  failed: { label: 'Failed', tone: 'tone-bad' },
};

/** Typing pauses this long before the preview is rendered again. */
const PREVIEW_MS = 400;

/** The template open in the drawer; `id` is null for a new one. */
interface Draft {
  readonly id: number | null;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * Wuzie's own email: one message to many clients, written here or started from a saved template. The server queues
 * it and sends one at a time, so the page returns at once and the log below fills in live. The page also lists the
 * emails Wuzie sends by itself; those are fixed in the server and shown here to read, not to edit.
 */
@Component({
  selector: 'app-wuzie-email',
  imports: [AudiencePicker, ConfirmDialog, DatePipe],
  templateUrl: './wuzie-email.html',
  styleUrl: './wuzie-email.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'closeDrawers()' },
})
export class WuzieEmail {
  private readonly api = inject(WapzoApi);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly picker = viewChild.required(AudiencePicker);
  private readonly nameBox = viewChild<ElementRef<HTMLInputElement>>('nameBox');
  private readonly closeView = viewChild<ElementRef<HTMLButtonElement>>('closeView');

  protected readonly words = WORDS;
  protected readonly loading = signal(true);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal('');
  protected readonly configured = signal(false);
  protected readonly from = signal<string | null>(null);
  protected readonly templates = signal<readonly EmailTemplate[]>([]);
  protected readonly log = signal<readonly EmailLogEntry[]>([]);
  protected readonly automatic = signal<readonly AutomaticEmail[]>([]);
  /** The automatic email open in the drawer, and its sample once it has loaded. */
  protected readonly viewing = signal<AutomaticEmail | null>(null);
  protected readonly sample = signal<{ readonly subject: string; readonly html: SafeHtml } | null>(null);
  protected readonly sampleError = signal('');
  private sampleCall?: Subscription;

  protected readonly subject = signal('');
  protected readonly body = signal('');
  protected readonly templateId = signal<number | null>(null);
  protected readonly preview = signal<SafeHtml | null>(null);
  protected readonly busy = signal(false);
  protected readonly confirming = signal(false);
  protected readonly error = signal('');
  protected readonly result = signal<WapzoBroadcastResult | null>(null);

  protected readonly editing = signal<Draft | null>(null);
  protected readonly saving = signal(false);
  protected readonly editorError = signal('');
  protected readonly deleting = signal<EmailTemplate | null>(null);
  protected readonly listError = signal('');

  protected readonly ready = computed(
    () => this.configured() && !this.busy() && !!this.subject().trim() && !!this.body().trim() && this.picker().choice().count > 0,
  );
  protected readonly canSaveDraft = computed(() => {
    const d = this.editing();
    return !!d && !this.saving() && !!d.name.trim() && !!d.subject.trim() && !!d.body.trim();
  });

  constructor() {
    this.load();
    // Each email sent moves the log on, and a template saved elsewhere shows at once.
    inject(AdminFeed).watch(['wuzie_email'], () => this.load());
    effect(() => this.nameBox()?.nativeElement.focus());
    effect(() => this.closeView()?.nativeElement.focus());
    effect((onCleanup) => {
      const subject = this.subject().trim();
      const body = this.body().trim();
      const business = this.picker().choice().first ?? '';
      if (!subject && !body) {
        this.preview.set(null);
        return;
      }
      let call: Subscription | undefined;
      const timer = setTimeout(() => {
        call = this.api.emailPreview({ subject, body, business }).subscribe({
          // The server escapes everything typed, and the frame has an empty sandbox, so nothing in it can run.
          next: ({ html }) => this.preview.set(this.sanitizer.bypassSecurityTrustHtml(html)),
          error: () => this.preview.set(null),
        });
      }, PREVIEW_MS);
      onCleanup(() => {
        clearTimeout(timer);
        call?.unsubscribe();
      });
    });
  }

  protected load(): void {
    this.api.emailOverview().subscribe({
      next: (data) => {
        this.configured.set(data.configured);
        this.from.set(data.from);
        this.templates.set(data.templates);
        this.log.set(data.log);
        this.automatic.set(data.automatic);
        this.loadError.set('');
        this.loading.set(false);
        this.loaded.set(true);
      },
      error: (err: Error) => {
        this.loadError.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected view(email: AutomaticEmail): void {
    this.viewing.set(email);
    this.sample.set(null);
    this.sampleError.set('');
    this.sampleCall?.unsubscribe();
    this.sampleCall = this.api.automaticEmail(email.kind).subscribe({
      // Built by the server from sample details, and the frame has an empty sandbox, so nothing in it can run.
      next: ({ subject, html }) => this.sample.set({ subject, html: this.sanitizer.bypassSecurityTrustHtml(html) }),
      error: (err: Error) => this.sampleError.set(err.message),
    });
  }

  protected closeDrawers(): void {
    this.editing.set(null);
    this.viewing.set(null);
  }

  protected status(entry: EmailLogEntry): { readonly label: string; readonly tone: string } {
    return STATUS[entry.status];
  }

  /** "Blank email" empties the form; a template fills it. */
  protected useTemplate(value: string): void {
    const template = this.templates().find((t) => t.id === Number(value));
    this.templateId.set(template?.id ?? null);
    this.subject.set(template?.subject ?? '');
    this.body.set(template?.body ?? '');
  }

  protected insert(box: HTMLTextAreaElement, word: string): void {
    this.body.set(insertWord(box, word));
  }

  protected send(): void {
    const choice = this.picker().choice();
    this.confirming.set(false);
    this.busy.set(true);
    this.error.set('');
    this.result.set(null);
    this.api
      .sendEmail({ subject: this.subject().trim(), body: this.body().trim(), tenants: choice.tenants, leads: choice.leads, emails: choice.typed })
      .subscribe({
        next: (result) => {
          this.busy.set(false);
          this.result.set(result);
          if (result.queued) this.useTemplate('');
          this.load();
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message);
        },
      });
  }

  protected newTemplate(): void {
    this.openDraft({ id: null, name: '', subject: '', body: '' });
  }

  /** What is written above becomes a template, so a good email is not typed twice. */
  protected saveAsTemplate(): void {
    this.openDraft({ id: null, name: '', subject: this.subject().trim(), body: this.body().trim() });
  }

  protected edit(t: EmailTemplate): void {
    this.openDraft({ id: t.id, name: t.name, subject: t.subject, body: t.body });
  }

  private openDraft(draft: Draft): void {
    this.editorError.set('');
    this.editing.set(draft);
  }

  protected patch(change: Partial<Draft>): void {
    this.editing.update((d) => (d ? { ...d, ...change } : d));
  }

  protected insertInDraft(box: HTMLTextAreaElement, word: string): void {
    this.patch({ body: insertWord(box, word) });
  }

  protected saveDraft(): void {
    const draft = this.editing();
    if (!draft || !this.canSaveDraft()) return;
    this.saving.set(true);
    this.editorError.set('');
    this.api.saveEmailTemplate(draft.id, { name: draft.name, subject: draft.subject, body: draft.body }).subscribe({
      next: () => {
        this.saving.set(false);
        this.editing.set(null);
        this.load();
      },
      error: (err: Error) => {
        this.saving.set(false);
        this.editorError.set(err.message);
      },
    });
  }

  protected remove(t: EmailTemplate): void {
    this.deleting.set(null);
    this.listError.set('');
    this.api.deleteEmailTemplate(t.id).subscribe({
      next: () => {
        if (this.templateId() === t.id) this.templateId.set(null);
        this.load();
      },
      error: (err: Error) => this.listError.set(err.message),
    });
  }
}
