import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';

export interface ErrorHelp {
  readonly title: string;
  readonly why: string;
  readonly steps: readonly string[];
}

/** What each failure code (server messaging/errors.js ErrorCode) means and what to do about it. */
const HELP: Record<string, ErrorHelp> = {
  INVALID_RECIPIENT: {
    title: 'Number not on WhatsApp',
    why: 'WhatsApp says this phone number has no WhatsApp account, or it is written in a shape WhatsApp cannot read.',
    steps: [
      'Check the number has the right country code (for India, 91 followed by 10 digits).',
      'Remove extra zeros, spaces or a leading 0 in front of the number.',
      'If the person changed numbers, update the contact and send again.',
      'Numbers that are really not on WhatsApp can never get messages: remove them from the list.',
    ],
  },
  DISCONNECTED: {
    title: 'WhatsApp got disconnected',
    why: 'The sending number lost its link to WhatsApp while the campaign was going out.',
    steps: [
      'Open the WhatsApp page and check the number shows Connected.',
      'If it says Not linked, scan the QR code again from the phone.',
      'Keep the phone on the internet; messages left waiting go out once it reconnects.',
      'Then use Retry failed on the campaign for the ones that failed.',
    ],
  },
  RATE_LIMITED: {
    title: 'WhatsApp slowed this number down',
    why: 'Too many messages went out too fast, so WhatsApp asked the number to wait.',
    steps: [
      'Nothing is lost: sending slows down and tries again by itself.',
      'Send smaller campaigns, or spread a big one over several days.',
      'Share big campaigns over more numbers under Send from.',
    ],
  },
  AUTH: {
    title: 'The WhatsApp login expired',
    why: 'WhatsApp signed this number out, so it cannot send until it is linked again.',
    steps: [
      'Open the WhatsApp page and link the number again with a QR code.',
      'On the phone, check Linked devices still lists this app.',
      'Then use Retry failed on the campaign.',
    ],
  },
  TEMPLATE_REQUIRED: {
    title: 'Needs an approved template',
    why: 'This person has not written to you in the last 24 hours, and WhatsApp only allows an approved template then.',
    steps: [
      'Send this person an approved template instead of a free message.',
      'Or wait until they message you, then reply within 24 hours.',
    ],
  },
  PROVIDER_UNAVAILABLE: {
    title: 'WhatsApp did not answer in time',
    why: 'WhatsApp or the internet connection was slow or down for a moment.',
    steps: [
      'It usually fixes itself: the message is tried again.',
      'Check the phone and this server have a steady internet connection.',
      'If many fail, wait a few minutes and use Retry failed.',
    ],
  },
  CANCELLED: {
    title: 'Stopped before it was sent',
    why: 'The campaign was stopped or paused, or a limit was reached, before this message went out.',
    steps: [
      'Nothing is wrong with the number.',
      'Send it again with Retry failed, or in a new campaign.',
    ],
  },
};

const MEDIA: ErrorHelp = {
  title: 'The attachment could not be sent',
  why: 'WhatsApp refused the file: it is too big or of a kind it does not take.',
  steps: [
    'Use a JPG or PNG image, a PDF, or an MP4 video.',
    'Keep images and PDFs under 16 MB and videos under 64 MB.',
    'Upload the file again and send the campaign again.',
  ],
};

const GENERIC: ErrorHelp = {
  title: 'WhatsApp could not send this message',
  why: 'WhatsApp refused the message without saying exactly why.',
  steps: [
    'Use Retry failed once: many of these go through the second time.',
    'If it keeps failing, unlink the number on the WhatsApp page and link it again.',
    'If one number keeps failing, check it is on WhatsApp and not blocking you.',
  ],
};

/** The help for a failure: by its code, else guessed from its text. */
export function errorHelp(code: string | null | undefined, text?: string | null): ErrorHelp {
  if (code && HELP[code]) return HELP[code];
  const t = (text ?? '').toLowerCase();
  if (/attachment|media|file|jpg|png|pdf|mp4/.test(t)) return MEDIA;
  if (/not on whatsapp|invalid.*(number|phone|recipient)/.test(t)) return HELP['INVALID_RECIPIENT'];
  if (/disconnect|not connected|link/.test(t)) return HELP['DISCONNECTED'];
  return GENERIC;
}

/** "Learn more" for a failed message: what went wrong and what to do, in plain words. */
@Component({
  selector: 'app-error-help',
  template: `
    <div class="dialog-wrap" (click)="closed.emit()" (keydown.escape)="closed.emit()">
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="eh-title"
        aria-describedby="eh-why"
        (click)="$event.stopPropagation()"
      >
        <span class="eh-badge" aria-hidden="true"><i class="ti ti-alert-circle"></i></span>
        <h3 id="eh-title">{{ help().title }}</h3>
        <p id="eh-why">{{ help().why }}</p>
        <p class="eh-sub">What to do</p>
        <ol class="eh-steps">
          @for (s of help().steps; track s; let i = $index) {
            <li><span class="num">{{ i + 1 }}</span>{{ s }}</li>
          }
        </ol>
        @if (text()) {
          <p class="eh-raw">WhatsApp said: {{ text() }}</p>
        }
        <div class="dialog-actions">
          <button #ok class="btn primary" type="button" (click)="closed.emit()">Got it</button>
        </div>
      </div>
    </div>
  `,
  styles: `
    @use '../school/school-shared' as s;
    @include s.keyframes;
    @include s.confirm;
    .dialog { width: min(460px, 100%); }
    .eh-badge {
      display: inline-grid; place-items: center; width: 40px; height: 40px; margin-bottom: 12px;
      border-radius: 12px; font-size: 20px; color: var(--danger-text); background: var(--danger-soft);
    }
    .eh-sub { margin-top: var(--space-lg) !important; font-size: 12.5px !important; font-weight: 600; color: var(--text-strong) !important; }
    .eh-steps { display: grid; gap: 8px; margin: 8px 0 0; padding: 0; list-style: none; }
    .eh-steps li { display: flex; gap: 10px; font-size: 13.5px; line-height: 1.5; color: var(--text-color); }
    .num {
      flex: none; display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%;
      font-size: 12px; font-weight: 600; color: var(--primary-text); background: var(--primary-tint);
    }
    .eh-raw { margin-top: var(--space-md) !important; font-size: 12px !important; color: var(--hint) !important; overflow-wrap: anywhere; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ErrorHelpDialog {
  readonly code = input<string | null>(null);
  /** The raw text, shown small at the bottom for support. */
  readonly text = input<string | null>(null);
  readonly closed = output<void>();
  protected readonly help = computed(() => errorHelp(this.code(), this.text()));
  private readonly ok = viewChild.required<ElementRef<HTMLButtonElement>>('ok');

  constructor() {
    afterNextRender(() => this.ok().nativeElement.focus());
  }
}
