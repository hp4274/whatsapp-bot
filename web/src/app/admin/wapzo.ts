import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import type { ConnectionState, MessageStatus } from '../core/api';
import { ConfirmDialog } from '../core/confirm-dialog';
import { AdminFeed } from './admin-feed';
import { WapzoApi, WapzoLogEntry, WapzoMessage } from './wapzo-api';
import { WapzoBroadcast } from './wapzo-broadcast';
import { PhoneInput } from '../core/phone-input';

/** What every message about a business gets (server app.js notifyTenant). */
const BUSINESS_VARS: readonly string[] = ['name', 'business', 'email'];

/**
 * The words each event fills in, from the `vars` its sender passes (server app.js). Listing one an event never
 * fills would let the admin write `{amount}` into a message where it always comes out empty.
 */
const VARIABLES: Readonly<Record<string, readonly string[]>> = {
  lead_received: ['name', 'business'],
  account_activated: [...BUSINESS_VARS, 'link'],
  plan_started: [...BUSINESS_VARS, 'plan', 'amount', 'amount_text', 'date'],
  plan_renewed: [...BUSINESS_VARS, 'plan', 'amount', 'amount_text', 'date'],
  topup_added: [...BUSINESS_VARS, 'topup', 'amount', 'amount_text', 'date'],
  payment_received: [...BUSINESS_VARS, 'amount', 'due'],
  plan_ending: [...BUSINESS_VARS, 'plan', 'date', 'days'],
  plan_expired: [...BUSINESS_VARS, 'plan', 'date', 'days'],
};

/** An event added on the server before this list knows it still offers every word. */
const ALL_VARIABLES: readonly string[] = [
  'name', 'business', 'plan', 'amount', 'date', 'days', 'email', 'link', 'topup', 'due', 'amount_text',
];

const STATUS: Readonly<Record<MessageStatus, { readonly label: string; readonly tone: string }>> = {
  QUEUED: { label: 'Queued', tone: 'tone-mute' },
  SENDING: { label: 'Sending', tone: 'tone-info' },
  SENT: { label: 'Sent', tone: 'tone-ok' },
  DELIVERED: { label: 'Delivered', tone: 'tone-ok' },
  READ: { label: 'Read', tone: 'tone-ok' },
  FAILED: { label: 'Failed', tone: 'tone-bad' },
  CANCELLED: { label: 'Cancelled', tone: 'tone-mute' },
  SANDBOX: { label: 'Test mode', tone: 'tone-info' },
  NOT_ON_WHATSAPP: { label: 'Not on WhatsApp', tone: 'tone-bad' },
};

/** The QR code is fetched again this often while linking; the admin feed does not carry each new code. */
const POLL_MS = 2000;

type Busy = 'link' | 'unlink' | 'country' | 'test' | null;

/**
 * Wuzie's own WhatsApp number: it writes to clients when they ask for an account, when it is ready, and about
 * their plan and payments. It is linked and run like a business's number, on a hidden tenant, through the same
 * API (`/api/admin/wapzo/api`); this page adds the texts it sends and a log of what went out.
 */
@Component({
  selector: 'app-admin-wapzo',
  imports: [ConfirmDialog, DatePipe, WapzoBroadcast, PhoneInput],
  templateUrl: './wapzo.html',
  styleUrl: './wapzo.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Wuzie {
  private readonly api = inject(WapzoApi);

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly busy = signal<Busy>(null);
  /** The message whose switch or text is being saved. */
  protected readonly savingKind = signal<string | null>(null);
  protected readonly confirmUnlink = signal(false);

  protected readonly transports = signal<readonly string[]>(['baileys']);
  protected readonly messages = signal<readonly WapzoMessage[]>([]);
  protected readonly log = signal<readonly WapzoLogEntry[]>([]);
  protected readonly connection = signal<ConnectionState | null>(null);

  /** Unsaved edits by kind: a live reload refreshes the saved texts but never wipes what the admin is typing. */
  protected readonly drafts = signal<Readonly<Record<string, string>>>({});

  protected readonly transport = signal('baileys');
  protected readonly countryCode = signal('');
  private readonly savedCountryCode = signal('');
  protected readonly countryChanged = computed(() => this.countryCode().trim() !== this.savedCountryCode());

  protected readonly testTo = signal('');
  protected readonly testText = signal('');

  /** Set from the click until the server says it is connecting, so polling starts at once. */
  private readonly starting = signal(false);
  private readonly now = signal(Date.now());
  private polling = false;

  protected readonly linked = computed(() => !!this.connection()?.connected);
  protected readonly linking = computed(() => {
    const c = this.connection();
    return !c?.connected && (this.starting() || !!c?.connecting || !!c?.qr);
  });
  protected readonly qr = computed(() => (this.linked() ? null : (this.connection()?.qr ?? null)));
  /** Seconds the code on screen still works; null without a code or an expiry. */
  protected readonly qrSecondsLeft = computed(() => {
    const at = this.qr() ? this.connection()?.qrExpiresAt : null;
    const ends = at ? Date.parse(at) : NaN;
    return Number.isNaN(ends) ? null : Math.max(0, Math.ceil((ends - this.now()) / 1000));
  });
  protected readonly sandbox = computed(() => this.transports().includes('sandbox'));

  /** Event label for the log, by kind. */
  private readonly labels = computed(
    () => new Map<string, string>([['test', 'Test'], ['broadcast', 'Sent to many'], ...this.messages().map((m) => [m.kind, m.label] as [string, string])]),
  );

  constructor() {
    this.reload();
    this.loadConfig();
    // A sent message, a new link or another admin's edit shows here at once.
    inject(AdminFeed).watch(['channels', 'wapzo', 'campaigns', 'usage'], () => this.reload(true));
    // Only while linking: the QR code changes every few seconds and the countdown ticks. Cleared on destroy too.
    effect((onCleanup) => {
      if (!this.linking()) return;
      const tick = setInterval(() => this.now.set(Date.now()), 1000);
      const poll = setInterval(() => this.loadConnection(), POLL_MS);
      onCleanup(() => {
        clearInterval(tick);
        clearInterval(poll);
      });
    });
  }

  protected reload(quiet = false): void {
    if (!quiet) this.error.set('');
    this.api.overview().subscribe({
      next: (data) => {
        this.transports.set(data.transports);
        this.messages.set(data.messages);
        this.log.set(data.log);
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.loading.set(false);
        if (!quiet) this.error.set(err.message);
      },
    });
    this.loadConnection();
  }

  private loadConfig(): void {
    this.api.config().subscribe({
      next: ({ config }) => {
        this.transport.set(config.transport === 'sandbox' ? 'sandbox' : 'baileys');
        this.countryCode.set(config.defaultCountryCode);
        this.savedCountryCode.set(config.defaultCountryCode);
      },
      error: (err: Error) => this.error.set(err.message),
    });
  }

  private loadConnection(): void {
    // A slow answer must not stack up under the 2 s poll.
    if (this.polling) return;
    this.polling = true;
    this.api.connection().subscribe({
      next: (state) => {
        this.polling = false;
        this.connection.set(state);
        if (state.connecting || state.qr || state.connected) this.starting.set(false);
      },
      error: () => (this.polling = false),
    });
  }

  /** Save the transport first, as Connection does: linking with an unsaved choice would link the wrong thing. */
  protected link(): void {
    this.start('link');
    this.starting.set(true);
    this.api.saveConfig({ transport: this.transport() }).subscribe({
      next: () =>
        this.api.connect().subscribe({
          next: (state) => {
            this.busy.set(null);
            this.connection.set(state);
            if (!state.connecting && !state.qr) this.starting.set(false);
          },
          error: (err: Error) => this.fail(err, true),
        }),
      error: (err: Error) => this.fail(err, true),
    });
  }

  protected unlink(): void {
    this.confirmUnlink.set(false);
    this.start('unlink');
    this.api.logout().subscribe({
      next: (state) => {
        this.busy.set(null);
        this.starting.set(false);
        this.connection.set(state);
        this.notice.set('The number is unlinked. Link it again with a new QR code.');
      },
      error: (err: Error) => this.fail(err),
    });
  }

  protected saveCountry(): void {
    this.start('country');
    this.api.saveConfig({ defaultCountryCode: this.countryCode().trim() }).subscribe({
      next: ({ config }) => {
        this.busy.set(null);
        this.countryCode.set(config.defaultCountryCode);
        this.savedCountryCode.set(config.defaultCountryCode);
        this.notice.set('Country code saved.');
      },
      error: (err: Error) => this.fail(err),
    });
  }

  protected sendTest(): void {
    this.start('test');
    this.api.sendTest(this.testTo().trim(), this.testText().trim()).subscribe({
      next: ({ recipient }) => {
        this.busy.set(null);
        this.notice.set(`Test sent to +${recipient}.`);
        this.reload(true);
      },
      error: (err: Error) => this.fail(err),
    });
  }

  protected draftOf(message: WapzoMessage): string {
    return this.drafts()[message.kind] ?? message.text;
  }

  protected setDraft(kind: string, text: string): void {
    this.drafts.update((drafts) => ({ ...drafts, [kind]: text }));
  }

  protected changed(message: WapzoMessage): boolean {
    return this.draftOf(message).trim() !== message.text;
  }

  protected variables(kind: string): readonly string[] {
    return VARIABLES[kind] ?? ALL_VARIABLES;
  }

  /** Put `{word}` where the cursor was (the textarea keeps its selection after the chip takes focus). */
  protected insert(message: WapzoMessage, box: HTMLTextAreaElement, word: string): void {
    const token = `{${word}}`;
    const start = box.selectionStart ?? box.value.length;
    const end = box.selectionEnd ?? start;
    const next = box.value.slice(0, start) + token + box.value.slice(end);
    box.value = next;
    this.setDraft(message.kind, next);
    box.focus();
    box.setSelectionRange(start + token.length, start + token.length);
  }

  protected toggle(message: WapzoMessage): void {
    this.saveMessage(message, { enabled: !message.enabled }, message.enabled ? `${message.label} is off.` : `${message.label} is on.`);
  }

  protected saveText(message: WapzoMessage): void {
    this.saveMessage(message, { text: this.draftOf(message).trim() }, `${message.label} saved.`);
  }

  /** An empty text is the server's "back to the default". */
  protected resetText(message: WapzoMessage): void {
    this.saveMessage(message, { text: '' }, `${message.label} is back to the default text.`);
  }

  private saveMessage(message: WapzoMessage, body: { enabled?: boolean; text?: string }, done: string): void {
    this.savingKind.set(message.kind);
    this.error.set('');
    this.notice.set('');
    this.api.saveMessage(message.kind, body).subscribe({
      next: ({ message: saved }) => {
        this.savingKind.set(null);
        this.messages.update((list) => list.map((m) => (m.kind === saved.kind ? saved : m)));
        if (body.text !== undefined) {
          this.drafts.update((drafts) => {
            const rest = { ...drafts };
            delete rest[saved.kind];
            return rest;
          });
        }
        this.notice.set(done);
      },
      error: (err: Error) => {
        this.savingKind.set(null);
        this.error.set(err.message);
      },
    });
  }

  protected eventLabel(entry: WapzoLogEntry): string {
    return this.labels().get(entry.kind) ?? 'Other';
  }

  protected status(entry: WapzoLogEntry): { readonly label: string; readonly tone: string } {
    return STATUS[entry.status] ?? { label: entry.status, tone: 'tone-mute' };
  }

  /** A phone number reads "+91…"; any other account name (the sandbox's) as it is. */
  protected phone(value: string): string {
    return /^\d+$/.test(value) ? `+${value}` : value;
  }

  private start(action: Busy): void {
    this.busy.set(action);
    this.error.set('');
    this.notice.set('');
  }

  private fail(err: Error, linking = false): void {
    this.busy.set(null);
    if (linking) this.starting.set(false);
    this.error.set(err.message);
  }
}
