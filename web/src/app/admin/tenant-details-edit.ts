import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TenancyApi, TenantDetails } from '../core/api';
import type { Tenant } from '../core/auth';
import { LeadsApi } from './leads-api';

/**
 * Tenant settings > Edit, in the drawer's left column: the business's name, ID, contact WhatsApp and whether Wapzo
 * messages it, and its owner's name and sign-in email. Saved together; a refused email or ID changes nothing.
 */
@Component({
  selector: 'app-tenant-details-edit',
  imports: [FormsModule],
  templateUrl: './tenant-details-edit.html',
  styleUrl: './tenant-details-edit.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantDetailsEdit implements OnInit {
  private readonly api = inject(TenancyApi);
  private readonly leadsApi = inject(LeadsApi);

  readonly tenant = input.required<Tenant>();
  /** Saved: the business as it is now. */
  readonly saved = output<Tenant>();
  readonly cancelled = output<void>();

  protected readonly form = signal<Required<TenantDetails>>({
    name: '',
    slug: '',
    contactPhone: '',
    wapzoUpdates: true,
    ownerName: '',
    ownerEmail: '',
  });
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  ngOnInit(): void {
    const t = this.tenant();
    this.form.set({
      name: t.name,
      slug: t.slug,
      contactPhone: t.contactPhone ?? '',
      wapzoUpdates: t.wapzoUpdates !== false,
      ownerName: '',
      ownerEmail: '',
    });
    // The owner is not on the business row: read it so the form starts from what is saved.
    this.leadsApi.users(t.id).subscribe({
      next: ({ users }) => {
        const owner = users.find((u) => u.role === 'owner');
        if (owner) this.form.update((f) => ({ ...f, ownerName: owner.name ?? '', ownerEmail: owner.email }));
      },
      error: () => undefined,
    });
  }

  protected set<K extends keyof TenantDetails>(key: K, value: Required<TenantDetails>[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.busy() || !(event.target as HTMLFormElement).reportValidity()) return;
    const f = this.form();
    this.busy.set(true);
    this.error.set('');
    this.api
      .updateDetails(this.tenant().id, {
        ...f,
        name: f.name.trim(),
        slug: f.slug.trim(),
        contactPhone: f.contactPhone.trim(),
        ownerName: f.ownerName.trim(),
        // An owner the form never loaded keeps their email.
        ...(f.ownerEmail.trim() ? { ownerEmail: f.ownerEmail.trim() } : { ownerEmail: undefined }),
      })
      .subscribe({
        next: ({ tenant }) => {
          this.busy.set(false);
          this.saved.emit(tenant);
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message);
        },
      });
  }
}
