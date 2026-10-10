import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';

import { SERVICE_META } from './admin/service-meta';
import { TenancyApi } from './core/api';
import { Auth, Role, Tenant } from './core/auth';
import { SendIsland } from './core/send-island';
import { Store, ThemeMode } from './core/store';

type NavItem = {
  path: string;
  label: string;
  icon: string;
  min?: Role;
  service?: string;
  heading?: undefined;
};
type NavEntry =
  | NavItem
  | { heading: string; children: NavItem[]; path?: undefined; label?: undefined; icon?: undefined };

/** One labelled block of the sidebar, as the template renders it. */
interface NavSection {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

/** Tabler glyphs, rendered as `ti ti-<icon>`. */
const ICONS = {
  connection: 'wifi',
  campaign: 'messages',
  replies: 'message-bolt',
  payment: 'cash',
  history: 'history',
  team: 'users',
  tenants: 'building',
  plans: 'crown',
  usage: 'chart-histogram',
  health: 'heart-rate-monitor',
  audit: 'list-search',
  channels: 'device-mobile',
  contacts: 'address-book',
  school: 'school',
};

const SERVICE_GROUPS = [
  {
    heading: 'Messaging',
    services: [
      'school_whatsapp_bot',
      'whatsapp_channels',
      'templates',
      'auto_replies',
      'bulk_messages',
      'campaigns',
    ],
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

/** Theme choices for the account foot, in the order the segmented control shows them. */
const THEMES: readonly { value: ThemeMode; label: string; icon: string }[] = [
  { value: 'auto', label: 'Auto', icon: 'device-desktop' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
];

const COLLAPSE_KEY = 'wsender.sidebar-collapsed';

/** Web Storage throws outright in some privacy modes, so the read is guarded. */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * The signed-in shell: two detached panels on the page ground, after the
 * Kardlyz dashboard layout. The sidebar carries the brand, the workspace and
 * its connection status, the navigation and — pinned at its foot — the
 * account with theme, sign-out and leave-tenant. The content panel holds the
 * routed page and is the only thing that scrolls.
 *
 * On wide screens the sidebar can fold to an icon rail (remembered, since a
 * rail someone chose is a preference). Below `lg` it becomes a drawer, so the
 * content panel grows a slim top bar to open it.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, SendIsland],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'closeNav()',
  },
})
export class App {
  protected readonly store = inject(Store);
  protected readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly tenancy = inject(TenancyApi);
  private readonly destroyRef = inject(DestroyRef);

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

    // A drawer left open over the page it just opened would hide that page.
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.closeNav());
  }

  /** The sign-in screen is full-bleed: no sidebar, no content panel. */
  protected readonly bare = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects.startsWith('/login')),
    ),
    { initialValue: location.pathname.startsWith('/login') },
  );

  protected readonly themes = THEMES;

  /** Folded to an icon rail; only honoured at `lg` and up, where the sidebar is in the flow. */
  protected readonly collapsed = signal(readCollapsed());

  /** The sidebar as a drawer, below `lg`. */
  protected readonly navOpen = signal(false);

  private readonly allNav: NavItem[] = [
    { path: '/admin/tenants', label: 'Tenants', icon: ICONS.tenants, min: 'super_admin' },
    { path: '/admin/plans', label: 'Plans', icon: ICONS.plans, min: 'super_admin' },
    { path: '/admin/usage', label: 'Usage', icon: ICONS.usage, min: 'super_admin' },
    { path: '/admin/health', label: 'Health', icon: ICONS.health, min: 'super_admin' },
    { path: '/admin/audit-logs', label: 'Audit logs', icon: ICONS.audit, min: 'super_admin' },
    { path: '/admin/channels', label: 'Channels', icon: ICONS.channels, min: 'super_admin' },
    {
      path: '/connection',
      label: 'Connection',
      icon: ICONS.connection,
      service: 'whatsapp_channels',
    },
    {
      path: '/channels',
      label: 'WhatsApp Numbers',
      icon: ICONS.channels,
      service: 'whatsapp_channels',
    },
    {
      path: '/school',
      label: 'School Assistant',
      icon: ICONS.school,
      service: 'school_whatsapp_bot',
    },
    { path: '/contacts', label: 'Contacts', icon: ICONS.contacts, service: 'contacts' },
    { path: '/campaign', label: 'New Campaign', icon: ICONS.campaign, service: 'bulk_messages' },
    { path: '/campaigns', label: 'Campaigns', icon: 'speakerphone', service: 'bulk_messages' },
    { path: '/auto-replies', label: 'Auto-Replies', icon: ICONS.replies, service: 'auto_replies' },
    { path: '/templates', label: 'Templates', icon: 'file-text', service: 'templates' },
    { path: '/inbox', label: 'Inbox', icon: 'inbox', service: 'inbox' },
    { path: '/tickets', label: 'Tickets', icon: 'ticket', service: 'tickets' },
    { path: '/knowledge', label: 'FAQ', icon: 'help-circle', service: 'faq' },
    {
      path: '/payment-reminder',
      label: 'Payment Reminder',
      icon: ICONS.payment,
      service: 'payment_reminders',
    },
    {
      path: '/records/appointment',
      label: 'Appointments',
      icon: 'calendar-event',
      service: 'appointments',
    },
    { path: '/records/order', label: 'Orders', icon: 'shopping-cart', service: 'orders' },
    { path: '/records/lead', label: 'Leads', icon: 'user-search', service: 'leads' },
    {
      path: '/records/subscription',
      label: 'Subscriptions',
      icon: 'refresh',
      service: 'subscriptions',
    },
    { path: '/records/event', label: 'Events', icon: 'confetti', service: 'events' },
    { path: '/workflows', label: 'Workflows', icon: 'hierarchy-3', service: 'workflows' },
    { path: '/analytics', label: 'Analytics', icon: 'chart-bar', service: 'analytics' },
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

  /**
   * `navigation` regrouped into labelled sections, so the template renders one
   * shape. Loose items (a tenant's flat list) gather under "Workspace", the
   * way Kardlyz heads its own first block "Main".
   */
  protected readonly sections = computed<NavSection[]>(() => {
    const out: NavSection[] = [];
    let loose: NavItem[] | null = null;
    for (const entry of this.navigation()) {
      if (entry.heading !== undefined) {
        loose = null;
        if (entry.children.length) out.push({ heading: entry.heading, items: entry.children });
      } else {
        if (!loose) out.push({ heading: 'Workspace', items: (loose = []) });
        loose.push(entry);
      }
    }
    return out;
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
    if (this.auth.isSuperAdmin() && this.auth.actingTenantId() === null)
      return 'Pick a tenant to work in';
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

  /** Two letters for the avatar glyph, from the name or, failing that, the email. */
  protected readonly initials = computed(() => {
    const user = this.auth.user();
    const source = (user?.name || user?.email || '?').trim();
    const words = source.split(/[\s@._-]+/).filter(Boolean);
    const letters = words.length > 1 ? words[0][0] + words[1][0] : source.slice(0, 2);
    return letters.toUpperCase();
  });

  /** The role as people say it: `super_admin` reads "Super admin". */
  protected readonly roleLabel = computed(() => {
    const role = this.auth.user()?.role ?? '';
    const words = role.replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  });

  /** Closes the drawer: Escape, the scrim, or a navigation. */
  protected closeNav(): void {
    this.navOpen.set(false);
  }

  protected toggleCollapsed(): void {
    this.collapsed.update((value) => !value);
    try {
      localStorage.setItem(COLLAPSE_KEY, String(this.collapsed()));
    } catch {
      // Private windows and blocked site data: the rail still folds, it simply
      // will not be remembered.
    }
  }

  /** The icon rail has room for one theme button, so it steps auto → light → dark. */
  protected cycleTheme(): void {
    const index = THEMES.findIndex((theme) => theme.value === this.store.theme());
    this.store.setTheme(THEMES[(index + 1) % THEMES.length].value);
  }

  /** Glyph for the rail's single theme button, matching the mode it is in. */
  protected readonly themeIcon = computed(
    () => THEMES.find((theme) => theme.value === this.store.theme())?.icon ?? 'sun-moon',
  );

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
