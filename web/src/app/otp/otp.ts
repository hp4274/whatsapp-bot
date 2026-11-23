import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, linkedSignal, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { Auth } from '../core/auth';
import { ConfirmDialog } from '../core/confirm-dialog';
import { PhoneInput } from '../core/phone-input';
import { Store } from '../core/store';
import type { ApiKey, CreatedApiKey } from '../developer/developer-api';
import { OtpApi, OtpRow, OtpSettings, OtpState, OtpStatus, VerifyResult } from './otp-api';
import {
  OTP_ENDPOINTS,
  OTP_ERRORS,
  OTP_LANGS,
  OTP_PLACEHOLDERS,
  OTP_STATUSES,
  SampleLang,
  VERIFY_REASONS,
  codeSamples,
  printOtpGuide,
  renderOtp,
  sampleCode,
} from './otp-text';

/** How each status reads, and its pill tone. */
const STATUS: Record<OtpStatus, { label: string; tone: string }> = {
  pending: { label: 'Waiting', tone: 'var(--info)' },
  verified: { label: 'Verified', tone: 'var(--success)' },
  expired: { label: 'Expired', tone: 'var(--text-muted)' },
  failed: { label: 'Not sent', tone: 'var(--danger-text)' },
  blocked: { label: 'Blocked', tone: 'var(--warning)' },
};


/** What a failed verify means, in the words the page shows. */
const VERIFY_TEXT: Record<NonNullable<VerifyResult['reason']>, string> = {
  wrong_code: 'That code is not right.',
  expired: 'That code has expired. Send a new one.',
  too_many_attempts: 'Too many wrong tries. Send a new code.',
  already_used: 'That code was already used.',
  not_found: 'There is no code to check. Send a new one.',
};


/**
 * WhatsApp OTP: the business's own backend sends a one-time code to a customer's WhatsApp through our API and
 * checks it. This page is where the owner sets it up (a key, the message) and its developer finds the calls;
 * then it shows codes going out.
 *
 * Like the shop panel, feedback is a line at the top, not a toast, and the message settings save with one button so
 * a half-typed template is never live. The new key is held only in `newKey` until dismissed: the server never
 * sends it again.
 */
@Component({
  selector: 'app-otp',
  imports: [FormsModule, RouterLink, ConfirmDialog, PhoneInput],
  templateUrl: './otp.html',
  styleUrl: './otp.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OtpView {
  private readonly api = inject(OtpApi);
  private readonly auth = inject(Auth);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  /** The server's service gate answered: this business does not have the OTP service. */
  protected readonly notOnPlan = signal(false);
  protected readonly state = signal<OtpState | null>(null);

  /** The last thing that happened, shown above the cards for a few seconds. */
  protected readonly notice = signal<{ text: string; bad: boolean } | null>(null);
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  // Message settings
  protected readonly form = linkedSignal<OtpSettings | null>(() => this.state()?.settings ?? null);
  protected readonly dirty = computed(
    () => JSON.stringify(this.form()) !== JSON.stringify(this.state()?.settings ?? null),
  );
  protected readonly saving = signal(false);
  protected readonly placeholders = OTP_PLACEHOLDERS;
  protected readonly missingCode = computed(() => !(this.form()?.template ?? '').includes('{code}'));
  protected readonly preview = computed(() => {
    const f = this.form();
    return f
      ? renderOtp(f.template, { code: sampleCode(f.length), brand: f.brand || this.auth.tenant()?.name || 'Your business', minutes: f.ttlMinutes })
      : '';
  });
  protected readonly maxTtl = computed(() => Math.min(30, this.state()?.rules.maxTtlMinutes ?? 30));

  // Keys
  protected readonly keyName = signal('');
  protected readonly creatingKey = signal(false);
  protected readonly newKey = signal<CreatedApiKey | null>(null);
  protected readonly revoking = signal<ApiKey | null>(null);
  protected readonly liveKeys = computed(() => (this.state()?.keys ?? []).filter((k) => !k.revokedAt));

  // Samples
  protected readonly langs = OTP_LANGS;
  protected readonly errors = OTP_ERRORS;
  protected readonly lang = signal<SampleLang>('curl');
  private readonly origin = typeof location === 'undefined' ? '' : location.origin;
  protected readonly sample = computed(() => codeSamples(this.origin)[this.lang()]);

  /** The full reference for the developer: where to call, the three calls, and what the answers mean. */
  protected readonly apiBase = `${this.origin}/api/v1`;
  protected readonly endpoints = OTP_ENDPOINTS;
  protected readonly reasons = VERIFY_REASONS;
  protected readonly statuses = OTP_STATUSES;
  /** This account's own limits, as the server applies them to every send. */
  protected readonly limits = computed(() => {
    const s = this.state();
    if (!s) return '';
    const parts = [
      `a code works ${Math.min(s.settings.ttlMinutes, s.rules.maxTtlMinutes)} minutes and allows ${s.settings.maxAttempts} tries`,
      `${s.settings.resendSeconds} seconds between codes to one number`,
      ...(s.rules.maxPerPhoneHour !== null ? [`${s.rules.maxPerPhoneHour} codes per number per hour`] : []),
      ...(s.rules.maxPerMonth !== null ? [`${s.rules.maxPerMonth.toLocaleString()} codes a month`] : []),
      s.rules.allowCustomCode ? 'your own code allowed' : 'your own code not allowed',
    ];
    return parts.join(', ');
  });
  protected readonly copied = signal('');

  // Test
  protected readonly testPhone = signal('');
  protected readonly testing = signal(false);
  protected readonly testResult = signal<OtpRow | null>(null);
  protected readonly testCode = signal('');
  protected readonly checking = signal(false);
  /** What the last check of the test code said, in words; `ok` picks the tone. */
  protected readonly checkNote = signal<{ ok: boolean; text: string } | null>(null);

  protected readonly recent = computed(() => this.state()?.recent ?? []);
  protected readonly connections = computed(() => this.state()?.connections ?? []);
  /** Key names by id, for "sent with key X". */
  private readonly keyNames = computed(
    () => new Map((this.state()?.keys ?? []).map((k) => [k.id, k.name || k.prefix + '…'])),
  );
  protected readonly verifiedPct = computed(() => {
    const s = this.state()?.stats;
    return s && s.sentMonth ? `${Math.round((s.verifiedMonth / s.sentMonth) * 100)}%` : '-';
  });
  /** The three set-up steps, each done or not. Step 3 counts only real API sends, not tests from this page. */
  protected readonly steps = computed(() => {
    const s = this.state();
    return {
      linked: !!s?.connected,
      key: this.liveKeys().length > 0,
      called: !!s?.recent.some((r) => r.source === 'api'),
    };
  });

  constructor() {
    this.load();
    // `channels`/`connection`: linking or losing the number ticks step 1 at once.
    inject(Store).watch(['otp', 'channels', 'connection', 'tenant'], () => this.load(true));
    this.destroyRef.onDestroy(() => clearTimeout(this.noticeTimer));
  }

  protected load(quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.loadError.set('');
    this.api
      .get()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => {
          this.notOnPlan.set(false);
          // A live reload must not wipe what the owner is typing.
          if (quiet && this.dirty()) this.state.update((cur) => (cur ? { ...s, settings: cur.settings } : s));
          else this.state.set(s);
          this.loading.set(false);
        },
        error: (err: Error) => {
          // The server's service gate (app.js tenantAccessError): "otp is disabled for this tenant".
          if (/otp is disabled/i.test(err.message)) this.notOnPlan.set(true);
          else this.loadError.set(err.message);
          this.loading.set(false);
        },
      });
  }

  private say(text: string, bad = false): void {
    clearTimeout(this.noticeTimer);
    this.notice.set({ text, bad });
    this.noticeTimer = setTimeout(() => this.notice.set(null), bad ? 7000 : 3500);
  }

  private fail = (err: unknown): void => this.say(err instanceof Error ? err.message : String(err), true);

  // Settings ------------------------------------------------------------------
  protected set<K extends keyof OtpSettings>(key: K, value: OtpSettings[K]): void {
    this.form.update((f) => (f ? { ...f, [key]: value } : f));
  }

  /** Puts a placeholder where the cursor is in the template box, or at the end. */
  protected insert(box: HTMLTextAreaElement, token: string): void {
    const f = this.form();
    if (!f) return;
    const at = box.selectionStart ?? f.template.length;
    const end = box.selectionEnd ?? at;
    this.set('template', (f.template.slice(0, at) + token + f.template.slice(end)).slice(0, 500));
    queueMicrotask(() => {
      box.focus();
      box.setSelectionRange(at + token.length, at + token.length);
    });
  }

  protected save(): void {
    const f = this.form();
    if (!f || this.saving() || this.missingCode()) return;
    this.saving.set(true);
    this.api.saveSettings(f).subscribe({
      next: ({ settings }) => {
        this.state.update((s) => (s ? { ...s, settings } : s));
        this.saving.set(false);
        this.say('Message saved');
      },
      error: (err) => {
        this.saving.set(false);
        this.fail(err);
      },
    });
  }

  // Keys ----------------------------------------------------------------------
  protected createKey(): void {
    if (this.creatingKey()) return;
    this.creatingKey.set(true);
    this.api.createKey(this.keyName().trim()).subscribe({
      next: ({ key }) => {
        this.creatingKey.set(false);
        this.newKey.set(key);
        const { key: secret, ...rest } = key;
        void secret;
        this.state.update((s) => (s ? { ...s, keys: [rest, ...s.keys.filter((k) => k.id !== rest.id)] } : s));
        this.keyName.set('');
      },
      error: (err) => {
        this.creatingKey.set(false);
        this.fail(err);
      },
    });
  }

  protected revoke(): void {
    const k = this.revoking();
    this.revoking.set(null);
    if (!k) return;
    this.api.revokeKey(k.id).subscribe({
      next: ({ key }) => {
        this.state.update((s) => (s ? { ...s, keys: s.keys.map((x) => (x.id === key.id ? key : x)) } : s));
        if (this.newKey()?.id === key.id) this.newKey.set(null);
        this.say(`${k.name || k.prefix} revoked`);
      },
      error: this.fail,
    });
  }

  // Test ----------------------------------------------------------------------
  protected sendTest(): void {
    const phone = this.testPhone();
    if (!phone || this.testing()) return;
    this.testing.set(true);
    this.testResult.set(null);
    this.testCode.set('');
    this.checkNote.set(null);
    this.api.test(phone).subscribe({
      next: ({ otp }) => {
        this.testing.set(false);
        this.testResult.set(otp);
        this.state.update((s) => (s ? { ...s, recent: [otp, ...s.recent.filter((r) => r.id !== otp.id)] } : s));
      },
      error: (err) => {
        this.testing.set(false);
        this.fail(err);
      },
    });
  }

  /** Check the code the test delivered, the way a customer's app would. */
  protected verifyTest(): void {
    const row = this.testResult();
    const code = this.testCode().trim();
    if (!row || !code || this.checking()) return;
    this.checking.set(true);
    this.api.verifyTest(row.id, code).subscribe({
      next: ({ result, otp }) => {
        this.checking.set(false);
        if (otp) {
          this.testResult.set(otp);
          this.state.update((s) => (s ? { ...s, recent: s.recent.map((r) => (r.id === otp.id ? otp : r)) } : s));
        }
        this.checkNote.set(
          result.valid
            ? { ok: true, text: 'Verified. Your app would sign the customer in now.' }
            : { ok: false, text: VERIFY_TEXT[result.reason ?? 'not_found'] + (result.attemptsLeft ? ` ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left.` : '') },
        );
        if (result.valid) this.testCode.set('');
      },
      error: (err) => {
        this.checking.set(false);
        this.fail(err);
      },
    });
  }

  /** "+91 98765 43210" for 919876543210 (Indian layout); other numbers as + and the digits. */
  protected phone(digits: string): string {
    const d = String(digits).replace(/\D/g, '');
    return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : `+${d}`;
  }

  protected keyLabel(id: number | null): string {
    return id === null ? 'Unknown key' : (this.keyNames().get(id) ?? 'A deleted key');
  }

  // Misc ----------------------------------------------------------------------
  /** The developer guide as a PDF, with this account's name and limits (otp-text.ts printOtpGuide). */
  protected downloadGuide(): void {
    printOtpGuide({ base: this.origin, business: this.auth.tenant()?.name ?? '', limits: this.limits() });
  }

  protected async copy(id: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(id);
      setTimeout(() => this.copied() === id && this.copied.set(''), 2000);
    } catch {
      this.say('Copy failed. Select the text and copy it yourself.', true);
    }
  }

  protected status(r: OtpRow): { label: string; tone: string } {
    return STATUS[r.status] ?? { label: r.status, tone: 'var(--text-muted)' };
  }

  protected when(iso: string | null): string {
    return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }

  protected num(value: unknown): number {
    return Number(value) || 0;
  }
}
