import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { type Channel, ChannelsApi } from '../core/api';
import { Auth } from '../core/auth';
import { Store } from '../core/store';

/**
 * Which of the business's WhatsApp numbers answer with auto replies: each number's `auto_replies` capability, the
 * same switch the server checks on every incoming message. Shown from two numbers up; admins switch, agents read.
 */
@Component({
  selector: 'ar-reply-numbers',
  template: `
    @if (numbers().length > 1) {
      <section class="s-card rn" aria-labelledby="rn-title">
        <header>
          <span class="badge" aria-hidden="true"><i class="ti ti-brand-whatsapp"></i></span>
          <div>
            <h3 id="rn-title">Reply from these numbers</h3>
            <p class="muted">
              Messages to a number switched off get no auto reply. STOP and opt-outs still work on every number.
            </p>
          </div>
          <span class="count">{{ onCount() }}/{{ numbers().length }} on</span>
        </header>
        <ul>
          @for (c of numbers(); track c.id) {
            @let on = c.capabilities.includes('auto_replies');
            <li [class.on]="on">
              <span class="who">
                <strong>{{ c.displayName }}</strong>
                <span class="muted">
                  {{ phoneOf(c) || 'Number not linked yet' }}{{ c.isDefault ? ' · Main number' : '' }}
                </span>
              </span>
              <button
                type="button"
                role="switch"
                class="switch"
                [attr.aria-checked]="on"
                [attr.aria-label]="'Auto replies on ' + c.displayName"
                [disabled]="!canEdit() || busy() === c.id"
                [attr.title]="canEdit() ? null : 'Only an admin can change this'"
                (click)="toggle(c)"
              >
                <span class="thumb"></span>
              </button>
            </li>
          }
        </ul>
        @if (error()) {
          <p class="err" role="alert"><i class="ti ti-alert-circle" aria-hidden="true"></i>{{ error() }}</p>
        }
      </section>
    }
  `,
  styles: `
    @use '../school/school-shared' as s;
    @include s.switch;
    .rn { display: grid; gap: var(--space-md); padding: var(--space-lg) var(--space-xl); }
    header { display: flex; align-items: flex-start; gap: var(--space-md); }
    header > div { flex: 1; min-width: 0; }
    h3 { margin: 0; font-size: 15px; font-weight: 500; color: var(--text-strong); }
    header p { margin: 2px 0 0; font-size: 13px; }
    .badge {
      display: inline-grid; place-items: center; flex: none; width: 36px; height: 36px;
      border-radius: 11px; font-size: 18px; color: var(--primary-text); background: var(--primary-tint);
    }
    .count { flex: none; font-size: 12.5px; font-weight: 500; color: var(--text-muted); }
    ul {
      display: grid; margin: 0; padding: 0; list-style: none;
      border: 1px solid var(--border-color); border-radius: var(--radius-md); overflow: hidden;
    }
    li { display: flex; align-items: center; gap: var(--space-md); padding: 12px 14px; transition: background var(--fast) var(--ease); }
    li + li { border-top: 1px solid var(--border-color); }
    li.on { background: var(--primary-tint); }
    .who { display: grid; flex: 1; min-width: 0; }
    .who strong { overflow: hidden; font-size: 14px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; color: var(--text-strong); }
    .who .muted { font-size: 12px; }
    .err { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 13px; color: var(--danger-text); }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReplyNumbers {
  private readonly api = inject(ChannelsApi);
  private readonly auth = inject(Auth);

  protected readonly numbers = signal<Channel[]>([]);
  protected readonly busy = signal<number | null>(null);
  protected readonly error = signal('');
  protected readonly canEdit = computed(() => this.auth.atLeast('admin'));
  protected readonly onCount = computed(() => this.numbers().filter((c) => c.capabilities.includes('auto_replies')).length);

  constructor() {
    this.load();
    // Linked, renamed or switched elsewhere (the WhatsApp page): the list follows at once.
    inject(Store).watch(['channels'], () => this.load(), 500);
  }

  protected phoneOf(c: Channel): string {
    const linked = c.providerAccountId?.replace(/\D/g, '');
    return c.phoneNumber || (linked ? '+' + linked : '');
  }

  private load(): void {
    this.api.list().subscribe({
      next: ({ channels }) => this.numbers.set(channels.filter((c) => c.status === 'active')),
      error: () => undefined, // the card is extra: the rules still work without it
    });
  }

  protected toggle(c: Channel): void {
    const on = c.capabilities.includes('auto_replies');
    const capabilities = on ? c.capabilities.filter((x) => x !== 'auto_replies') : [...c.capabilities, 'auto_replies'];
    this.busy.set(c.id);
    this.error.set('');
    this.api.update(c.id, { capabilities }).subscribe({
      next: ({ channel }) => {
        this.busy.set(null);
        this.numbers.update((list) => list.map((n) => (n.id === channel.id ? channel : n)));
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.error.set(err.message);
      },
    });
  }
}
