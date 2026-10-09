import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import { SchoolCatalog, SchoolProvisionResult, TenancyApi } from '../core/api';
import { Tenant } from '../core/auth';
import { serviceMeta } from './service-meta';

const DEFAULT_DAILY_CAP = 250;
const SCHOOL_SERVICE = 'school_whatsapp_bot';
const STUDENT_EXAMPLE_ROW = '24,Aarav Mehta,10,A,Rakesh Mehta,Neha Mehta,9876512001,4,No';

/** One service, across every tenant: who has it, and the limits that bound it. */
@Component({
  selector: 'app-admin-service',
  templateUrl: './service.html',
  styleUrl: './service.scss',
})
export class ServiceView {
  private readonly api = inject(TenancyApi);
  private readonly key = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('service') ?? '')),
    { initialValue: '' },
  );

  protected readonly tenants = signal<Tenant[]>([]);
  protected readonly busyId = signal<number | null>(null);
  protected readonly error = signal('');
  protected readonly meta = computed(() => serviceMeta(this.key()));
  protected readonly catalog = signal<SchoolCatalog | null>(null);
  protected readonly picked = signal<Set<string>>(new Set());
  protected readonly showTemplates = signal(false);
  protected readonly provisioningId = signal<number | null>(null);
  protected readonly results = signal<Record<number, SchoolProvisionResult | string>>({});
  protected readonly isSchool = computed(() => this.key() === SCHOOL_SERVICE);
  protected readonly enabledCount = computed(
    () => this.tenants().filter((tenant) => this.has(tenant)).length,
  );

  constructor() {
    this.refresh();
    this.api.schoolCatalog().subscribe({
      next: (catalog) => {
        this.catalog.set(catalog);
        this.picked.set(new Set(catalog.recipes.map((r) => r.key)));
      },
      error: () => undefined, // only the school panel needs it
    });
  }

  protected pick(key: string, on: boolean) {
    const next = new Set(this.picked());
    if (on) next.add(key);
    else next.delete(key);
    this.picked.set(next);
  }

  protected provision(tenant: Tenant) {
    this.provisioningId.set(tenant.id);
    this.results.update((all) => ({ ...all, [tenant.id]: '' }));
    this.api.provisionSchool(tenant.id, { recipes: [...this.picked()] }).subscribe({
      next: (result) => {
        this.provisioningId.set(null);
        this.results.update((all) => ({ ...all, [tenant.id]: result }));
      },
      error: (err: Error) => {
        this.provisioningId.set(null);
        this.results.update((all) => ({ ...all, [tenant.id]: err.message }));
      },
    });
  }

  protected result(tenant: Tenant): SchoolProvisionResult | null {
    const r = this.results()[tenant.id];
    return r && typeof r !== 'string' ? r : null;
  }

  protected resultError(tenant: Tenant): string {
    const r = this.results()[tenant.id];
    return typeof r === 'string' ? r : '';
  }

  protected downloadStudentCsv() {
    const columns = this.catalog()?.studentColumns ?? [];
    const blob = new Blob([columns.join(',') + '\n' + STUDENT_EXAMPLE_ROW + '\n'], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'students-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  protected has(tenant: Tenant): boolean {
    return tenant.services.includes(this.key());
  }

  protected cap(tenant: Tenant): number {
    return Number(tenant.safety?.['dailyLimit'] ?? DEFAULT_DAILY_CAP);
  }

  protected toggle(tenant: Tenant, enabled: boolean) {
    const services = enabled
      ? [...tenant.services, this.key()]
      : tenant.services.filter((service) => service !== this.key());
    this.busyId.set(tenant.id);
    this.error.set('');
    this.api.updateTenant(tenant.id, { services }).subscribe({
      next: () => {
        this.busyId.set(null);
        this.refresh();
      },
      error: (err: Error) => {
        this.busyId.set(null);
        this.error.set(err.message);
        this.refresh();
      },
    });
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  private refresh() {
    this.api.tenants().subscribe({
      next: ({ tenants }) => this.tenants.set(tenants),
      error: (err: Error) => this.error.set(err.message),
    });
  }
}
