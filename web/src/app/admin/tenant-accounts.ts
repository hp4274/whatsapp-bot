import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { catchError, throwError } from 'rxjs';

import type { User } from '../core/auth';

/** Shortest password the server accepts (tenancy.js setPassword). */
const MIN_PASSWORD = 8;

const toMessage = (error: HttpErrorResponse) => {
  const errors = error.error?.errors;
  return throwError(
    () => new Error(Array.isArray(errors) && errors.length ? errors.join('\n') : error.message || 'Request failed'),
  );
};

/**
 * A business's sign-in accounts, for the super admin: who can log in, and a
 * password reset for any of them.
 *
 * The reset signs that person out everywhere (the server revokes sessions),
 * because a reset usually means the old password can no longer be trusted.
 * Only one row is open at a time so a typed password never sits in two forms.
 */
@Component({
  selector: 'app-tenant-accounts',
  templateUrl: './tenant-accounts.html',
  styleUrl: './tenant-accounts.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantAccounts {
  private readonly http = inject(HttpClient);

  readonly tenantId = input.required<number>();

  protected readonly minPassword = MIN_PASSWORD;
  protected readonly users = signal<User[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  /** The user whose reset form is open. */
  protected readonly openId = signal<number | null>(null);
  protected readonly password = signal('');
  protected readonly show = signal(false);
  protected readonly saving = signal(false);
  protected readonly formError = signal('');
  /** Confirmation line for the last successful reset. */
  protected readonly done = signal('');

  constructor() {
    effect(() => this.load(this.tenantId()));
  }

  protected load(id = this.tenantId()): void {
    this.loading.set(true);
    this.error.set('');
    this.http
      .get<{ users: User[] }>(`/api/admin/tenants/${id}/users`)
      .pipe(catchError(toMessage))
      .subscribe({
        next: ({ users }) => {
          this.users.set(users);
          this.loading.set(false);
        },
        error: (err: Error) => {
          this.error.set(err.message);
          this.loading.set(false);
        },
      });
  }

  protected toggle(user: User): void {
    this.openId.set(this.openId() === user.id ? null : user.id);
    this.password.set('');
    this.show.set(false);
    this.formError.set('');
    this.done.set('');
  }

  /** A readable random password, so the admin does not have to invent one. */
  protected generate(): void {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(14));
    this.password.set(Array.from(bytes, (b) => chars[b % chars.length]).join(''));
    this.show.set(true);
  }

  protected save(user: User): void {
    if (this.password().length < MIN_PASSWORD) {
      this.formError.set(`Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    this.saving.set(true);
    this.formError.set('');
    this.http
      .put(`/api/admin/tenants/${this.tenantId()}/users/${user.id}/password`, { password: this.password() })
      .pipe(catchError(toMessage))
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.openId.set(null);
          this.password.set('');
          this.done.set(`Password changed for ${user.email}. They have been signed out everywhere.`);
        },
        error: (err: Error) => {
          this.saving.set(false);
          this.formError.set(err.message);
        },
      });
  }
}
