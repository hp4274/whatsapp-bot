import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';

import { TenancyApi } from '../core/api';
import { Auth, Tenant } from '../core/auth';
import { ConfirmDialog } from '../core/confirm-dialog';
import { Pager, pageOf } from '../core/pager';
import { Store } from '../core/store';
import { AdminFeed } from './admin-feed';
import type { AuditEntry } from './ops-api';
import { OpsApi } from './ops-api';
import { BILLINGS, billingOf, planEnded, stateTone } from './plans-api';
import { SOON_SERVICES, serviceMeta } from './service-meta';
import { TenantActivity } from './tenant-activity';
import { TenantNew } from './tenant-new';
import { closingSoon } from './tenants-closing';
import { SettingsTab, TenantSettings } from './tenant-settings';
import { sentenceCase } from './text';

/** A business's services being chosen in the services drawer; saved straight to the server. */
type ServiceDrawer = { tenant: Tenant; services: string[] };

/** Fallback service list for when the server does not send its catalogue. */
const DEFAULT_SERVICES: readonly string[] = [
  'school_whatsapp_bot',
  'whatsapp_channels',
  'contacts',
  'templates',
  'inbox',
  'auto_replies',
  'bulk_messages',
  'campaigns',
  'payment_reminders',
  'workflows',
  'faq',
  'tickets',
  'appointments',
  'orders',
  'leads',
  'subscriptions',
  'events',
  'api',
  'analytics',
  'integrations',
  'ai',
];

/** Least time between two live reloads of the tenant list. */
const LIVE_GAP_MS = 3000;

/** Placeholder cards shown while the first list loads. */
const SKELETON_CARDS: readonly number[] = [0, 1, 2];

/** Cards per page; a multiple of 2, 3 and 4 so grid rows fill. */
const PAGE_SIZE = 12;

/** localStorage key remembering grid vs list. */
const VIEW_KEY = 'wsender.tenantView';

/**
 * The super admin's tenant console: create, suspend, seed, delete, and open
 * the settings drawer (controls, limits, anti-ban safety) for any business.
 *
 * The settings drawer is its own component (`TenantSettings`) with its own
 * working copy, so a half-edited drawer never changes what a tenant may do.
 */
@Component({
  selector: 'app-admin-tenants',
  imports: [ConfirmDialog, NgTemplateOutlet, Pager, TenantActivity, TenantNew, TenantSettings],
  templateUrl: './tenants.html',
  styleUrl: './tenants.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantsView {
  private readonly api = inject(TenancyApi);
  private readonly auth = inject(Auth);
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly ops = inject(OpsApi);
  private readonly feed = inject(AdminFeed);

  /** Pill labels are sentence case: "past_due" reads "Past due". */
  protected readonly sentence = sentenceCase;
  protected readonly tenants = signal<Tenant[]>([]);
  protected readonly logs = signal<AuditEntry[]>([]);
  protected readonly skeletonRows = SKELETON_CARDS;
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly savingId = signal<number | null>(null);
  /** The Add tenant drawer (details first) is open. */
  protected readonly adding = signal(false);
  protected readonly actingId = this.auth.actingTenantId;

  protected readonly services = signal<string[]>([...DEFAULT_SERVICES]);
  /** The drawer's list: what a business can have (the server's), then what is coming soon, shown switched off. */
  protected readonly drawerServices = computed(() => [
    ...this.services(),
    ...[...SOON_SERVICES].filter((s) => !this.services().includes(s)),
  ]);
  /** IDs in use, for Add tenant's "already in use" hint. */
  protected readonly slugs = computed(() => this.tenants().map((t) => t.slug));
  protected readonly stateTone = stateTone;
  protected readonly serviceDrawer = signal<ServiceDrawer | null>(null);
  protected readonly serviceDrawerBusy = computed(() => {
    const drawer = this.serviceDrawer();
    return Boolean(drawer) && this.savingId() === drawer?.tenant.id;
  });
  protected readonly query = signal('');
  protected readonly statusFilter = signal<'all' | 'active' | 'suspended' | 'pending'>('all');
  protected readonly view = signal<'grid' | 'list'>(readView());
  private readonly wideQuery = matchMedia('(min-width: 1101px)');
  private readonly wide = signal(this.wideQuery.matches);
  /** The list's table needs the room: on a narrower screen, list view shows the cards. */
  protected readonly listMode = computed(() => this.view() === 'list' && this.wide());
  protected readonly menuId = signal<number | null>(null);
  /** Tenant whose settings drawer is open, and the tab it opens on. */
  protected readonly settingsTenant = signal<Tenant | null>(null);
  protected readonly settingsTab = signal<SettingsTab>('plan');
  /** Tenant awaiting delete confirmation; null hides the dialog. */
  protected readonly deleteTarget = signal<Tenant | null>(null);
  protected readonly seedConfirmId = signal<number | null>(null);
  protected readonly seedingId = signal<number | null>(null);
  protected readonly seedResult = signal<{ id: number; ok: boolean; text: string } | null>(null);
  private readonly matches = (tenant: Tenant) => {
    const q = this.query().trim().toLowerCase();
    return !q || `${tenant.name} ${tenant.slug}`.toLowerCase().includes(q);
  };
  /** Running businesses (active or suspended): the main, paged list. Pending ones have their own block above. */
  protected readonly visible = computed(() => {
    const status = this.statusFilter();
    return this.tenants().filter(
      (tenant) =>
        tenant.status !== 'pending' &&
        !planEnded(tenant.subscription) &&
        !this.closing().has(tenant.id) &&
        (status === 'all' || tenant.status === status) &&
        this.matches(tenant),
    );
  });
  /** Running businesses whose plan ends in the next 7 days, and the line each card says it with. */
  private readonly closing = computed(() => {
    const now = Date.now();
    const out = new Map<number, { at: number; note: string }>();
    for (const t of this.tenants()) {
      if (t.status === 'pending' || planEnded(t.subscription)) continue;
      const end = closingSoon(t.subscription, now);
      if (end) out.set(t.id, end);
    }
    return out;
  });
  /** Closing soon, as its own section of cards: soonest first. */
  protected readonly closingShown = computed(() => {
    const status = this.statusFilter();
    const closing = this.closing();
    return this.tenants()
      .filter((t) => closing.has(t.id) && (status === 'all' || t.status === status) && this.matches(t))
      .sort((a, b) => closing.get(a.id)!.at - closing.get(b.id)!.at);
  });
  protected closingNote(tenant: Tenant): string {
    return this.closing().get(tenant.id)?.note ?? '';
  }
  /** Under the running ones: businesses whose plan was ended, or is set to end at its period's end. */
  protected readonly endedShown = computed(() => {
    const status = this.statusFilter();
    return this.tenants().filter(
      (tenant) =>
        tenant.status !== 'pending' &&
        planEnded(tenant.subscription) &&
        (status === 'all' || tenant.status === status) &&
        this.matches(tenant),
    );
  });
  /** Accepted from leads, not yet activated: shown first under "Pending setup" (all or the Pending filter). */
  protected readonly pendingShown = computed(() => {
    const status = this.statusFilter();
    if (status !== 'all' && status !== 'pending') return [];
    return this.tenants().filter((tenant) => tenant.status === 'pending' && this.matches(tenant));
  });
  /** Whether any business is running, for the main list's empty message. */
  protected readonly running = computed(() => this.tenants().some((t) => t.status !== 'pending'));
  /**
   * The number each card shows: its place in the list (1, 2, 3...), oldest first, not the database id, which has
   * gaps where businesses were deleted.
   */
  private readonly serials = computed(() => new Map(this.tenants().map((t, i) => [t.id, i + 1])));
  protected serial(tenant: Tenant): number {
    return this.serials().get(tenant.id) ?? 0;
  }
  /** `serial` as a value, for the closing-soon list. */
  protected readonly serialOf = (tenant: Tenant) => this.serial(tenant);
  protected readonly pageSize = PAGE_SIZE;
  /** Back to the first page when the search or status filter changes; a live reload keeps the page. */
  protected readonly page = linkedSignal(() => {
    this.query();
    this.statusFilter();
    return 0;
  });
  protected readonly shown = computed(() => pageOf(this.visible(), this.page(), PAGE_SIZE));

  constructor() {
    this.refresh();
    // /admin/tenants?settings=<id>[&tab=limits|safety|rules|accounts|plan|payments] (linked from the ops pages) opens that drawer.
    // Followed while the page is open too, so the notifications bell can open a business from here.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((query) => {
      const wanted = Number(query.get('settings'));
      const tab = query.get('tab');
      if (!wanted) return;
      this.api.tenants().subscribe(({ tenants }) => {
        const tenant = tenants.find((t) => t.id === wanted);
        if (!tenant) return;
        this.openSettings(tenant, (['general', 'limits', 'safety', 'rules', 'accounts', 'plan', 'payments'] as const).find((t) => t === tab) ?? 'plan');
      });
    });
    // Live: another admin's change, a number dropping or a campaign sending updates the cards and the activity.
    this.feed.watch(['tenants', 'channels', 'usage'], () => this.liveList());
    this.feed.watch(['audit'], () => this.loadActivity());
    const resized = () => this.wide.set(this.wideQuery.matches);
    this.wideQuery.addEventListener('change', resized);
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.liveTimer);
      this.wideQuery.removeEventListener('change', resized);
    });
  }

  private liveTimer?: ReturnType<typeof setTimeout>;
  private lastLive = 0;

  /**
   * At most one quiet list reload per LIVE_GAP_MS: `usage` arrives up to every 700 ms while a campaign sends, and a
   * debounce alone would never fire under that.
   */
  private liveList() {
    if (this.liveTimer) return;
    this.liveTimer = setTimeout(() => {
      this.liveTimer = undefined;
      this.lastLive = Date.now();
      this.loadTenants(true);
    }, Math.max(0, this.lastLive + LIVE_GAP_MS - Date.now()));
  }

  protected refresh() {
    this.loadTenants(false);
    this.loadActivity();
  }

  /** `quiet`: a live reload keeps a shown error until it succeeds and never flashes the skeleton. */
  private loadTenants(quiet: boolean) {
    this.api.tenants().subscribe({
      next: ({ tenants, services }) => {
        this.services.set(services.length ? services : [...DEFAULT_SERVICES]);
        this.tenants.set(tenants);
        this.loading.set(false);
        if (quiet) this.error.set('');
      },
      error: (err: Error) => {
        this.loading.set(false);
        if (!quiet) this.error.set(err.message);
      },
    });
  }

  /** The recent-activity panel: sentences and actors from the audit search (server: auditText.js). */
  private loadActivity() {
    this.ops.audit({}, null, 12).subscribe({
      next: ({ logs }) => this.logs.set(logs),
      error: () => undefined, // the panel keeps what it showed
    });
  }

  /** Added as pending: straight on to step 2, its settings drawer, to set it up and activate it. */
  protected added(tenant: Tenant) {
    this.adding.set(false);
    this.refresh();
    this.openSettings(tenant, 'plan');
  }

  protected toggleStatus(tenant: Tenant) {
    const next = tenant.status === 'active' ? 'suspended' : 'active';
    this.menuId.set(null);
    this.savingId.set(tenant.id);
    this.error.set('');
    this.api.setTenantStatus(tenant.id, next).subscribe({
      next: () => {
        this.savingId.set(null);
        this.refresh();
      },
      error: (err: Error) => {
        this.savingId.set(null);
        this.error.set(err.message);
      },
    });
  }

  protected setView(view: 'grid' | 'list') {
    this.view.set(view);
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // storage blocked: the choice just will not persist
    }
  }

  protected toggleMenu(tenant: Tenant) {
    this.menuId.set(this.menuId() === tenant.id ? null : tenant.id);
  }

  protected setStatusFilter(value: string) {
    this.statusFilter.set(value === 'active' || value === 'suspended' || value === 'pending' ? value : 'all');
  }

  protected openSettings(tenant: Tenant, tab: SettingsTab = 'plan') {
    this.settingsTab.set(tab);
    this.settingsTenant.set(tenant);
  }

  /** Paid, Free or Hybrid (free with charged top-ups), for the plan pill. */
  protected billingOf(tenant: Tenant) {
    const billing = billingOf(tenant.subscription?.payment, tenant.balance?.topupCharged ?? 0);
    return billing ? BILLINGS[billing] : null;
  }

  protected serviceLabel(service: string): string {
    return serviceMeta(service).label;
  }

  /** Not open yet: shown, but it cannot be switched. */
  protected soon(service: string): boolean {
    return SOON_SERVICES.has(service);
  }

  /** Pending, Suspended, Inactive (active but its plan ended) or Active, with its tone. */
  protected statusOf(tenant: Tenant): { label: string; tone: string } {
    if (tenant.status === 'pending') return { label: 'Pending', tone: 'tone-info' };
    if (tenant.status === 'suspended') return { label: 'Suspended', tone: 'tone-warn' };
    if (tenant.status === 'archived') return { label: 'Archived', tone: 'tone-mute' };
    if (planEnded(tenant.subscription)) return { label: 'Inactive', tone: 'tone-mute' };
    return { label: 'Active', tone: 'tone-ok' };
  }

  protected serviceIcon(service: string): string {
    return serviceMeta(service).icon;
  }

  protected serviceSummary(services: string[]): string {
    return `${services.length} of ${this.services().length} enabled`;
  }

  /** Choose services from Tenant settings: opens the drawer, or closes it when it is already open for this business. */
  protected openTenantServices(tenant: Tenant) {
    if (this.serviceDrawer()?.tenant.id === tenant.id) return this.closeServiceDrawer();
    this.serviceDrawer.set({
      tenant,
      services: [...(tenant.services ?? this.services())],
    });
  }

  protected closeServiceDrawer() {
    if (!this.serviceDrawerBusy()) this.serviceDrawer.set(null);
  }

  protected toggleDrawerService(service: string, checked: boolean) {
    const drawer = this.serviceDrawer();
    if (!drawer) return;
    this.serviceDrawer.set({ ...drawer, services: toggleValue(drawer.services, service, checked) });
  }

  protected saveServices() {
    const drawer = this.serviceDrawer();
    if (!drawer) return;
    this.savingId.set(drawer.tenant.id);
    this.error.set('');
    this.api.updateTenant(drawer.tenant.id, { services: drawer.services }).subscribe({
      next: () => {
        this.savingId.set(null);
        this.serviceDrawer.set(null);
        // Opened from Tenant settings: it shows the new services too, not the count it opened with.
        const open = this.settingsTenant();
        if (open?.id === drawer.tenant.id) this.settingsTenant.set({ ...open, services: [...drawer.services] });
        this.refresh();
      },
      error: (err: Error) => {
        this.savingId.set(null);
        this.error.set(err.message);
      },
    });
  }

  protected askSeed(tenant: Tenant) {
    this.menuId.set(null);
    this.seedResult.set(null);
    this.seedConfirmId.set(tenant.id);
  }

  protected seed(tenant: Tenant) {
    this.seedingId.set(tenant.id);
    this.error.set('');
    this.api.seedTenant(tenant.id).subscribe({
      next: ({ created }) => {
        const parts = Object.entries(created).map(
          ([key, n]) => `${n} ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}`,
        );
        this.seedingId.set(null);
        this.seedConfirmId.set(null);
        this.seedResult.set({
          id: tenant.id,
          ok: true,
          text: parts.length
            ? `Added ${parts.join(', ')}.`
            : 'Demo data is already in place - nothing new to add.',
        });
        this.refresh();
      },
      error: (err: Error) => {
        this.seedingId.set(null);
        this.seedResult.set({ id: tenant.id, ok: false, text: err.message });
      },
    });
  }

  protected askDelete(tenant: Tenant) {
    this.deleteTarget.set(tenant);
  }

  protected cancelDelete() {
    this.deleteTarget.set(null);
  }

  /** Archives the tenant; the dialog has already asked, so this does not ask again. */
  protected deleteTenant(tenant: Tenant) {
    this.deleteTarget.set(null);
    this.savingId.set(tenant.id);
    this.error.set('');
    this.api.deleteTenant(tenant.id).subscribe({
      next: () => {
        if (this.actingId() === tenant.id) {
          // The stream was opened for this tenant: close it before the id is dropped.
          this.store.stop();
          this.auth.actAs(null);
        }
        this.savingId.set(null);
        const drawer = this.serviceDrawer();
        if (drawer?.tenant.id === tenant.id) {
          this.serviceDrawer.set(null);
        }
        this.refresh();
      },
      error: (err: Error) => {
        this.savingId.set(null);
        this.error.set(err.message);
      },
    });
  }

  /** Enter a tenant's workspace: every later request carries its id. */
  protected open(tenant: Tenant) {
    // start() is a no-op while a stream is open, so a previous tenant's would keep running.
    this.store.stop();
    this.auth.actAs(tenant.id);
    this.store.start();
    this.router.navigate(['/home']);
  }
}

function toggleValue(values: string[], value: string, checked: boolean): string[] {
  const set = new Set(values);
  if (checked) set.add(value);
  else set.delete(value);
  return [...set];
}

function readView(): 'grid' | 'list' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}
