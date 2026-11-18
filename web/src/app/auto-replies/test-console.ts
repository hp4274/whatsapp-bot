import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';

import { interactiveOptions } from '../campaign/interactive/interactive.model';
import { ArChips } from './ar-fields';
import {
  ArToasts,
  AutoRepliesApi,
  AutoReplyRule,
  Session,
  TestReply,
  TestResult,
} from './auto-replies.api';
import { MESSAGE_TYPE_LABEL } from './rule-editor';
import { PreviewAttachment, PreviewTurn, WaPreview } from './wa-preview';
import { PhoneInput } from '../core/phone-input';

/** Human names for the engine's reply sources, shown on each simulated reply. */
const SOURCE_LABEL: Record<TestReply['source'], string> = {
  welcome: 'Welcome',
  away: 'Away',
  handoff: 'Handoff',
  menu: 'Menu follow-up',
  flow: 'Question',
  language: 'Language note',
  rule: 'Rule',
  schedule: 'Outside schedule',
  fallback: 'Fallback',
  help: 'Help',
  faq: 'Knowledge base',
};

/**
 * What a customer can send besides text, as the attach menu lists it. `accept` opens a file picker so a real photo
 * or file can be shown in the preview (it stays in the browser: only the type reaches the server); location and
 * contact have no file.
 */
const ATTACH: readonly { type: string; icon: string; accept: string | null }[] = [
  { type: 'image', icon: 'photo', accept: 'image/*' },
  { type: 'video', icon: 'video', accept: 'video/*' },
  { type: 'audio', icon: 'microphone', accept: 'audio/*' },
  { type: 'document', icon: 'file-text', accept: '*/*' },
  { type: 'sticker', icon: 'sticker', accept: 'image/webp,image/png' },
  { type: 'location', icon: 'map-pin', accept: null },
  { type: 'contact', icon: 'address-book', accept: null },
];

/** Local "now" in the format <input type="datetime-local"> expects. */
function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * Sandbox: runs a message through the real reply engine on the server without
 * sending anything or counting stats. The menu session is carried between
 * runs so button taps can walk a follow-up tree like a customer would.
 */
@Component({
  selector: 'ar-test-console',
  imports: [ArChips, WaPreview, PhoneInput],
  templateUrl: './test-console.html',
  styleUrl: './test-console.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:click)': 'closeAttach($event)', '(document:keydown.escape)': 'attachOpen.set(false)' },
})
export class TestConsole {
  private readonly api = inject(AutoRepliesApi);
  private readonly toasts = inject(ArToasts);

  readonly rules = input<AutoReplyRule[]>([]);
  readonly businessName = input('Your business');

  protected readonly body = signal('Hi');
  protected readonly attachTypes = ATTACH;
  protected readonly typeLabel = MESSAGE_TYPE_LABEL;
  /** What the customer sends along with (or instead of) text; null = text only. */
  protected readonly attachment = signal<PreviewAttachment | null>(null);
  protected readonly attachOpen = signal(false);
  /** The type waiting on the file picker. */
  private pickingType = '';
  private readonly filePicker = viewChild.required<ElementRef<HTMLInputElement>>('filePicker');
  /** Object URLs made for picked photos, freed when the conversation is cleared or the page closes. */
  private readonly urls: string[] = [];
  protected readonly mediaType = computed(() => this.attachment()?.type ?? '');
  protected readonly sender = signal('919876543210');
  protected readonly senderName = signal('Aarav Sharma');
  protected readonly at = signal(localNow());
  protected readonly first = signal<'auto' | 'yes' | 'no'>('auto');
  protected readonly tags = signal<string[]>([]);
  protected readonly session = signal<Session | null>(null);
  protected readonly result = signal<TestResult | null>(null);
  protected readonly turns = signal<PreviewTurn[]>([]);
  protected readonly running = signal(false);
  protected readonly fallbackView = signal(false);

  protected readonly menuRule = computed(() => {
    const s = this.session();
    return s ? (this.rules().find((r) => r.id === s.ruleId)?.name ?? `Rule #${s.ruleId}`) : null;
  });

  /** Options of the last interactive reply, so a button tap can be simulated with its id. */
  protected readonly taps = computed(() => {
    const replies = this.result()?.replies ?? [];
    return replies
      .flatMap((r) => interactiveOptions(r.interactive))
      .map((o) => ({ id: o.id, title: o.title }));
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.urls.forEach((u) => URL.revokeObjectURL(u)));
  }

  /** A click anywhere but the attach button or its menu closes the menu. */
  protected closeAttach(e: Event): void {
    if (this.attachOpen() && !(e.target as Element | null)?.closest('.attach')) this.attachOpen.set(false);
  }

  /** From the attach menu: a file type opens the picker; location and contact attach at once. */
  protected attach(type: string): void {
    this.attachOpen.set(false);
    const kind = ATTACH.find((a) => a.type === type);
    if (!kind) return;
    if (!kind.accept) {
      this.attachment.set({ type, icon: kind.icon, name: type === 'location' ? 'Shared location' : 'Contact card', url: null });
      return;
    }
    this.pickingType = type;
    const picker = this.filePicker().nativeElement;
    picker.accept = kind.accept;
    picker.click();
  }

  protected picked(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const kind = ATTACH.find((a) => a.type === this.pickingType);
    if (!file || !kind) return;
    const drawable = (kind.type === 'image' || kind.type === 'sticker') && file.type.startsWith('image/');
    const url = drawable ? URL.createObjectURL(file) : null;
    if (url) this.urls.push(url);
    this.attachment.set({ type: kind.type, icon: kind.icon, name: file.name, url });
  }

  protected v(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  protected run(tap?: { id: string; title: string }): void {
    const body = tap ? tap.title : this.body().trim();
    if ((!body && !this.mediaType()) || this.running()) return;
    this.running.set(true);
    this.api
      .test({
        body,
        sender: this.sender().trim(),
        senderName: this.senderName().trim() || undefined,
        at: this.at() ? new Date(this.at()).toISOString() : undefined,
        firstContact: this.first() === 'auto' ? null : this.first() === 'yes',
        tags: this.tags().length ? this.tags() : null,
        session: this.session(),
        ...(tap ? { replyId: tap.id } : {}),
        ...(this.mediaType() && !tap ? { mediaType: this.mediaType() } : {}),
      })
      .subscribe({
        next: (res) => {
          this.result.set(res);
          this.session.set(res.session);
          this.turns.update((t) => [
            ...t.slice(-5),
            {
              incoming: body,
              attachment: tap ? null : this.attachment(),
              replies: res.replies.map((r) => ({
                text: r.text,
                media: r.media,
                interactive: r.interactive,
                label: `${SOURCE_LABEL[r.source] ?? r.source}${r.ruleName ? ' · ' + r.ruleName : ''}`,
              })),
            },
          ]);
          if (!tap) {
            this.body.set('');
            this.attachment.set(null);
          }
          this.running.set(false);
        },
        error: (err) => {
          this.toasts.error(err);
          this.running.set(false);
        },
      });
  }

  protected reset(): void {
    this.urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    this.attachment.set(null);
    this.session.set(null);
    this.turns.set([]);
    this.result.set(null);
  }

  protected source(r: TestReply): string {
    return SOURCE_LABEL[r.source] ?? r.source;
  }
}
