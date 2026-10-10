import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { forkJoin } from 'rxjs';

import { AuditLog, CustomSafetyState, SafetyPolicy, TenancyApi, TenantLimits } from '../core/api';
import { SAFETY_GROUPS } from '../core/safety-fields';
import { Auth, Tenant, TenantControls } from '../core/auth';
import { Store } from '../core/store';
import { serviceMeta } from './service-meta';

type TenantDraft = {
  name: string;
  slug: string;
  email: string;
  ownerName: string;
  password: string;
  services: string[];
  controls: TenantControls;
};

type ServiceDrawer =
  | { mode: 'draft'; services: string[] }
  | { mode: 'tenant'; tenant: Tenant; services: string[] };

const DEFAULT_SERVICES = [
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

type SettingsDrawer = {
  tenant: Tenant;
  controls: TenantControls;
  safety: SafetyPolicy | null;
  custom: CustomSafetyState | null;
  limits: TenantLimits;
};

type SettingsTab = 'general' | 'limits' | 'safety';

const DEFAULT_LIMITS: TenantLimits = {
  maxChannels: 0, maxUsers: 0, maxTemplates: 0, maxContactsPerCampaign: 0, maxMediaMb: 0,
  allowCloudApi: true, allowWhatsappWeb: true, blockedWords: '', allowCustomSafety: false,
};

type LimitField = {
  key: 'maxChannels' | 'maxUsers' | 'maxTemplates' | 'maxContactsPerCampaign' | 'maxMediaMb';
  label: string;
  unit: string;
};
const LIMIT_FIELDS: LimitField[] = [
  { key: 'maxChannels', label: 'WhatsApp numbers', unit: 'numbers' },
  { key: 'maxUsers', label: 'Team members', unit: 'seats' },
  { key: 'maxTemplates', label: 'Saved templates', unit: 'templates' },
  { key: 'maxContactsPerCampaign', label: 'Contacts per campaign', unit: 'contacts' },
  { key: 'maxMediaMb', label: 'Largest upload', unit: 'MB' },
];

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

@Component({
  selector: 'app-admin-tenants',
  imports: [FormsModule, RouterLink],
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
  protected readonly recentLogs = computed(() => this.logs().slice(0, 6));

  protected ago(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
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
  protected readonly settings = signal<SettingsDrawer | null>(null);
  protected readonly seedConfirmId = signal<number | null>(null);
  protected readonly seedingId = signal<number | null>(null);
  protected readonly seedResult = signal<{ id: number; ok: boolean; text: string } | null>(null);
  protected readonly safetyGroups = SAFETY_GROUPS;
  protected readonly limitFields = LIMIT_FIELDS;
  protected readonly settingsTab = signal<SettingsTab>('general');
  protected readonly settingsTabs: { id: SettingsTab; label: string; icon: string }[] = [
    { id: 'general', label: 'General', icon: 'tune' },
    { id: 'limits', label: 'Limits and quotas', icon: 'data_usage' },
    { id: 'safety', label: 'Anti-ban safety', icon: 'shield' },
  ];
  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    const status = this.statusFilter();
    return this.tenants().filter((tenant) =>
      (status === 'all' || tenant.status === status)
      && (!q || `${tenant.name} ${tenant.slug}`.toLowerCase().includes(q)));
  });
  protected readonly controlKeys: (keyof TenantControls)[] = [
    'sendingEnabled',
    'inboundEnabled',
    'campaignsEnabled',
    'automationsEnabled',
  ];

  constructor() {
    this.refresh();
    // /admin/tenants?settings=<id>[&tab=limits|safety] (linked from the ops pages) opens that drawer.
    const query = inject(ActivatedRoute).snapshot.queryParamMap;
    const wanted = Number(query.get('settings'));
    const tab = query.get('tab');
    if (wanted) {
      this.api.tenants().subscribe(({ tenants }) => {
        const tenant = tenants.find((t) => t.id === wanted);
        if (!tenant) return;
        this.openSettings(tenant);
        if (tab === 'limits' || tab === 'safety') this.settingsTab.set(tab);
      });
    }
  }

  protected refresh() {
    this.api.tenants().subscribe({
      next: ({ tenants, services }) => {
        this.services.set(services.length ? services : [...DEFAULT_SERVICES]);
        this.tenants.set(tenants);
      },
      error: (err: Error) => this.error.set(err.message),
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

  protected openSettings(tenant: Tenant) {
    this.revokeConfirm.set(false);
    if (this.settings()?.tenant.id !== tenant.id) this.settingsTab.set('general');
    this.settings.set({
      tenant,
      controls: { ...DEFAULT_CONTROLS, ...(tenant.controls ?? {}) },
      safety: null,
      custom: null,
      limits: { ...DEFAULT_LIMITS, ...(tenant.limits ?? {}) },
    });
    this.api.safety(tenant.id).subscribe({
      next: ({ safety, custom }) =>
        this.settings.update((cur) => (cur?.tenant.id === tenant.id ? { ...cur, safety, custom } : cur)),
      error: (err: Error) => this.error.set(err.message),
    });
  }

  protected readonly revokeConfirm = signal(false);

  /** Drop the tenant's own limits and take the permission back. Two clicks, no window.confirm. */
  protected revokeCustomSafety() {
    const cur = this.settings();
    if (!cur) return;
    if (!this.revokeConfirm()) {
      this.revokeConfirm.set(true);
      return;
    }
    this.revokeConfirm.set(false);
    this.savingId.set(cur.tenant.id);
    this.api.revokeCustomSafety(cur.tenant.id).subscribe({
      next: ({ custom }) => {
        this.savingId.set(null);
        this.settings.update((s) => (s?.tenant.id === cur.tenant.id
          ? { ...s, custom, limits: { ...s.limits, allowCustomSafety: false } } : s));
        this.refresh();
      },
      error: (err: Error) => {
        this.savingId.set(null);
        this.error.set(err.message);
      },
    });
  }

  protected overrideCount(custom: CustomSafetyState): number {
    return Object.keys(custom.overrides ?? {}).length;
  }

  protected closeSettings() {
    if (this.savingId() === null) this.settings.set(null);
  }

  protected setSettingsControl(key: keyof TenantControls, checked: boolean) {
    this.settings.update((cur) => (cur ? { ...cur, controls: { ...cur.controls, [key]: checked } } : cur));
  }

  protected setSafetyValue<K extends keyof SafetyPolicy>(key: K, value: SafetyPolicy[K]) {
    this.settings.update((cur) => (cur?.safety ? { ...cur, safety: { ...cur.safety, [key]: value } } : cur));
  }

  protected setLimit<K extends keyof TenantLimits>(key: K, value: TenantLimits[K]) {
    this.settings.update((cur) => (cur ? { ...cur, limits: { ...cur.limits, [key]: value } } : cur));
  }

  protected setLimitNumber(key: LimitField['key'], raw: string) {
    this.setLimit(key, Math.max(0, Math.floor(Number(raw) || 0)));
  }

  protected setSafetyNumber(key: keyof SafetyPolicy, raw: string) {
    this.setSafetyValue(key, Number(raw) as never);
  }

  protected resetSettings() {
    const cur = this.settings();
    if (cur) this.openSettings(cur.tenant);
  }

  protected saveSettings() {
    const cur = this.settings();
    if (!cur) return;
    this.savingId.set(cur.tenant.id);
    this.error.set('');
    forkJoin([
      this.api.updateTenant(cur.tenant.id, { controls: cur.controls }),
      this.api.setLimits(cur.tenant.id, cur.limits),
      ...(cur.safety ? [this.api.setSafety(cur.tenant.id, cur.safety)] : []),
    ]).subscribe({
      next: () => {
        this.savingId.set(null);
        this.settings.set(null);
        this.refresh();
      },
      error: (err: Error) => {
        this.savingId.set(null);
        this.error.set(err.message);
      },
    });
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
        const parts = Object.entries(created).map(([key, n]) => `${n} ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}`);
        this.seedingId.set(null);
        this.seedConfirmId.set(null);
        this.seedResult.set({
          id: tenant.id,
          ok: true,
          text: parts.length ? `Added ${parts.join(', ')}.` : 'Demo data is already in place - nothing new to add.',
        });
        this.refresh();
      },
      error: (err: Error) => {
        this.seedingId.set(null);
        this.seedResult.set({ id: tenant.id, ok: false, text: err.message });
      },
    });
  }

  protected deleteTenant(tenant: Tenant) {
    if (!window.confirm(`Delete ${tenant.name}? This archives the tenant and removes it from this list.`)) return;
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
    return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
