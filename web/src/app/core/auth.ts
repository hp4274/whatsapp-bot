/**
 * Who is signed in, and which tenant they act on.
 *
 * The token is the only thing that persists: everything else is re-fetched
 * from `/api/auth/me` on boot, so a revoked session cannot linger in the UI.
 * A super admin has no tenant of their own and picks one to work in; that
 * choice rides on every request as `X-Tenant-Id` (see `authInterceptor`).
 */

import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Observable, catchError, map, of, tap, throwError } from 'rxjs';

export type Role = 'agent' | 'admin' | 'owner' | 'super_admin';
export const ROLE_RANK: Role[] = ['agent', 'admin', 'owner', 'super_admin'];

export interface User {
  id: number;
  tenantId: number | null;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
}

export interface Tenant {
  id: number;
  name: string;
  slug: string;
  status: 'active' | 'suspended' | 'archived';
  services: string[];
  controls: TenantControls;
  /** Anti-ban overrides set by the platform admin; absent keys use the defaults. */
  safety?: Record<string, number | boolean | string>;
  channels?: TenantChannelSummary[];
  health?: TenantHealth;
  createdAt: string;
  users?: number;
}

export interface TenantControls {
  sendingEnabled: boolean;
  inboundEnabled: boolean;
  campaignsEnabled: boolean;
  automationsEnabled: boolean;
}

export interface TenantChannelSummary {
  id: number;
  displayName: string;
  provider: string;
  phoneNumber: string;
  status: 'active' | 'disabled';
  capabilities: string[];
  isDefault: boolean;
  health: {
    connected: boolean;
    connecting: boolean;
    running: boolean;
    account: string;
    detail: string;
    error: string | null;
    withinSendingWindow: boolean;
  };
}

export interface TenantHealth {
  channels: number;
  connected: number;
  running: number;
  disabled: number;
  outsideWindow: number;
  sent: number;
  failed: number;
  queued: number;
}

const TOKEN_KEY = 'wsender.token';
const TENANT_KEY = 'wsender.tenant';
const CHANNEL_KEY = 'wsender.channel';

@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly http = inject(HttpClient);

  readonly token = signal<string | null>(localStorage.getItem(TOKEN_KEY));
  readonly user = signal<User | null>(null);
  readonly tenant = signal<Tenant | null>(null);
  /** Super admins only: the tenant they are currently acting as. */
  readonly actingTenantId = signal<number | null>(readNumber(TENANT_KEY));
  /** Which WhatsApp number requests act on; null means the tenant default. */
  readonly channelId = signal<number | null>(readNumber(CHANNEL_KEY));
  /** False until the first `/api/auth/me` settles, so guards do not bounce on reload. */
  readonly ready = signal(false);

  readonly isSuperAdmin = computed(() => this.user()?.role === 'super_admin');
  readonly tenantId = computed(() => (this.isSuperAdmin() ? this.actingTenantId() : this.user()?.tenantId ?? null));

  /** True when the signed-in user is at least `role` on the role ladder. */
  atLeast(role: Role): boolean {
    const current = this.user()?.role;
    return current ? ROLE_RANK.indexOf(current) >= ROLE_RANK.indexOf(role) : false;
  }

  login(email: string, password: string): Observable<{ token: string; user: User; tenant: Tenant | null }> {
    return this.http
      .post<{ token: string; user: User; tenant: Tenant | null }>('/api/auth/login', { email, password })
      .pipe(
        tap((res) => {
          localStorage.setItem(TOKEN_KEY, res.token);
          this.token.set(res.token);
          this.user.set(res.user);
          this.tenant.set(res.tenant);
          this.ready.set(true);
        }),
        catchError(toMessage),
      );
  }

  /** Restore the session behind a stored token. Never errors: a bad token just signs you out. */
  restore(): Observable<User | null> {
    if (!this.token()) {
      this.ready.set(true);
      return of(null);
    }
    return this.http.get<{ user: User; tenant: Tenant | null }>('/api/auth/me').pipe(
      catchError(() => {
        this.clear();
        return of({ user: null, tenant: null });
      }),
      map(({ user, tenant }) => {
        this.user.set(user);
        this.tenant.set(tenant);
        this.ready.set(true);
        return user;
      }),
    );
  }

  logout(): void {
    // Best effort: the local session is gone either way.
    this.http.post('/api/auth/logout', {}).subscribe({ error: () => undefined });
    this.clear();
  }

  actAs(tenantId: number | null): void {
    this.actingTenantId.set(tenantId);
    if (tenantId === null) localStorage.removeItem(TENANT_KEY);
    else localStorage.setItem(TENANT_KEY, String(tenantId));
    // Another tenant's channel ids mean nothing here.
    this.useChannel(null);
  }

  useChannel(channelId: number | null): void {
    this.channelId.set(channelId);
    if (channelId === null) localStorage.removeItem(CHANNEL_KEY);
    else localStorage.setItem(CHANNEL_KEY, String(channelId));
  }

  clear(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TENANT_KEY);
    localStorage.removeItem(CHANNEL_KEY);
    this.token.set(null);
    this.user.set(null);
    this.tenant.set(null);
    this.actingTenantId.set(null);
    this.channelId.set(null);
  }
}

/** Attaches the bearer token and the acting tenant; a 401 ends the session. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(Auth);
  const router = inject(Router);
  const token = auth.token();
  const tenantId = auth.isSuperAdmin() ? auth.actingTenantId() : null;
  // Channel CRUD is tenant-level; addressing it to one channel would be a lie.
  const channelId = req.url.startsWith('/api/channels') ? null : auth.channelId();

  const authed = token
    ? req.clone({
        setHeaders: {
          authorization: `Bearer ${token}`,
          ...(tenantId !== null ? { 'x-tenant-id': String(tenantId) } : {}),
          ...(channelId !== null ? { 'x-channel-id': String(channelId) } : {}),
        },
      })
    : req;

  return next(authed).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401 && !req.url.includes('/api/auth/login')) {
        auth.clear();
        router.navigate(['/login']);
      }
      return throwError(() => error);
    }),
  );
};

export const authGuard: CanActivateFn = () => {
  const auth = inject(Auth);
  const router = inject(Router);
  return auth.user() ? true : router.createUrlTree(['/login']);
};

/** Routes that need a minimum role. Super admins must pick a tenant first. */
export const roleGuard = (min: Role): CanActivateFn => () => {
  const auth = inject(Auth);
  const router = inject(Router);
  if (!auth.user()) return router.createUrlTree(['/login']);
  return auth.atLeast(min) ? true : router.createUrlTree(['/connection']);
};

function readNumber(key: string): number | null {
  const raw = localStorage.getItem(key);
  return raw === null || Number.isNaN(Number(raw)) ? null : Number(raw);
}

/** The API answers `{ errors: [...] }`; surface the first line, not a status code. */
function toMessage(error: HttpErrorResponse) {
  const errors = (error.error as { errors?: string[] } | null)?.errors;
  return throwError(() => new Error(errors?.[0] ?? error.message ?? 'Request failed'));
}
