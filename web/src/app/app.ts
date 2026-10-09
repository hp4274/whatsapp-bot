import { Component, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';

import { TenancyApi } from './core/api';
import { Auth, Role, Tenant } from './core/auth';
import { SendIsland } from './core/send-island';
import { Store, ThemeMode } from './core/store';
import { SERVICE_META } from './admin/service-meta';

type NavItem = { path: string; label: string; icon: string; min?: Role; service?: string; heading?: undefined };
type NavEntry = NavItem | { heading: string; children: NavItem[]; path?: undefined; label?: undefined; icon?: undefined };

/** Google Material Symbols ligature names (font loaded in index.html). */
const ICONS = {
  connection: 'wifi',
  campaign: 'forum',
  replies: 'quickreply',
  payment: 'payments',
  history: 'history',
  team: 'group',
  tenants: 'domain',
  plans: 'workspace_premium',
  usage: 'monitoring',
  health: 'health_and_safety',
  audit: 'manage_search',
  channels: 'smartphone',
  contacts: 'contacts',
  school: 'school',
};

const SERVICE_GROUPS = [
  {
    heading: 'Messaging',
    services: ['school_whatsapp_bot', 'whatsapp_channels', 'templates', 'auto_replies', 'bulk_messages', 'campaigns'],
  },
  {
    heading: 'Customers',
    services: ['contacts', 'inbox', 'payment_reminders', 'faq', 'tickets', 'appointments'],
  },
  {
    heading: 'Commerce',
    services: ['orders', 'leads', 'subscriptions', 'events'],
  },
  {
    heading: 'Platform',
    services: ['workflows', 'api', 'analytics', 'integrations', 'ai'],
  },
];

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, SendIsland],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly store = inject(Store);
  protected readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly tenancy = inject(TenancyApi);

  /** The tenant a super admin has opened, so the rail can show what that tenant sees. */
  private readonly acting = signal<Tenant | null>(null);

  constructor() {
    effect(() => {
      const id = this.auth.actingTenantId();
      if (!this.auth.isSuperAdmin() || id === null) {
        this.acting.set(null);
        return;
      }
      this.tenancy.tenants().subscribe({
        next: ({ tenants }) => this.acting.set(tenants.find((t) => t.id === id) ?? null),
        error: () => this.acting.set(null),
      });
    });
  }

  /** The sign-in screen is full-bleed: no header, no rail. */
  protected readonly bare = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects.startsWith('/login')),
    ),
    { initialValue: location.pathname.startsWith('/login') },
  );

  protected readonly themes: { value: ThemeMode; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  private readonly allNav: NavItem[] = [
    { path: '/admin/tenants', label: 'Tenants', icon: ICONS.tenants, min: 'super_admin' },
    { path: '/admin/plans', label: 'Plans', icon: ICONS.plans, min: 'super_admin' },
    { path: '/admin/usage', label: 'Usage', icon: ICONS.usage, min: 'super_admin' },
    { path: '/admin/health', label: 'Health', icon: ICONS.health, min: 'super_admin' },
    { path: '/admin/audit-logs', label: 'Audit logs', icon: ICONS.audit, min: 'super_admin' },
    { path: '/admin/channels', label: 'Channels', icon: ICONS.channels, min: 'super_admin' },
    { path: '/connection', label: 'Connection', icon: ICONS.connection, service: 'whatsapp_channels' },
    { path: '/channels', label: 'WhatsApp Numbers', icon: ICONS.channels, service: 'whatsapp_channels' },
    { path: '/school', label: 'School Assistant', icon: ICONS.school, service: 'school_whatsapp_bot' },
    { path: '/contacts', label: 'Contacts', icon: ICONS.contacts, service: 'contacts' },
    { path: '/campaign', label: 'Messaging & Campaign', icon: ICONS.campaign, service: 'bulk_messages' },
    { path: '/auto-replies', label: 'Auto-Replies', icon: ICONS.replies, service: 'auto_replies' },
    { path: '/templates', label: 'Templates', icon: 'description', service: 'templates' },
    { path: '/inbox', label: 'Inbox', icon: 'inbox', service: 'inbox' },
    { path: '/tickets', label: 'Tickets', icon: 'confirmation_number', service: 'tickets' },
    { path: '/knowledge', label: 'FAQ', icon: 'help', service: 'faq' },
    { path: '/payment-reminder', label: 'Payment Reminder', icon: ICONS.payment, service: 'payment_reminders' },
    { path: '/records/appointment', label: 'Appointments', icon: 'event', service: 'appointments' },
    { path: '/records/order', label: 'Orders', icon: 'shopping_cart', service: 'orders' },
    { path: '/records/lead', label: 'Leads', icon: 'person_search', service: 'leads' },
    { path: '/records/subscription', label: 'Subscriptions', icon: 'autorenew', service: 'subscriptions' },
    { path: '/records/event', label: 'Events', icon: 'celebration', service: 'events' },
    { path: '/workflows', label: 'Workflows', icon: 'account_tree', service: 'workflows' },
    { path: '/analytics', label: 'Analytics', icon: 'analytics', service: 'analytics' },
    { path: '/developer', label: 'API & Webhooks', icon: 'api', service: 'api' },
    { path: '/history', label: 'History', icon: ICONS.history },
    { path: '/team', label: 'Team', icon: ICONS.team, min: 'admin' },
  ];

  /**
   * Tenant users see the services they have.  A super admin on the platform view
   * sees each service as its own settings page; once inside a tenant they get
   * that tenant's sections like anyone else.
   */
  protected readonly navigation = computed<NavEntry[]>(() => {
    if (!this.auth.user()) return [];
    const superAdmin = this.auth.isSuperAdmin();
    if (superAdmin && this.auth.actingTenantId() === null) {
      return [
        { heading: 'Platform', children: this.allNav.slice(0, 6) },
        ...SERVICE_GROUPS.map((group) => ({
          heading: group.heading,
          children: group.services
            .filter((key) => SERVICE_META[key])
            .map((key) => {
              const meta = SERVICE_META[key];
              return { path: `/admin/services/${key}`, label: meta.label, icon: meta.icon };
            }),
        })),
      ];
    }
    // Inside a tenant a super admin sees the tenant's own rail: its services, owner-level.
    const inTenant = superAdmin;
    const owned = inTenant ? this.acting()?.services : this.auth.tenant()?.services;
    return this.allNav.filter((item) => {
      if (item.min === 'super_admin') return false;
      if (item.service && owned && !owned.includes(item.service)) return false;
      return inTenant || !item.min || this.auth.atLeast(item.min);
    });
  });

  /** What the header calls the current workspace. */
  protected readonly workspace = computed(() => {
    const user = this.auth.user();
    if (!user) return 'WhatsApp Sender';
    if (user.role !== 'super_admin') return this.auth.tenant()?.name ?? 'WhatsApp Sender';
    const acting = this.auth.actingTenantId();
    return acting === null ? 'Platform admin' : (this.acting()?.name ?? `Tenant ${acting}`);
  });

  protected readonly subtitle = computed(() => {
    const connection = this.store.connection();
    if (!this.auth.user()) return 'Signed out';
    if (this.auth.isSuperAdmin() && this.auth.actingTenantId() === null) return 'Pick a tenant to work in';
    if (!this.store.streamOnline()) return 'Backend not reachable';
    return connection.connected ? `Connected - ${connection.name}` : 'Not connected';
  });

  protected readonly toneColor = computed(() => {
    const tone = this.store.statusTone();
    return {
      muted: 'var(--text-muted)',
      primary: 'var(--primary)',
      warning: 'var(--warning)',
      danger: 'var(--danger)',
    }[tone];
  });

  protected signOut() {
    this.auth.logout();
    this.store.stop();
    this.router.navigate(['/login']);
  }

  /** Back to the platform view: drop the tenant and close its stream. */
  protected leaveTenant() {
    this.auth.actAs(null);
    this.store.stop();
    this.router.navigate(['/admin/tenants']);
  }

}
