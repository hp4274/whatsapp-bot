import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';

import { AdminFeed } from './admin-feed';
import { AuditEntry, AuditFilter, AuditVerb, OpsApi } from './ops-api';

/** Lines per page; "Load more" fetches the next. */
const PAGE = 20;

/**
 * Tenant settings > General > Logs: this business's audit trail as sentences, newest first, filtered by words,
 * kind of change and dates. New entries arrive live; older ones load on demand.
 */
@Component({
  selector: 'app-tenant-logs',
  imports: [DatePipe],
  templateUrl: './tenant-logs.html',
  styleUrl: './tenant-logs.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantLogs {
  private readonly api = inject(OpsApi);

  readonly tenantId = input.required<number>();

  protected readonly verbs: readonly { readonly key: '' | AuditVerb; readonly label: string }[] = [
    { key: '', label: 'All' },
    { key: 'create', label: 'Added' },
    { key: 'change', label: 'Changed' },
    { key: 'remove', label: 'Removed' },
    { key: 'other', label: 'Other' },
  ];
  protected readonly q = signal('');
  protected readonly verb = signal<'' | AuditVerb>('');
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly logs = signal<AuditEntry[] | null>(null);
  protected readonly next = signal<number | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  /** Bumped per load so an older answer never replaces a newer filter's. */
  private seq = 0;
  private typing?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => {
      this.tenantId();
      untracked(() => this.reload());
    });
    inject(AdminFeed).watch(['audit'], () => this.reload());
    inject(DestroyRef).onDestroy(() => clearTimeout(this.typing));
  }

  private filter(): AuditFilter {
    return {
      tenant: String(this.tenantId()),
      ...(this.q().trim() ? { q: this.q().trim() } : {}),
      ...(this.verb() ? { verb: this.verb() } : {}),
      // Whole days, as the server takes them (YYYY-MM-DD, both inclusive).
      ...(this.from() ? { from: this.from() } : {}),
      ...(this.to() ? { to: this.to() } : {}),
    };
  }

  protected reload() {
    const seq = ++this.seq;
    this.loading.set(true);
    this.api.audit(this.filter(), null, PAGE).subscribe({
      next: ({ logs, nextBefore }) => {
        if (seq !== this.seq) return;
        this.logs.set(logs);
        this.next.set(nextBefore);
        this.loading.set(false);
        this.error.set('');
      },
      error: (err: Error) => {
        if (seq !== this.seq) return;
        this.loading.set(false);
        this.error.set(err.message);
      },
    });
  }

  protected more() {
    const before = this.next();
    if (before == null || this.loading()) return;
    const seq = this.seq;
    this.loading.set(true);
    this.api.audit(this.filter(), before, PAGE).subscribe({
      next: ({ logs, nextBefore }) => {
        if (seq !== this.seq) return;
        this.logs.update((cur) => [...(cur ?? []), ...logs]);
        this.next.set(nextBefore);
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.loading.set(false);
        this.error.set(err.message);
      },
    });
  }

  /** Typing waits a moment, so each key does not search. */
  protected search(text: string) {
    this.q.set(text);
    clearTimeout(this.typing);
    this.typing = setTimeout(() => this.reload(), 300);
  }

  protected setVerb(verb: '' | AuditVerb) {
    this.verb.set(verb);
    this.reload();
  }

  protected setDay(which: 'from' | 'to', day: string) {
    (which === 'from' ? this.from : this.to).set(day);
    this.reload();
  }

  protected clear() {
    this.q.set('');
    this.verb.set('');
    this.from.set('');
    this.to.set('');
    this.reload();
  }

  protected actor(entry: AuditEntry): string {
    return entry.actor === 'System' ? 'System' : entry.actor.name || entry.actor.email || entry.userEmail || 'System';
  }
}
