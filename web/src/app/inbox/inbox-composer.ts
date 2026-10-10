import { HttpEventType } from '@angular/common/http';
import { Component, ElementRef, OnDestroy, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { Subscription } from 'rxjs';

import { Contact2 } from '../core/api';
import { Conversation, InboxApi, QuickTemplate } from './inbox-api';
import { kindOf } from './inbox-media';

/** What the server accepts (ALLOWED_MEDIA_TYPES in app.js); Word files are allowed there too. */
const ACCEPT = ['image/jpeg', 'image/png', 'application/pdf', 'video/mp4', 'video/3gpp',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;

interface Attachment {
  file: File;
  preview: string | null;
  progress: number;
  mediaId: string | null;
  error: string;
}

/** Reply box: text, quick replies from templates ("/" or the bolt button) and one attachment. */
@Component({
  selector: 'app-inbox-composer',
  templateUrl: './inbox-composer.html',
  styleUrl: './inbox-composer.scss',
})
export class InboxComposer implements OnDestroy {
  private readonly api = inject(InboxApi);
  private readonly box = viewChild<ElementRef<HTMLTextAreaElement>>('box');
  private readonly picker = viewChild<ElementRef<HTMLInputElement>>('picker');

  readonly conversation = input.required<Conversation>();
  readonly contact = input<Contact2 | null>(null);
  readonly name = input('');
  readonly sent = output<Conversation>();

  protected readonly accept = ACCEPT.join(',');
  protected readonly draft = signal('');
  protected readonly sending = signal(false);
  protected readonly error = signal('');
  protected readonly attachment = signal<Attachment | null>(null);
  protected readonly rows = computed(() => Math.min(6, Math.max(1, this.draft().split('\n').length)));
  protected readonly uploading = computed(() => {
    const a = this.attachment();
    return !!a && !a.mediaId && !a.error;
  });
  protected readonly canSend = computed(() => {
    const a = this.attachment();
    if (this.sending() || this.uploading() || a?.error) return false;
    return !!this.draft().trim() || !!a?.mediaId;
  });

  // Quick replies ---------------------------------------------------------
  protected readonly quickOpen = signal(false);
  protected readonly quickQuery = signal('');
  protected readonly quickIndex = signal(0);
  protected readonly templates = signal<QuickTemplate[] | null>(null);
  protected readonly templatesError = signal('');
  protected readonly matches = computed(() => {
    const q = this.quickQuery().trim().toLowerCase();
    return (this.templates() ?? [])
      .filter((t) => t.body.trim() && (!q || t.name.toLowerCase().includes(q) || t.body.toLowerCase().includes(q)))
      .slice(0, 30);
  });
  /** True while the draft is the "/query" that opened the picker, so picking replaces it. */
  protected readonly slashFilter = signal(false);
  private upload: Subscription | null = null;

  focus() {
    this.box()?.nativeElement.focus();
  }

  openQuick() {
    this.slashFilter.set(false);
    this.quickQuery.set('');
    this.showQuick();
    this.focus();
  }

  private showQuick() {
    this.quickOpen.set(true);
    this.quickIndex.set(0);
    if (this.templates() === null) {
      this.api.templates().subscribe({
        next: ({ templates }) => this.templates.set(templates),
        error: (err: Error) => {
          this.templates.set([]);
          this.templatesError.set(err.message);
        },
      });
    }
  }

  closeQuick(): boolean {
    if (!this.quickOpen()) return false;
    this.quickOpen.set(false);
    this.slashFilter.set(false);
    return true;
  }

  protected onInput(value: string) {
    this.draft.set(value);
    const slash = /^\/(\S*)$/.exec(value);
    if (slash) {
      this.slashFilter.set(true);
      this.quickQuery.set(slash[1]);
      if (!this.quickOpen()) this.showQuick();
      this.quickIndex.set(0);
    } else if (this.slashFilter()) {
      this.closeQuick();
    }
  }

  protected pick(t: QuickTemplate) {
    const text = this.fill(t.body);
    const current = this.slashFilter() ? '' : this.draft();
    this.draft.set(current.trim() ? `${current.trimEnd()} ${text}` : text);
    this.closeQuick();
    this.focus();
  }

  /** Same placeholders `personalize` substitutes: {key} and {key|fallback}. Unknown keys stay visible. */
  private fill(body: string): string {
    const c = this.contact();
    const ctx: Record<string, string> = { ...(c?.customFields ?? {}), name: c?.name || this.name(), phone: this.conversation().phone };
    return body
      .replace(/\{(\w+)\|([^{}]*)\}/g, (m, key: string, fb: string) => (key in ctx ? ctx[key] || fb : m))
      .replace(/\{(\w+)\}/g, (m, key: string) => (ctx[key] ? ctx[key] : m));
  }

  protected onKey(e: KeyboardEvent) {
    if (this.quickOpen()) {
      const n = this.matches().length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (n) this.quickIndex.update((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && n) {
        e.preventDefault();
        this.pick(this.matches()[this.quickIndex()]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeQuick();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    }
  }

  // Attachments -----------------------------------------------------------
  protected browse() {
    this.picker()?.nativeElement.click();
  }

  protected onPicked(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (file) this.attach(file);
  }

  protected onPaste(e: ClipboardEvent) {
    const file = Array.from(e.clipboardData?.files ?? [])[0];
    if (!file) return;
    e.preventDefault();
    this.attach(file);
  }

  attach(file: File) {
    this.removeAttachment();
    const problem = !ACCEPT.includes(file.type)
      ? `${file.name}: send a JPG, PNG, PDF, Word file or MP4 video.`
      : file.size > (file.type.startsWith('video/') ? MAX_VIDEO_BYTES : MAX_BYTES)
        ? `${file.name} is too big. Images and documents up to 16 MB, videos up to 64 MB.`
        : '';
    const preview = !problem && kindOf(file.type) === 'image' ? URL.createObjectURL(file) : null;
    this.attachment.set({ file, preview, progress: 0, mediaId: null, error: problem });
    if (problem) return;
    this.upload = this.api.upload(file).subscribe({
      next: (event) => {
        if (event.type === HttpEventType.UploadProgress) {
          const pct = event.total ? Math.round((event.loaded / event.total) * 100) : 50;
          this.patch({ progress: Math.min(99, pct) });
        } else if (event.type === HttpEventType.Response && event.body) {
          this.patch({ progress: 100, mediaId: event.body.mediaId });
        }
      },
      error: (err: Error) => this.patch({ error: err.message }),
    });
    this.focus();
  }

  protected retryUpload() {
    const a = this.attachment();
    if (a) this.attach(a.file);
  }

  removeAttachment() {
    this.upload?.unsubscribe();
    this.upload = null;
    const a = this.attachment();
    if (a?.preview) URL.revokeObjectURL(a.preview);
    this.attachment.set(null);
  }

  private patch(change: Partial<Attachment>) {
    this.attachment.update((a) => (a ? { ...a, ...change } : a));
  }

  /** A validation failure will fail again; a network or server one may not. */
  protected retryable(a: Attachment) {
    return ACCEPT.includes(a.file.type) && a.file.size <= MAX_VIDEO_BYTES;
  }

  protected kind(file: File) {
    return kindOf(file.type);
  }

  protected size(bytes: number): string {
    return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  // Send ------------------------------------------------------------------
  send() {
    if (!this.canSend()) return;
    const c = this.conversation();
    this.sending.set(true);
    this.error.set('');
    this.api.reply(c.id, this.draft().trim(), this.attachment()?.mediaId ?? null).subscribe({
      next: ({ conversation }) => {
        this.sending.set(false);
        this.draft.set('');
        this.removeAttachment();
        this.sent.emit(conversation);
        this.focus();
      },
      error: (err: Error) => {
        this.sending.set(false);
        this.error.set(err.message);
      },
    });
  }

  ngOnDestroy() {
    this.removeAttachment();
  }
}
