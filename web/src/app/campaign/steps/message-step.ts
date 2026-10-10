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

import { Api } from '../../core/api';
import { Template, TemplatesApi } from '../../templates/templates-api';
import { InteractiveEditor } from '../interactive/interactive-editor';
import { CampaignDraft } from '../draft';
import { CampaignPolicy } from '../policy-api';
import { MetaParams } from './meta-params';
import { formatBytes } from '../wa-format';

/** Media types WhatsApp accepts as an attachment; the server checks the same list. */
const ALLOWED = ['image/jpeg', 'image/png', 'application/pdf', 'video/mp4', 'video/3gpp'];
/** Inserted by the Spintax button: a working example the user edits in place. */
const SPIN_SAMPLE = '{Hi|Hello|Hey}';

/**
 * Step 2: the message itself — free-form text with WhatsApp formatting and
 * variables, or (on Cloud API) a Meta-approved template mapped to columns.
 * Optional extras (backup template, buttons, fallbacks) fold away so the main
 * path stays short.
 */
@Component({
  selector: 'app-message-step',
  imports: [FormsModule, RouterLink, InteractiveEditor, MetaParams],
  templateUrl: './message-step.html',
  styleUrl: './message-step.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageStep {
  protected readonly draft = inject(CampaignDraft);
  private readonly api = inject(Api);
  private readonly templatesApi = inject(TemplatesApi);
  /** Interactive buttons can be off on the plan; the editor is then replaced by a note. */
  protected readonly policy = inject(CampaignPolicy);
  private readonly editor = viewChild<ElementRef<HTMLTextAreaElement>>('editor');

  protected readonly uploading = signal(false);
  protected readonly error = signal('');
  protected readonly spinHelp = signal(false);

  /** Approved Meta templates (Cloud API channels only), loaded once on demand. */
  protected readonly approved = signal<Template[] | null>(null);
  protected readonly templatesError = signal('');

  constructor() {
    this.policy.load();
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
    const value = this.draft.message();
    if (!el) {
      this.draft.message.set(value + text);
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
    this.draft.message.set(next);
    const el = this.editor()?.nativeElement;
    if (!el) return;
    el.value = next;
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(from, to);
    });
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
      this.error.set('Attach a JPG, PNG, PDF or MP4 file.');
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
        this.draft.setAttachment({
          mediaId: media.mediaId,
          filename: media.filename,
          mimetype: media.mimetype || file.type,
          size: media.size,
          previewUrl: visual ? URL.createObjectURL(file) : '',
        });
        this.uploading.set(false);
      },
      error: (err: Error) => {
        this.uploading.set(false);
        this.error.set(err.message);
      },
    });
  }

  protected size(bytes: number): string {
    return formatBytes(bytes);
  }
}
