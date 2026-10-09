import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';

import { AuditLog, TenancyApi } from '../core/api';
import { Tenant } from '../core/auth';
import { serviceMeta } from './service-meta';

type PageKind = 'plans' | 'usage' | 'health' | 'audit' | 'channels';

const COPY: Record<PageKind, { title: string; lede: string; icon: string }> = {
  plans: { title: 'Plans', lede: 'Which services each business can use. Change them from the tenant settings.', icon: 'workspace_premium' },
  usage: { title: 'Usage', lede: 'Messages sent, failed and waiting, per business.', icon: 'monitoring' },
  health: { title: 'Health', lede: 'Whether every connected number is running and allowed to send right now.', icon: 'health_and_safety' },
  audit: { title: 'Audit logs', lede: 'Every change made by an admin, newest first.', icon: 'manage_search' },
  channels: { title: 'Channels', lede: 'Every WhatsApp number on the platform and its state.', icon: 'smartphone' },
};

@Component({
  selector: 'app-admin-ops',
  imports: [RouterLink],
  templateUrl: './ops.html',
  styleUrl: './ops.scss',
})
export class AdminOpsView {
  private readonly tenancy = inject(TenancyApi);
  private readonly kind = toSignal(
    inject(ActivatedRoute).data.pipe(map((data) => data['kind'] as PageKind)),
    { initialValue: 'plans' as PageKind },
  );

  protected readonly kindValue = this.kind;
  protected readonly copy = computed(() => COPY[this.kind()]);
  protected readonly error = signal('');
  protected readonly loading = signal(true);
  protected readonly tenants = signal<Tenant[]>([]);
  protected readonly allServices = signal<string[]>([]);
  protected readonly logs = signal<AuditLog[]>([]);
  protected readonly filter = signal('');

  protected readonly totals = computed(() => {
    const t = this.tenants();
    const sum = (f: (x: Tenant) => number) => t.reduce((n, x) => n + f(x), 0);
    const sent = sum((x) => x.health?.sent ?? 0);
    const failed = sum((x) => x.health?.failed ?? 0);
    return {
      tenants: t.length,
      active: t.filter((x) => x.status === 'active').length,
      channels: sum((x) => x.channels?.length ?? 0),
      sent, failed,
      queued: sum((x) => x.health?.queued ?? 0),
      running: sum((x) => x.health?.running ?? 0),
      disabled: sum((x) => x.health?.disabled ?? 0),
      outside: sum((x) => x.health?.outsideWindow ?? 0),
      rate: sent + failed ? Math.round((sent / (sent + failed)) * 1000) / 10 : 100,
    };
  });
  protected readonly maxVolume = computed(() =>
    Math.max(1, ...this.tenants().map((x) => (x.health?.sent ?? 0) + (x.health?.failed ?? 0) + (x.health?.queued ?? 0))));
  protected readonly tenantChannels = computed(() => this.tenants().flatMap((tenant) =>
    (tenant.channels ?? []).map((channel) => ({ tenant, channel })),
  ));
  protected readonly shownLogs = computed(() => {
    const q = this.filter().trim().toLowerCase();
    if (!q) return this.logs();
    return this.logs().filter((l) => `${l.action} ${l.target} ${l.detail} ${this.tenantName(l.tenantId)}`.toLowerCase().includes(q));
  });

  constructor() {
    this.load();
    // /api/admin is not broadcast; poll the live-ish pages quietly.
    const timer = setInterval(() => {
      if (['usage', 'health'].includes(this.kind()) && !document.hidden) this.load(true);
    }, 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected load(quiet = false) {
    if (!quiet) {
      this.loading.set(true);
      this.error.set('');
    }
    this.tenancy.tenants().subscribe({
      next: ({ tenants, services }) => {
        this.tenants.set(tenants);
        this.allServices.set(services ?? []);
        if (this.kind() !== 'audit') this.loading.set(false);
      },
      error: (err: Error) => { this.error.set(err.message); this.loading.set(false); },
    });
    if (this.kind() === 'audit') {
      this.tenancy.auditLogs().subscribe({
        next: ({ logs }) => { this.logs.set(logs); this.loading.set(false); },
        error: (err: Error) => { this.error.set(err.message); this.loading.set(false); },
      });
    }
  }

  protected setFilter(e: Event) {
    this.filter.set((e.target as HTMLInputElement).value);
  }

  protected initial(name: string): string {
    return (name.trim()[0] ?? '?').toUpperCase();
  }

  protected meta(key: string) {
    return serviceMeta(key);
  }

  protected pct(part: number, whole: number): number {
    return whole ? Math.round((part / whole) * 100) : 0;
  }

  protected volumeWidth(n: number): number {
    return (n / this.maxVolume()) * 100;
  }

  protected tenantName(id: number | null): string {
    if (id === null) return 'Platform';
    return this.tenants().find((tenant) => tenant.id === id)?.name ?? `Tenant ${id}`;
  }

  /** "5 min ago" for recent entries, a date after a day. */
  protected ago(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  protected verb(action: string): 'create' | 'change' | 'remove' | 'other' {
    const a = action.toUpperCase();
    if (a.startsWith('POST') || /CREATE/.test(a)) return 'create';
    if (a.startsWith('PUT') || a.startsWith('PATCH') || /UPDATE|SAFETY|PROVISION/.test(a)) return 'change';
    if (a.startsWith('DELETE') || /DELETE|REMOVE/.test(a)) return 'remove';
    return 'other';
  }
}
