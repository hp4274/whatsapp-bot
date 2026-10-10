import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';

import { TenancyApi } from '../core/api';
import { AuditEntry, AuditFilter, AuditVerb, OpsApi } from './ops-api';

const PAGE = 50;

/** Audit log search: filters, keyset pages loaded as you scroll, expandable detail, CSV export. */
@Component({
  selector: 'app-ops-audit',
  templateUrl: './ops-audit.html',
  styleUrl: './ops-audit.scss',
})
export class OpsAudit {
  private readonly api = inject(OpsApi);
  private readonly more = viewChild<ElementRef<HTMLElement>>('more');

  protected readonly filter = signal<AuditFilter>({});
  protected readonly logs = signal<AuditEntry[]>([]);
  protected readonly next = signal<number | null>(null);
  protected readonly users = signal<{ id: number; email: string }[]>([]);
  protected readonly tenants = signal<{ id: number; name: string }[]>([]);
  protected readonly loading = signal(false);
  protected readonly exporting = signal(false);
  protected readonly error = signal('');
  protected readonly open = signal<ReadonlySet<number>>(new Set());
  protected readonly active = computed(() => Object.values(this.filter()).some(Boolean));
  protected readonly verbs: { k: '' | AuditVerb; l: string }[] = [
    { k: '', l: 'All' }, { k: 'create', l: 'Create' }, { k: 'change', l: 'Change' }, { k: 'remove', l: 'Remove' },
  ];

  private seq = 0;
  private typing?: ReturnType<typeof setTimeout>;

  constructor() {
    inject(TenancyApi).tenants().subscribe({
      next: ({ tenants }) => this.tenants.set(tenants.map((t) => ({ id: t.id, name: t.name }))),
      error: () => undefined, // names fall back to "Tenant N"
    });
    this.reload();

    // Infinite scroll: load the next page when the sentinel comes into view.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.loadMore();
    }, { rootMargin: '240px' });
    effect((onCleanup) => {
      const el = this.more()?.nativeElement;
      if (!el) return;
      observer.observe(el);
      onCleanup(() => observer.unobserve(el));
    });
    inject(DestroyRef).onDestroy(() => { observer.disconnect(); clearTimeout(this.typing); });
  }

  reload() {
    this.fetch(null);
  }

  private fetch(before: number | null) {
    const seq = ++this.seq; // a newer filter wins over a slow older page
    this.loading.set(true);
    this.error.set('');
    this.api.audit(this.filter(), before, PAGE).subscribe({
      next: (page) => {
        if (seq !== this.seq) return;
        this.logs.set(before ? [...this.logs(), ...page.logs] : page.logs);
        if (page.users) this.users.set(page.users);
        this.next.set(page.nextBefore);
        this.loading.set(false);
      },
      error: (err: Error) => {
        if (seq !== this.seq) return;
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected loadMore() {
    const next = this.next();
    if (next && !this.loading()) this.fetch(next);
  }

  protected set(key: keyof AuditFilter, value: string) {
    this.filter.update((f) => ({ ...f, [key]: value }));
    this.open.set(new Set());
    this.reload();
  }

  protected fromEvent(key: keyof AuditFilter, e: Event) {
    const value = (e.target as HTMLInputElement | HTMLSelectElement).value;
    if (key !== 'q') return this.set(key, value);
    clearTimeout(this.typing);
    this.typing = setTimeout(() => this.set('q', value.trim()), 300);
  }

  protected clear() {
    this.filter.set({});
    this.reload();
  }

  protected toggle(id: number) {
    const next = new Set(this.open());
    if (!next.delete(id)) next.add(id);
    this.open.set(next);
  }

  protected exportCsv() {
    this.exporting.set(true);
    this.api.auditCsv(this.filter()).subscribe({
      next: (csv) => {
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.exporting.set(false);
      },
      error: (err: Error) => { this.error.set(err.message); this.exporting.set(false); },
    });
  }

  protected tenantName(id: number | null): string {
    if (id === null) return 'Platform';
    return this.tenants().find((t) => t.id === id)?.name ?? `Tenant ${id}`;
  }

  /** Detail as pretty JSON when it is JSON, otherwise as written. */
  protected pretty(detail: string): string {
    try {
      const value = JSON.parse(detail);
      return typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value);
    } catch {
      return detail;
    }
  }

  protected ago(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  protected full(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }
}
