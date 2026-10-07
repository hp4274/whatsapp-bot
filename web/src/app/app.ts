import { Component, computed, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';

import { Auth, Role } from './core/auth';
import { Store, ThemeMode } from './core/store';

/** Inline SVG, so the icons need no font, no sprite and no network. */
function icon(path: string): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

const ICONS = {
  connection: icon('<path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>'),
  campaign: icon('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l2-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z"/>'),
  replies: icon('<path d="M4 5h16v10H7l-3 3Z"/><path d="M8 9h8"/><path d="M8 12h5"/>'),
  payment: icon('<path d="M4 7h16v10H4z"/><path d="M4 10h16"/><path d="M7 14h4"/><path d="M16 14h1"/>'),
  history: icon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>'),
  team: icon('<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.5a3 3 0 0 1 0 5"/><path d="M18 20a5.5 5.5 0 0 0-3-4.9"/>'),
  tenants: icon('<path d="M4 20V8l6-4 6 4v12"/><path d="M10 20v-5h4v5"/><path d="M20 20V11l-4-2.7"/>'),
  channels: icon('<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10 5.5h4"/><path d="M11 18.5h2"/>'),
  contacts: icon('<circle cx="12" cy="8" r="3.2"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
};

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly store = inject(Store);
  protected readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);

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

  private readonly allNav: { path: string; label: string; icon: SafeHtml; min?: Role }[] = [
    { path: '/admin/tenants', label: 'Tenants', icon: this.trust(ICONS.tenants), min: 'super_admin' },
    { path: '/connection', label: 'Connection', icon: this.trust(ICONS.connection) },
    { path: '/channels', label: 'WhatsApp Numbers', icon: this.trust(ICONS.channels) },
    { path: '/contacts', label: 'Contacts', icon: this.trust(ICONS.contacts) },
    { path: '/campaign', label: 'Messaging & Campaign', icon: this.trust(ICONS.campaign) },
    { path: '/auto-replies', label: 'Auto-Replies', icon: this.trust(ICONS.replies) },
    { path: '/payment-reminder', label: 'Payment Reminder', icon: this.trust(ICONS.payment) },
    { path: '/history', label: 'History', icon: this.trust(ICONS.history) },
    { path: '/team', label: 'Team', icon: this.trust(ICONS.team), min: 'admin' },
  ];

  protected readonly navigation = computed(() =>
    this.auth.user() ? this.allNav.filter((item) => !item.min || this.auth.atLeast(item.min)) : [],
  );

  /** What the header calls the current workspace. */
  protected readonly workspace = computed(() => {
    const user = this.auth.user();
    if (!user) return 'WhatsApp Sender';
    if (user.role !== 'super_admin') return this.auth.tenant()?.name ?? 'WhatsApp Sender';
    const acting = this.auth.actingTenantId();
    return acting === null ? 'Platform admin' : `Tenant #${acting}`;
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

  private trust(markup: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(markup);
  }
}
