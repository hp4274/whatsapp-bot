import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { catchError, throwError } from 'rxjs';

import { spacedPhone } from '../contacts/contact-util';
import type { User } from '../core/auth';
import type { AccountGroup, AccountNumber, NumberDetails } from './number-details';
import { sentenceCase } from './text';

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

  /** Pill labels are sentence case: "past_due" reads "Past due". */
  protected readonly sentence = sentenceCase;
  protected readonly minPassword = MIN_PASSWORD;
  protected readonly spacedPhone = spacedPhone;
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
  protected readonly contacts = signal<AccountNumber[]>([]);
  protected readonly groups = signal<AccountGroup[]>([]);
  protected readonly account = signal('');
  protected readonly savedCount = signal(0);
  protected readonly hiddenCount = signal(0);
  protected readonly fetching = signal(false);
  protected readonly fetched = signal(false);
  /** Why the last fetch failed, usually "connect a WhatsApp number first". */
  protected readonly fetchError = signal('');
  /** Confirmation line for the last saved bulk collection. */
  protected readonly collectionDone = signal('');
  protected readonly savingCollection = signal(false);

  constructor() {
    effect(() => this.load(this.tenantId()));
  }

  protected load(id = this.tenantId()): void {
    this.loading.set(true);
    this.error.set('');
    this.resetFetched();
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

  /**
   * Read the numbers off the linked WhatsApp account itself: its address book plus
   * the members of the groups and communities it joined. The platform's own
   * contacts are not involved.
   */
  protected fetchData(): void {
    if (this.fetching()) return;
    const id = this.tenantId();
    this.fetching.set(true);
    this.fetchError.set('');
    this.http
      .get<NumberDetails>(`/api/admin/tenants/${id}/contacts`)
      .pipe(catchError(toMessage))
      .subscribe({
        next: (details) => {
          if (this.tenantId() !== id) return; // another business was opened meanwhile
          this.account.set(details.account);
          this.contacts.set(details.contacts);
          this.groups.set(details.groups);
          this.savedCount.set(details.saved);
          this.hiddenCount.set(details.hidden);
          this.fetched.set(true);
          this.fetching.set(false);
        },
        error: (err: Error) => {
          if (this.tenantId() !== id) return;
          this.fetchError.set(err.message);
          this.fetched.set(false);
          this.fetching.set(false);
        },
      });
  }

  /** Drop the last read when another business's accounts are opened. */
  private resetFetched(): void {
    this.contacts.set([]);
    this.groups.set([]);
    this.account.set('');
    this.savedCount.set(0);
    this.hiddenCount.set(0);
    this.fetched.set(false);
    this.fetching.set(false); // an answer for the business that was open is dropped by fetchData's guard
    this.fetchError.set('');
    this.collectionDone.set('');
  }

  /** Keep the read as the business's bulk collection, replaced on the next save. */
  protected saveCollection(): void {
    const id = this.tenantId();
    if (!this.contacts().length || this.fetching()) return;
    this.savingCollection.set(true);
    this.collectionDone.set('');
    this.http
      .post(`/api/admin/tenants/${id}/number-collections`, {
        account: this.account(),
        contacts: this.contacts().map(({ phone, name }) => ({ phone, name })),
      })
      .pipe(catchError(toMessage))
      .subscribe({
        next: () => {
          if (this.tenantId() !== id) return;
          this.savingCollection.set(false);
          this.collectionDone.set(`Saved ${this.contacts().length} numbers as this business's collection.`);
        },
        error: (err: Error) => {
          if (this.tenantId() !== id) return;
          this.savingCollection.set(false);
          this.fetchError.set(err.message);
        },
      });
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
