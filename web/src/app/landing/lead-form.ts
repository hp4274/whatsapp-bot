import { ChangeDetectionStrategy, Component, inject, input, linkedSignal, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Api } from '../core/api';
import { PhoneInput } from '../core/phone-input';
import { referralCode } from '../core/referral';

/**
 * "Request access": accounts are issued by the platform, so this is how a business asks for one. It is
 * the landing page's form and the sign-in page's dialog for an email with no account; both land in the
 * super admin's Leads screen, which turns a request into a tenant.
 */
@Component({
  selector: 'app-lead-form',
  imports: [FormsModule, PhoneInput],
  templateUrl: './lead-form.html',
  styleUrl: './lead-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LeadForm {
  private readonly api = inject(Api);

  readonly source = input<'landing' | 'login'>('landing');
  /** Prefilled from the sign-in attempt; still editable. */
  readonly email = input('');
  /** After a successful request, for a dialog to offer closing. */
  readonly sent = output<void>();

  protected readonly name = signal('');
  protected readonly business = signal('');
  protected readonly address = linkedSignal(() => this.email());
  protected readonly phone = signal('');
  protected readonly message = signal('');
  /** The hidden box; a person never sees or fills it. */
  protected readonly website = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  /** The email the request went out with, once it has. */
  protected readonly done = signal('');

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.busy()) return;
    const form = event.target as HTMLFormElement;
    // The browser's own checks (required, type=email) speak first and point at the field.
    if (!form.reportValidity()) return;
    this.busy.set(true);
    this.error.set('');
    const email = this.address().trim();
    this.api
      .requestAccess({
        name: this.name().trim(),
        business: this.business().trim(),
        email,
        phone: this.phone().trim(),
        message: this.message().trim(),
        source: this.source(),
        website: this.website(),
        ref: referralCode(),
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.done.set(email);
          this.sent.emit();
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message);
        },
      });
  }
}
