import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TenancyApi } from './api';
import { Auth } from './auth';

/**
 * Your own sign-in, opened from the sidebar's account row, for every role. Owners and admins change their email
 * and password; an agent changes only the password (the email is the one their admin added). The current password
 * is asked again, and other devices are signed out on a new password while this one stays in.
 */
@Component({
  selector: 'app-account-dialog',
  imports: [FormsModule],
  template: `
    <div class="dialog-wrap" (click)="closed.emit()" (keydown.escape)="closed.emit()">
      <form
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-title"
        (click)="$event.stopPropagation()"
        (submit)="save($event)"
      >
        <h3 id="account-title">Your sign-in</h3>
        @if (done()) {
          <p class="s-banner tone-ok" role="status">
            <i class="ti ti-circle-check" aria-hidden="true"></i>Saved. Other devices were signed out if you changed the password.
          </p>
          <div class="dialog-actions">
            <button #first class="btn primary" type="button" (click)="closed.emit()">Done</button>
          </div>
        } @else {
          <div class="fields">
            <div class="s-field">
              <label for="acc-email">Email</label>
              <input #first id="acc-email" name="email" type="email" autocomplete="username" required
                [readOnly]="agent()" [ngModel]="email()" (ngModelChange)="email.set($event)" />
              @if (agent()) {
                <span class="hint">Your admin can change this for you.</span>
              }
            </div>
            <div class="s-field">
              <label for="acc-new">New password <small>leave blank to keep it</small></label>
              <input id="acc-new" name="password" type="password" autocomplete="new-password" minlength="8"
                [ngModel]="password()" (ngModelChange)="password.set($event)" />
            </div>
            <div class="s-field">
              <label for="acc-current">Current password</label>
              <input id="acc-current" name="currentPassword" type="password" autocomplete="current-password" required
                [ngModel]="current()" (ngModelChange)="current.set($event)" />
            </div>
          </div>
          @if (error()) {
            <p class="s-banner" role="alert"><i class="ti ti-alert-circle" aria-hidden="true"></i>{{ error() }}</p>
          }
          <div class="dialog-actions">
            <button class="btn" type="button" (click)="closed.emit()">Cancel</button>
            <button class="btn primary" type="submit" [disabled]="busy() || !changed()">
              {{ busy() ? 'Saving...' : 'Save' }}
            </button>
          </div>
        }
      </form>
    </div>
  `,
  styleUrl: './account-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountDialog {
  private readonly api = inject(TenancyApi);
  private readonly auth = inject(Auth);

  readonly closed = output<void>();

  protected readonly agent = computed(() => this.auth.user()?.role === 'agent');
  protected readonly email = linkedSignal(() => this.auth.user()?.email ?? '');
  protected readonly password = signal('');
  protected readonly current = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly done = signal(false);
  protected readonly changed = computed(
    () => Boolean(this.password()) || this.email().trim().toLowerCase() !== this.auth.user()?.email,
  );
  private readonly first = viewChild<ElementRef<HTMLElement>>('first');

  constructor() {
    afterNextRender(() => this.first()?.nativeElement.focus());
  }

  protected save(event: Event): void {
    event.preventDefault();
    if (this.busy() || !(event.target as HTMLFormElement).reportValidity()) return;
    this.busy.set(true);
    this.error.set('');
    const email = this.email().trim();
    this.api
      .updateAccount({
        currentPassword: this.current(),
        ...(this.agent() ? {} : { email }),
        ...(this.password() ? { password: this.password() } : {}),
      })
      .subscribe({
        next: ({ user }) => {
          this.busy.set(false);
          this.auth.user.set(user);
          this.done.set(true);
          setTimeout(() => this.first()?.nativeElement.focus());
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message);
        },
      });
  }
}
