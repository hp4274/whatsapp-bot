import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { AuditLog, TenancyApi } from '../core/api';
import { Auth, Tenant } from '../core/auth';
import { Store } from '../core/store';

@Component({
  selector: 'app-admin-tenants',
  imports: [FormsModule],
  templateUrl: './tenants.html',
  styleUrl: './tenants.scss',
})
export class TenantsView {
  private readonly api = inject(TenancyApi);
  private readonly auth = inject(Auth);
  private readonly store = inject(Store);
  private readonly router = inject(Router);

  protected readonly tenants = signal<Tenant[]>([]);
  protected readonly logs = signal<AuditLog[]>([]);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly showForm = signal(false);
  protected readonly actingId = this.auth.actingTenantId;

  protected readonly draft = signal({ name: '', slug: '', email: '', ownerName: '', password: '' });

  constructor() {
    this.refresh();
  }

  protected refresh() {
    this.api.tenants().subscribe({
      next: ({ tenants }) => this.tenants.set(tenants),
      error: (err: Error) => this.error.set(err.message),
    });
    this.api.auditLogs().subscribe({ next: ({ logs }) => this.logs.set(logs.slice(0, 40)) });
  }

  protected create(event: Event) {
    event.preventDefault();
    const d = this.draft();
    this.busy.set(true);
    this.error.set('');
    this.api
      .createTenant({
        name: d.name.trim(),
        slug: d.slug.trim() || undefined,
        owner: { email: d.email.trim(), name: d.ownerName.trim(), password: d.password },
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.showForm.set(false);
          this.draft.set({ name: '', slug: '', email: '', ownerName: '', password: '' });
          this.refresh();
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message);
        },
      });
  }

  protected toggleStatus(tenant: Tenant) {
    const next = tenant.status === 'active' ? 'suspended' : 'active';
    this.api.setTenantStatus(tenant.id, next).subscribe({
      next: () => this.refresh(),
      error: (err: Error) => this.error.set(err.message),
    });
  }

  /** Enter a tenant's workspace: every later request carries its id. */
  protected open(tenant: Tenant) {
    this.auth.actAs(tenant.id);
    this.store.start();
    this.router.navigate(['/connection']);
  }
}
