import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TenancyApi } from '../core/api';
import type { Tenant } from '../core/auth';

/** A business's ID as the server makes it from what was typed (tenancy.js cleanTenantInput). */
export function slugFor(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Add tenant, step 1 of 2: who the business is and how to reach it. Continuing adds it as pending on the first
 * plan, and the parent opens its settings drawer for step 2, set up and activate, exactly as for an accepted lead.
 */
@Component({
  selector: 'app-tenant-new',
  imports: [FormsModule],
  templateUrl: './tenant-new.html',
  styleUrl: './tenant-new.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantNew {
  private readonly api = inject(TenancyApi);

  /** IDs already in use, for the "already in use" hint before the server is asked. */
  readonly taken = input<readonly string[]>([]);
  /** Added as pending: the parent opens its setup. */
  readonly created = output<Tenant>();
  readonly closed = output<void>();

  protected readonly name = signal('');
  protected readonly slug = signal('');
  protected readonly ownerName = signal('');
  protected readonly email = signal('');
  protected readonly phone = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  /** The ID it will get: what was typed, else made from the name. */
  protected readonly id = computed(() => slugFor(this.slug() || this.name()));
  protected readonly idTaken = computed(() => Boolean(this.id()) && this.taken().includes(this.id()));

  protected close(): void {
    if (!this.busy()) this.closed.emit();
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.busy() || this.idTaken() || !(event.target as HTMLFormElement).reportValidity()) return;
    this.busy.set(true);
    this.error.set('');
    this.api
      .createTenant({
        name: this.name().trim(),
        slug: this.slug().trim() || undefined,
        status: 'pending',
        contactPhone: this.phone().trim(),
        owner: { name: this.ownerName().trim(), email: this.email().trim() },
      })
      .subscribe({
        next: ({ tenant }) => {
          this.busy.set(false);
          this.created.emit(tenant);
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message);
        },
      });
  }
}
