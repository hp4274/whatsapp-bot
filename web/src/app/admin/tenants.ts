import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { AuditLog, TenancyApi } from '../core/api';
import { Auth, Tenant, TenantControls } from '../core/auth';
import { Store } from '../core/store';
import { serviceMeta } from './service-meta';
import { TenantActivity } from './tenant-activity';
import { SettingsTab, TenantSettings } from './tenant-settings';

/** The create-tenant form, kept as one signal so it survives the services drawer. */
type TenantDraft = {
  name: string;
  slug: string;
  email: string;
  ownerName: string;
  password: string;
  services: string[];
  controls: TenantControls;
};

/** `draft` edits the unsaved form's services; `tenant` saves straight to the server. */
type ServiceDrawer =
  { mode: 'draft'; services: string[] } | { mode: 'tenant'; tenant: Tenant; services: string[] };

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

/** New tenants start with everything on; the platform admin narrows from there. */
const DEFAULT_CONTROLS: TenantControls = {
  sendingEnabled: true,
  inboundEnabled: true,
  campaignsEnabled: true,
  automationsEnabled: true,
};

const CONTROL_LABELS: Record<keyof TenantControls, string> = {
  sendingEnabled: 'Outbound sending',
  inboundEnabled: 'Inbound webhooks',
  campaignsEnabled: 'Campaign sending',
  automationsEnabled: 'Automations',
};

/** Placeholder cards shown while the first list loads. */
const SKELETON_CARDS: readonly number[] = [0, 1, 2];

/** localStorage key remembering grid vs list. */
const VIEW_KEY = 'wsender.tenantView';

const emptyDraft = (): TenantDraft => ({
  name: '',
  slug: '',
  email: '',
  ownerName: '',
  password: '',
  services: [...DEFAULT_SERVICES],
  controls: { ...DEFAULT_CONTROLS },
});

/**
 * The super admin's tenant console: create, suspend, seed, delete, and open
 * the settings drawer (controls, limits, anti-ban safety) for any business.
 *
 * The settings drawer is its own component (`TenantSettings`) with its own
 * working copy, so a half-edited drawer never changes what a tenant may do.
 */
@Component({
  selector: 'app-admin-tenants',
  imports: [FormsModule, TenantActivity, TenantSettings],
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

  protected readonly tenants = signal<Tenant[]>([]);
  protected readonly logs = signal<AuditLog[]>([]);
  protected readonly skeletonRows = SKELETON_CARDS;
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly savingId = signal<number | null>(null);
  protected readonly showForm = signal(false);
  protected readonly actingId = this.auth.actingTenantId;

  protected readonly services = signal<string[]>([...DEFAULT_SERVICES]);
  protected readonly draft = signal<TenantDraft>(emptyDraft());
  protected readonly serviceDrawer = signal<ServiceDrawer | null>(null);
  protected readonly serviceDrawerBusy = computed(() => {
    const drawer = this.serviceDrawer();
    return drawer?.mode === 'tenant' && this.savingId() === drawer.tenant.id;
  });
  protected readonly query = signal('');
  protected readonly statusFilter = signal<'all' | 'active' | 'suspended'>('all');
  protected readonly view = signal<'grid' | 'list'>(readView());
  protected readonly menuId = signal<number | null>(null);
  /** Tenant whose settings drawer is open, and the tab it opens on. */
  protected readonly settingsTenant = signal<Tenant | null>(null);
  protected readonly settingsTab = signal<SettingsTab>('general');
  /** Tenant awaiting delete confirmation; null hides the dialog. */
  protected readonly deleteTarget = signal<Tenant | null>(null);
  protected readonly seedConfirmId = signal<number | null>(null);
  protected readonly seedingId = signal<number | null>(null);
  protected readonly seedResult = signal<{ id: number; ok: boolean; text: string } | null>(null);
  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    const status = this.statusFilter();
    return this.tenants().filter(
      (tenant) =>
        (status === 'all' || tenant.status === status) &&
        (!q || `${tenant.name} ${tenant.slug}`.toLowerCase().includes(q)),
    );
  });
  protected readonly controlKeys: readonly (keyof TenantControls)[] = [
    'sendingEnabled',
    'inboundEnabled',
    'campaignsEnabled',
    'automationsEnabled',
  ];

  constructor() {
    this.refresh();
    // /admin/tenants?settings=<id>[&tab=limits|safety|rules|accounts] (linked from the ops pages) opens that drawer.
    const query = this.route.snapshot.queryParamMap;
    const wanted = Number(query.get('settings'));
    const tab = query.get('tab');
    if (wanted) {
      this.api.tenants().subscribe(({ tenants }) => {
        const tenant = tenants.find((t) => t.id === wanted);
        if (!tenant) return;
        this.openSettings(tenant, (['limits', 'safety', 'rules', 'accounts'] as const).find((t) => t === tab) ?? 'general');
      });
    }
  }

  protected refresh() {
    this.api.tenants().subscribe({
      next: ({ tenants, services }) => {
        this.services.set(services.length ? services : [...DEFAULT_SERVICES]);
        this.tenants.set(tenants);
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.loading.set(false);
        this.error.set(err.message);
      },
    });
    this.api.auditLogs().subscribe({ next: ({ logs }) => this.logs.set(logs.slice(0, 40)) });
  }

  protected create(event: Event) {
    event.preventDefault();
    if (this.duplicateDraftSlug()) {
      this.error.set('A tenant with this slug already exists.');
      return;
    }
    const d = this.draft();
    this.busy.set(true);
    this.error.set('');
    this.api
      .createTenant({
        name: d.name.trim(),
        slug: d.slug.trim() || undefined,
        services: d.services,
        controls: d.controls,
        owner: { email: d.email.trim(), name: d.ownerName.trim(), password: d.password },
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.showForm.set(false);
          this.draft.set(emptyDraft());
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
    this.statusFilter.set(value === 'active' || value === 'suspended' ? value : 'all');
  }

  protected openSettings(tenant: Tenant, tab: SettingsTab = 'general') {
    this.settingsTab.set(tab);
    this.settingsTenant.set(tenant);
  }

  protected toggleDraftService(service: string, checked: boolean) {
    const current = this.draft();
    this.draft.set({ ...current, services: toggleValue(current.services, service, checked) });
  }

  protected toggleDraftControl(key: keyof TenantControls, checked: boolean) {
    const current = this.draft();
    this.draft.set({ ...current, controls: { ...current.controls, [key]: checked } });
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected serviceLabel(service: string): string {
    return serviceMeta(service).label;
  }

  protected controlLabel(key: keyof TenantControls): string {
    return CONTROL_LABELS[key];
  }

  protected serviceSummary(services: string[]): string {
    return `${services.length} of ${this.services().length} enabled`;
  }

  protected openDraftServices() {
    this.serviceDrawer.set({ mode: 'draft', services: [...this.draft().services] });
  }

  protected openTenantServices(tenant: Tenant) {
    this.serviceDrawer.set({
      mode: 'tenant',
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
    if (drawer.mode === 'draft') {
      const current = this.draft();
      this.draft.set({ ...current, services: [...drawer.services] });
      this.serviceDrawer.set(null);
      return;
    }

    this.savingId.set(drawer.tenant.id);
    this.error.set('');
    this.api.updateTenant(drawer.tenant.id, { services: drawer.services }).subscribe({
      next: () => {
        this.savingId.set(null);
        this.serviceDrawer.set(null);
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
        if (this.actingId() === tenant.id) this.auth.actAs(null);
        this.savingId.set(null);
        const drawer = this.serviceDrawer();
        if (drawer?.mode === 'tenant' && drawer.tenant.id === tenant.id) {
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

  protected duplicateDraftSlug(): boolean {
    const draft = this.draft();
    const slug = this.slugFor(draft.slug || draft.name);
    return Boolean(slug && this.tenants().some((tenant) => tenant.slug === slug));
  }

  protected slugFor(value: string): string {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /** Enter a tenant's workspace: every later request carries its id. */
  protected open(tenant: Tenant) {
    this.auth.actAs(tenant.id);
    this.store.start();
    this.router.navigate(['/connection']);
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
