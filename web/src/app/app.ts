import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { type Subscription, filter, map } from 'rxjs';

import { type ChannelDetail, OpsApi } from './admin/ops-api';
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
};

/** One block of the sidebar, as the template renders it; an empty heading renders no label. */
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

/** A channel's contribution to the platform average; disabled (`off`) channels do not count. */
const HEALTH_SCORE: Readonly<Record<string, number>> = { ok: 100, warn: 50, bad: 0 };

const HEALTH_REFRESH_MS = 60_000;

/** Reads still work past the grace days (server app.js 402 gate is writes-only), so the banner says what stopped. */
const SUBSCRIPTION_ENDED_TEXT =
  'Your subscription has ended. You can still see your data, but nothing is sent and changes are off. Contact your provider to renew.';

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
  private readonly ops = inject(OpsApi);
  private readonly destroyRef = inject(DestroyRef);

  /** The tenant a super admin has opened, so the rail can show what that tenant sees. */
  private readonly acting = signal<Tenant | null>(null);

  /** A super admin looking at the whole platform rather than inside one tenant. */
  private readonly platformView = computed(
    () => this.auth.isSuperAdmin() && this.auth.actingTenantId() === null,
  );

  /** Every channel on the platform; null until the first load lands, 'error' if it failed. */
  private readonly fleet = signal<readonly ChannelDetail[] | 'error' | null>(null);

  /**
   * The subscription-ended banner. `/api/auth/me` says so on load; a 402 says so
   * when the grace ran out while the page was open (`Auth.blocked`).
   */
  protected readonly subscriptionEnded = computed(
    () =>
      this.auth.blocked() ??
      (this.auth.tenant()?.subscription?.state === 'expired' ? SUBSCRIPTION_ENDED_TEXT : null),
  );

  constructor() {
    // A 402 means /me is stale: re-read it, so a renewal (which re-reads it too) can lift the banner.
    effect(() => {
      if (this.auth.blocked()) untracked(() => this.auth.refresh());
    });
    // Renewed: /me no longer says expired, so the 402's banner goes. Tracks the tenant only,
    // or the 402 above would clear itself before /me caught up.
    effect(() => {
      const state = this.auth.tenant()?.subscription?.state;
      if (state && state !== 'expired') untracked(() => this.auth.blocked.set(null));
    });

    // Only the platform view needs the fleet, so nobody else pays for the poll. The
    // computed above flips only on a real view change, which keeps the timer from
    // restarting whenever the user object is refreshed.
    effect((onCleanup) => {
      if (!this.platformView()) {
        this.fleet.set(null);
        return;
      }
      let inflight: Subscription | undefined;
      const load = () => {
        inflight?.unsubscribe();
        inflight = this.ops
          .health()
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe({
            next: ({ channels }) => this.fleet.set(channels),
            error: () => this.fleet.set('error'),
          });
      };
      load();
      const timer = setInterval(load, HEALTH_REFRESH_MS);
      onCleanup(() => {
        clearInterval(timer);
        inflight?.unsubscribe();
      });
    });

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

  /**
   * A tenant's sidebar, grouped by what someone came to do: send, look after
   * customers, see results, or set things up. Home stands alone above them.
   * Items the tenant lacks the service or role for drop out, and a section
   * left with nothing drops with them.
   */
  private readonly tenantNav: readonly NavSection[] = [
    { heading: '', items: [{ path: '/home', label: 'Home', icon: 'smart-home' }] },
    {
      heading: 'Messaging',
      items: [
        { path: '/campaign', label: 'New Campaign', icon: ICONS.campaign, service: 'campaigns' },
        { path: '/campaigns', label: 'Campaigns', icon: 'speakerphone', service: 'campaigns' },
        { path: '/templates', label: 'Templates', icon: 'file-text', service: 'templates' },
        { path: '/auto-replies', label: 'Auto-Replies', icon: ICONS.replies, service: 'auto_replies' },
        { path: '/inbox', label: 'Inbox', icon: 'inbox', service: 'inbox' },
        { path: '/storage', label: 'Storage', icon: 'folders', service: 'bulk_messages' },
        { path: '/school', label: 'School Assistant', icon: ICONS.school, service: 'school_whatsapp_bot' },
      ],
    },
    {
      heading: 'Customers',
      items: [
        { path: '/contacts', label: 'Contacts', icon: ICONS.contacts, service: 'contacts' },
        { path: '/tickets', label: 'Tickets', icon: 'ticket', service: 'tickets' },
        { path: '/knowledge', label: 'FAQ', icon: 'help-circle', service: 'faq' },
        { path: '/payment-reminder', label: 'Payment Reminder', icon: ICONS.payment, service: 'payment_reminders' },
        { path: '/records/appointment', label: 'Appointments', icon: 'calendar-event', service: 'appointments' },
        { path: '/records/order', label: 'Orders', icon: 'shopping-cart', service: 'orders' },
        { path: '/records/lead', label: 'Leads', icon: 'user-search', service: 'leads' },
        { path: '/records/subscription', label: 'Subscriptions', icon: 'refresh', service: 'subscriptions' },
        { path: '/records/event', label: 'Events', icon: 'confetti', service: 'events' },
      ],
    },
    {
      heading: 'Insights',
      items: [
        { path: '/analytics', label: 'Analytics', icon: 'chart-bar', service: 'analytics' },
        { path: '/history', label: 'History', icon: ICONS.history },
      ],
    },
    {
      heading: 'Settings',
      items: [
        { path: '/connection', label: 'Connection', icon: ICONS.connection, service: 'whatsapp_channels', min: 'admin' },
        { path: '/channels', label: 'WhatsApp Numbers', icon: ICONS.channels, service: 'whatsapp_channels', min: 'admin' },
        { path: '/team', label: 'Team', icon: ICONS.team, min: 'admin' },
        { path: '/workflows', label: 'Workflows', icon: 'hierarchy-3', service: 'workflows' },
        { path: '/developer', label: 'API & Webhooks', icon: 'api', service: 'api' },
      ],
    },
  ];

  /** The super admin's own pages, above the per-service settings on the platform view. */
  private readonly platformNav: readonly NavItem[] = [
    { path: '/admin/tenants', label: 'Tenants', icon: ICONS.tenants },
    { path: '/admin/plans', label: 'Plans & billing', icon: ICONS.plans },
    { path: '/admin/usage', label: 'Usage', icon: ICONS.usage },
    { path: '/admin/health', label: 'Health', icon: ICONS.health },
    { path: '/admin/number-collections', label: 'Number collections', icon: 'address-book' },
    { path: '/admin/audit-logs', label: 'Audit logs', icon: ICONS.audit },
    { path: '/admin/channels', label: 'Channels', icon: ICONS.channels },
  ];

  /**
   * Tenant users see the services they have.  A super admin on the platform view
   * sees each service as its own settings page; once inside a tenant they get
   * that tenant's sections like anyone else, owner-level.
   */
  protected readonly sections = computed<NavSection[]>(() => {
    if (!this.auth.user()) return [];
    const superAdmin = this.auth.isSuperAdmin();
    if (this.platformView()) {
      return [
        { heading: 'Platform', items: this.platformNav },
        ...SERVICE_GROUPS.map((group) => ({
          heading: group.heading,
          items: group.services
            .filter((key) => SERVICE_META[key])
            .map((key) => {
              const meta = SERVICE_META[key];
              return { path: `/admin/services/${key}`, label: meta.label, icon: meta.icon };
            }),
        })),
      ].filter((section) => section.items.length);
    }
    const owned = superAdmin ? this.acting()?.services : this.auth.tenant()?.services;
    const visible = (item: NavItem) =>
      !(item.service && owned && !owned.includes(item.service)) &&
      (superAdmin || !item.min || this.auth.atLeast(item.min));
    return this.tenantNav
      .map((section) => ({ heading: section.heading, items: section.items.filter(visible) }))
      .filter((section) => section.items.length);
  });

  /** What the header calls the current workspace. */
  protected readonly workspace = computed(() => {
    const user = this.auth.user();
    if (!user) return 'Wapzo';
    if (user.role !== 'super_admin') return this.auth.tenant()?.name ?? 'Wapzo';
    const acting = this.auth.actingTenantId();
    return acting === null ? 'Platform admin' : (this.acting()?.name ?? `Tenant ${acting}`);
  });

  /** Average score and online count over the enabled channels; null/'error' mirror `fleet`. */
  private readonly fleetHealth = computed(() => {
    const rows = this.fleet();
    if (rows === null || rows === 'error') return rows;
    const live = rows.filter((c) => c.severity !== 'off');
    const total = live.reduce((sum, c) => sum + (HEALTH_SCORE[c.severity] ?? 0), 0);
    return {
      count: live.length,
      online: live.filter((c) => c.state === 'connected').length,
      score: live.length ? Math.round(total / live.length) : 0,
    };
  });

  /** Dot colour in the platform view: the store's tone describes one tenant's number, not the fleet. */
  private readonly platformTone = computed<'muted' | 'primary' | 'warning' | 'danger'>(() => {
    const health = this.fleetHealth();
    if (!health || health === 'error' || !health.count) return 'muted';
    return health.score >= 90 ? 'primary' : health.score >= 60 ? 'warning' : 'danger';
  });

  protected readonly subtitle = computed(() => {
    const connection = this.store.connection();
    if (!this.auth.user()) return 'Signed out';
    if (this.platformView()) {
      const health = this.fleetHealth();
      if (health === null) return 'Checking connections...';
      if (health === 'error') return 'Connection health unavailable';
      if (!health.count) return 'No connections yet';
      return `Avg connection health ${health.score}% · ${health.online} of ${health.count} online`;
    }
    if (!this.store.streamOnline()) return 'Backend not reachable';
    return connection.connected ? `Connected - ${connection.name}` : 'Not connected';
  });

  protected readonly toneColor = computed(() => {
    const tone = this.platformView() ? this.platformTone() : this.store.statusTone();
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
  protected cycleTheme(event: Event): void {
    const index = THEMES.findIndex((theme) => theme.value === this.store.theme());
    this.store.setTheme(THEMES[(index + 1) % THEMES.length].value, event);
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
