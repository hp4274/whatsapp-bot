import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { Api, type UploadedMedia } from '../../core/api';
import { ReusePicker } from '../../storage/reuse-picker';
import { StorageApi, type StorageUse } from '../../storage/storage-api';
import { shortDate } from '../../storage/storage-format';
import { Template, TemplatesApi } from '../../templates/templates-api';
import { InteractiveEditor } from '../interactive/interactive-editor';
import { CampaignDraft } from '../draft';
import { CampaignPolicy } from '../policy-api';
import { MetaParams } from './meta-params';
import { ReplyRulesEditor } from '../interactive/reply-rules-editor';
import { formatBytes, substitute } from '../wa-format';

/** Media types WhatsApp accepts as an attachment; the server checks the same list. */
const ALLOWED = [
  'image/jpeg',
  'image/png',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'video/mp4',
  'video/3gpp',
];
/** Where "Send a test" remembers the number. */
const TEST_PHONE_KEY = 'wsender.testPhone';

function readTestPhone(): string {
  try {
    return localStorage.getItem(TEST_PHONE_KEY) ?? '';
  } catch {
    return '';
  }
}
/** Inserted by the Spintax button: a working example the user edits in place. */
const SPIN_SAMPLE = '{Hi|Hello|Hey}';

/**
 * Step 1 (bottom half): the message itself — free-form text with WhatsApp formatting and
 * variables, or (on Cloud API) a Meta-approved template mapped to columns.
 * Optional extras (backup template, buttons) fold away so the main
 * path stays short.
 */
@Component({
  selector: 'app-message-step',
  imports: [
    FormsModule,
    RouterLink,
    InteractiveEditor,
    MetaParams,
    ReusePicker,
    ReplyRulesEditor,
  ],
  templateUrl: './message-step.html',
  styleUrl: './message-step.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageStep {
  protected readonly draft = inject(CampaignDraft);
  private readonly api = inject(Api);
  private readonly templatesApi = inject(TemplatesApi);
  private readonly storage = inject(StorageApi);
  /** Interactive buttons can be off on the plan; the editor is then replaced by a note. */
  protected readonly policy = inject(CampaignPolicy);
  private readonly editor = viewChild<ElementRef<HTMLTextAreaElement>>('editor');

  protected readonly uploading = signal(false);
  protected readonly error = signal('');
  protected readonly spinHelp = signal(false);
  /** First-upload time of the attachment when identical bytes were already stored; else null. */
  protected readonly duplicateOf = signal<string | null>(null);
  protected readonly date = shortDate;

  /** Approved Meta templates (Cloud API channels only), loaded once on demand. */
  protected readonly approved = signal<Template[] | null>(null);
  protected readonly templatesError = signal('');

  /** Saved templates for the picker; null until loaded. */
  protected readonly saved = signal<Template[] | null>(null);
  protected readonly savedError = signal('');
  protected readonly savedNote = signal('');
  /** The "Save as template" name box: null while closed. */
  protected readonly savingName = signal<string | null>(null);
  protected readonly saving = signal(false);

  protected readonly testPhone = signal(readTestPhone());
  protected readonly testing = signal(false);
  protected readonly testResult = signal<{ ok: boolean; text: string } | null>(null);

  constructor() {
    this.policy.load();
    this.loadSaved();
    effect(() => {
      if (this.draft.cloudApi() && untracked(this.approved) === null)
        untracked(() => this.loadTemplates());
    });
  }

  /** Also the error banner's Try again. */
  protected loadTemplates(): void {
    this.approved.set([]);
    this.templatesApi.list().subscribe({
      next: ({ templates }) => {
        this.approved.set(
          templates.filter((t) => t.approvalStatus === 'approved' && t.providerTemplateName),
        );
        this.templatesError.set('');
      },
      error: (err: Error) => this.templatesError.set(`Could not load templates: ${err.message}`),
    });
  }

  /** Also the picker's Try again. */
  protected loadSaved(): void {
    this.savedError.set('');
    this.templatesApi.list().subscribe({
      next: ({ templates }) =>
        this.saved.set(templates.filter((t) => t.templateType !== 'provider_template' && t.body)),
      error: (err: Error) => {
        this.saved.set([]);
        this.savedError.set(`Could not load saved templates: ${err.message}`);
      },
    });
  }

  /** Same fill as the ?template= link: message, buttons and attachment. */
  protected useSaved(select: HTMLSelectElement): void {
    const t = this.saved()?.find((x) => String(x.id) === select.value);
    select.value = '';
    if (!t) return;
    this.draft.message.set(t.body);
    this.draft.templateId.set(t.id);
    this.draft.interactive.set(t.interactive ?? null);
    if (t.headerMediaId) {
      this.draft.setAttachment({
        mediaId: t.headerMediaId,
        filename: 'Template attachment',
        mimetype: '',
        size: 0,
        previewUrl: '',
      });
    }
    this.savedNote.set(`Loaded "${t.name}".`);
  }

  protected saveAsTemplate(): void {
    const name = (this.savingName() ?? '').trim();
    if (!name) return;
    const d = this.draft;
    this.saving.set(true);
    this.savedNote.set('');
    this.templatesApi
      .create({
        name,
        templateType: d.interactive() ? 'interactive' : d.attachment() ? 'media' : 'text',
        body: d.message(),
        // The templates check also reads a word-choice group such as {Hello|Hey} as a
        // placeholder, so every braced word in the body is declared or the save is refused.
        variables: [
          ...new Set([
            ...d.usedVariables(),
            ...[...d.message().matchAll(/\{(\w+)(?:\|[^{}]*)?\}/g)].map((m) => m[1]),
          ]),
        ],
        providerTemplateName: '',
        approvalStatus: 'draft',
        category: 'marketing',
        sampleValues: {},
        headerMediaId: d.attachment()?.mediaId ?? null,
        interactive: d.interactive(),
      })
      .subscribe({
        next: ({ template }) => {
          this.saving.set(false);
          this.savingName.set(null);
          this.saved.update((list) => [template, ...(list ?? [])]);
          this.savedNote.set(`Saved as "${template.name}".`);
        },
        error: (err: Error) => {
          this.saving.set(false);
          this.savedNote.set('');
          this.savedError.set(`Could not save the template: ${err.message}`);
        },
      });
  }

  /** Sends the message as the previewed contact would get it, to the typed number. */
  protected sendTest(): void {
    const phone = this.testPhone().trim();
    if (!phone) return;
    try {
      localStorage.setItem(TEST_PHONE_KEY, phone);
    } catch {
      // Private mode: the number is just not remembered.
    }
    const d = this.draft;
    // The version on screen, so each A/B text can be tried on a real phone.
    const text = substitute(d.previewText(), d.previewContext(), d.fallbacks(), d.seed()).text;
    this.testing.set(true);
    this.testResult.set(null);
    this.api
      .sendMessage(phone, text, '', {
        mediaId: d.attachment()?.mediaId ?? null,
        interactive: d.interactive(),
      })
      .subscribe({
        next: ({ recipient }) => {
          this.testing.set(false);
          this.testResult.set({ ok: true, text: `Test sent to +${recipient}.` });
        },
        error: (err: Error) => {
          this.testing.set(false);
          this.testResult.set({ ok: false, text: `Test not sent: ${err.message}` });
        },
      });
  }

  protected pick(id: string, which: 'main' | 'fallback'): void {
    this.draft.pickMetaTemplate(this.approved()?.find((t) => String(t.id) === id) ?? null, which);
  }

  protected label(t: Template): string {
    return `${t.name} - ${t.language || 'en_US'} - ${t.category}`;
  }

  /** Toolbar buttons: WhatsApp's own markdown markers, not HTML. */
  protected readonly formats = [
    { marker: '*', icon: 'bold', label: 'Bold' },
    { marker: '_', icon: 'italic', label: 'Italic' },
    { marker: '~', icon: 'strikethrough', label: 'Strikethrough' },
    { marker: '```', icon: 'code', label: 'Monospace' },
  ];

  /** Wrap the selection (or a placeholder word) in WhatsApp markers. */
  protected wrap(marker: string): void {
    const el = this.editor()?.nativeElement;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e, value } = el;
    const picked = value.slice(s, e) || 'text';
    this.apply(
      value.slice(0, s) + marker + picked + marker + value.slice(e),
      s + marker.length,
      s + marker.length + picked.length,
    );
  }

  /** Insert text at the caret. */
  protected insert(text: string): void {
    const el = this.editor()?.nativeElement;
    const value = this.draft.activeMessage();
    if (!el) {
      this.draft.setActiveMessage(value + text);
      return;
    }
    const s = el.selectionStart ?? value.length;
    const e = el.selectionEnd ?? value.length;
    const caret = s + text.length;
    this.apply(value.slice(0, s) + text + value.slice(e), caret, caret);
  }

  protected insertVar(slug: string): void {
    this.insert(`{${slug}}`);
  }

  protected insertSpin(): void {
    this.insert(SPIN_SAMPLE);
  }

  private apply(next: string, from: number, to: number): void {
    this.draft.setActiveMessage(next);
    const el = this.editor()?.nativeElement;
    if (!el) return;
    el.value = next;
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(from, to);
    });
  }

  /** Turn the A/B test on (and start writing version B) or off (version A, the main message, stays). */
  protected setAb(on: boolean): void {
    const d = this.draft;
    d.variantB.set(on ? '' : null);
    d.variantC.set(null);
    d.activeVersion.set(on ? 'B' : 'A');
  }

  protected addVersionC(): void {
    this.draft.variantC.set('');
    this.draft.activeVersion.set('C');
  }

  protected removeVersionC(): void {
    this.draft.variantC.set(null);
    this.draft.activeVersion.set('B');
  }

  protected onKey(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey)) return;
    const keys: Record<string, string> = { b: '*', i: '_' };
    const marker = keys[event.key.toLowerCase()];
    if (marker) {
      event.preventDefault();
      this.wrap(marker);
    }
  }

  protected onAttach(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!ALLOWED.includes(file.type)) {
      this.error.set('Attach a JPG, PNG, PDF, Word or MP4 file.');
      return;
    }
    const video = file.type.startsWith('video/');
    const maxMb = video ? 64 : 16; // WhatsApp's caps; the server enforces the same
    if (file.size > maxMb * 1024 * 1024) {
      this.error.set(`That file is over ${maxMb} MB.`);
      return;
    }
    this.uploading.set(true);
    this.error.set('');
    this.api.uploadMedia(file).subscribe({
      next: (media) => {
        const visual = file.type.startsWith('image/') || video;
        this.attach(media, media.mimetype || file.type, visual ? URL.createObjectURL(file) : '');
        this.duplicateOf.set(media.duplicate ? (media.firstUploadedAt ?? '') : null);
        this.uploading.set(false);
      },
      error: (err: Error) => {
        this.uploading.set(false);
        this.error.set(err.message);
      },
    });
  }

  /** A file picked from Storage becomes the attachment exactly as a fresh upload does. */
  protected onReused({ file, media }: StorageUse): void {
    if (!media) {
      this.error.set('The server did not return the attachment. Try again.');
      return;
    }
    this.error.set('');
    // The server flags every reopened file as a duplicate; picking one on purpose is not news.
    this.duplicateOf.set(null);
    const mimetype = media.mimetype || file.mimetype;
    this.attach({ ...media, storageId: media.storageId ?? file.id }, mimetype, '');
    // No local File to preview: fetch an image back so the phone preview is not blank.
    if (mimetype.startsWith('image/')) {
      this.storage.download(file.id).subscribe({
        next: (blob) => {
          const current = this.draft.attachment();
          if (current?.mediaId !== media.mediaId) return;
          this.draft.setAttachment({ ...current, previewUrl: URL.createObjectURL(blob) });
        },
        error: () => undefined,
      });
    }
  }

  private attach(media: UploadedMedia, mimetype: string, previewUrl: string): void {
    this.draft.setAttachment({
      mediaId: media.mediaId,
      filename: media.filename,
      mimetype,
      size: media.size,
      previewUrl,
      storageId: media.storageId,
    });
  }

  protected size(bytes: number): string {
    return formatBytes(bytes);
  }
}
