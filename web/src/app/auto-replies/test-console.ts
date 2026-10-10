import { Component, computed, inject, input, signal } from '@angular/core';

import { interactiveOptions } from '../campaign/interactive/interactive.model';
import { ArChips } from './ar-fields';
import { ArToasts, AutoRepliesApi, AutoReplyRule, Session, TestReply, TestResult } from './auto-replies.api';
import { PreviewTurn, WaPreview } from './wa-preview';

const SOURCE_LABEL: Record<TestReply['source'], string> = {
  welcome: 'Welcome', away: 'Away', handoff: 'Handoff', menu: 'Menu follow-up', rule: 'Rule',
  schedule: 'Outside schedule', fallback: 'Fallback', help: 'Help', faq: 'Knowledge base',
};

/** Local "now" in the format <input type="datetime-local"> expects. */
function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

@Component({
  selector: 'ar-test-console',
  imports: [ArChips, WaPreview],
  templateUrl: './test-console.html',
  styleUrl: './test-console.scss',
})
export class TestConsole {
  private readonly api = inject(AutoRepliesApi);
  private readonly toasts = inject(ArToasts);

  readonly rules = input<AutoReplyRule[]>([]);
  readonly businessName = input('Your business');

  protected readonly body = signal('Hi');
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
    return replies.flatMap((r) => interactiveOptions(r.interactive)).map((o) => ({ id: o.id, title: o.title }));
  });

  protected v(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  protected run(tap?: { id: string; title: string }): void {
    const body = tap ? tap.title : this.body().trim();
    if (!body || this.running()) return;
    this.running.set(true);
    this.api.test({
      body,
      sender: this.sender().trim(),
      senderName: this.senderName().trim() || undefined,
      at: this.at() ? new Date(this.at()).toISOString() : undefined,
      firstContact: this.first() === 'auto' ? null : this.first() === 'yes',
      tags: this.tags().length ? this.tags() : null,
      session: this.session(),
      ...(tap ? { replyId: tap.id } : {}),
    }).subscribe({
      next: (res) => {
        this.result.set(res);
        this.session.set(res.session);
        this.turns.update((t) => [...t.slice(-5), {
          incoming: body,
          replies: res.replies.map((r) => ({
            text: r.text, media: r.media, interactive: r.interactive,
            label: `${SOURCE_LABEL[r.source] ?? r.source}${r.ruleName ? ' · ' + r.ruleName : ''}`,
          })),
        }]);
        if (!tap) this.body.set('');
        this.running.set(false);
      },
      error: (err) => {
        this.toasts.error(err);
        this.running.set(false);
      },
    });
  }

  protected reset(): void {
    this.session.set(null);
    this.turns.set([]);
    this.result.set(null);
  }

  protected source(r: TestReply): string {
    return SOURCE_LABEL[r.source] ?? r.source;
  }
}
