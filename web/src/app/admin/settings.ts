import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChildren } from '@angular/core';
import { animate } from 'motion';

import { Auth, User } from '../core/auth';
import { AccountDialog } from '../core/account-dialog';
import { ConfirmDialog } from '../core/confirm-dialog';
import { AdminFeed } from './admin-feed';
import { ADMIN_SECTIONS, AdminAction, AdminSection, Permissions } from './admin-sections';
import { AdminRole, StaffApi, StaffPage } from './staff-api';
import { newPassword } from './tenant-summary';

/** The role drawer's working copy; id null is a new role. */
type RoleDraft = { id: number | null; name: string; permissions: Permissions; staff: number };
/** The staff drawer's working copy; id null is someone new. */
type StaffDraft = { id: number | null; name: string; email: string; password: string; roleId: number | null };

/**
 * Settings > Roles & staff, the full super admin's alone (server adminRoles.js). A role is a name and, per platform
 * page, what it may do there: view, add, change, delete. Staff sign in like the super admin but see, and may call,
 * only what their role allows. Changes reach open pages at once (AdminNotifications re-reads /me). The super admin's
 * own email and password are changed here too, from their row.
 */
@Component({
  selector: 'app-admin-settings',
  imports: [AccountDialog, ConfirmDialog],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'closeDrawers()' },
})
export class SettingsView {
  private readonly api = inject(StaffApi);
  protected readonly auth = inject(Auth);

  protected readonly sections = ADMIN_SECTIONS;
  protected readonly newPassword = newPassword;
  protected readonly page = signal<StaffPage | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  /** The sign-in of someone just added, shown this once to pass on. */
  protected readonly added = signal<{ name: string; email: string; password: string; isNew: boolean; mailed: boolean } | null>(null);
  protected readonly copied = signal(false);

  protected readonly role = signal<RoleDraft | null>(null);
  protected readonly person = signal<StaffDraft | null>(null);
  protected readonly removing = signal<User | null>(null);
  protected readonly deletingRole = signal(false);
  protected readonly drawerError = signal('');
  /** Your own email and password (the account dialog), from your row. */
  protected readonly editingSelf = signal(false);

  protected readonly roles = computed(() => this.page()?.roles ?? []);
  /** Full super admins first (they are not edited here), then staff by name. */
  protected readonly people = computed(() =>
    [...(this.page()?.staff ?? [])].sort(
      (a, b) => Number(Boolean(a.adminRoleId)) - Number(Boolean(b.adminRoleId)) || (a.name || a.email).localeCompare(b.name || b.email),
    ),
  );
  private readonly roleNames = computed(() => new Map(this.roles().map((r) => [r.id, r.name])));

  /** The live strip at the top of the role drawer; a tile pops when its page is switched on. */
  private readonly tiles = viewChildren<ElementRef<HTMLElement>>('tile');

  constructor() {
    this.load();
    inject(AdminFeed).watch(['staff', 'roles'], () => this.load());
  }

  protected load(): void {
    this.api.load().subscribe({
      next: (page) => {
        this.page.set(page);
        this.error.set('');
      },
      error: (err: Error) => this.error.set(err.message),
    });
  }

  protected roleName(user: User): string {
    return this.roleNames().get(user.adminRoleId ?? 0) ?? 'Role removed';
  }

  protected opens(role: { permissions: Permissions }, key: AdminSection): boolean {
    return Boolean(role.permissions[key]?.length);
  }

  protected allows(role: { permissions: Permissions }, key: AdminSection, action: AdminAction): boolean {
    return Boolean(role.permissions[key]?.includes(action));
  }

  /** "View, Answer", for a tile's tooltip. */
  protected rights(role: { permissions: Permissions }, key: AdminSection): string {
    return actionsOf(key).filter((a) => this.allows(role, key, a.key)).map((a) => a.label).join(', ');
  }

  /** What the chosen rights let someone do here, in words, under the page's row: "Accept or turn down requests." */
  protected canDo(role: { permissions: Permissions }, key: AdminSection): string {
    const chosen = actionsOf(key).filter((a) => a.key !== 'view' && this.allows(role, key, a.key));
    const said = chosen.map((a, i) => (i ? a.hint.charAt(0).toLowerCase() + a.hint.slice(1) : a.hint));
    return said.length ? said.join('; ') + '.' : this.opens(role, key) ? 'Look only.' : '';
  }

  /** Every right the page has: its tile is drawn solid. */
  protected full(role: { permissions: Permissions }, key: AdminSection): boolean {
    return role.permissions[key]?.length === actionsOf(key).length;
  }

  protected pageCount(role: { permissions: Permissions }): number {
    return Object.values(role.permissions).filter((a) => a?.length).length;
  }

  protected closeDrawers(): void {
    if (this.busy()) return;
    if (this.removing() || this.deletingRole()) {
      this.removing.set(null);
      this.deletingRole.set(false);
      return;
    }
    this.role.set(null);
    this.person.set(null);
  }

  // ---- roles ----
  protected openRole(role: AdminRole | null): void {
    this.drawerError.set('');
    this.role.set(role ? { ...role } : { id: null, name: '', permissions: {}, staff: 0 });
  }

  /** View off takes the page away; any other action on brings View with it (nobody changes what they cannot see). */
  protected toggleAction(key: AdminSection, action: AdminAction): void {
    const draft = this.role();
    if (!draft) return;
    const now = draft.permissions[key] ?? [];
    const wasOpen = now.length > 0;
    let next: AdminAction[];
    if (now.includes(action)) next = action === 'view' ? [] : now.filter((a) => a !== action);
    else next = actionsOf(key).map((a) => a.key).filter((a) => a === 'view' || a === action || now.includes(a));
    this.role.set({ ...draft, permissions: { ...draft.permissions, [key]: next } });
    if (!wasOpen && next.length) this.pop(ADMIN_SECTIONS.findIndex((s) => s.key === key));
  }

  /** Every page with all it allows, or none. */
  protected setAll(on: boolean): void {
    const draft = this.role();
    if (!draft) return;
    const all = Object.fromEntries(ADMIN_SECTIONS.map((s) => [s.key, s.actions.map((a) => a.key)]));
    this.role.set({ ...draft, permissions: on ? all : {} });
  }

  protected readonly everything = computed(() => {
    const draft = this.role();
    return Boolean(draft) && ADMIN_SECTIONS.every((s) => this.full(draft!, s.key));
  });

  /** The one moving thing on the page: a tile springs in as its page is given to the role. */
  private pop(index: number): void {
    const tile = this.tiles()[index]?.nativeElement;
    if (!tile || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    animate(tile, { scale: [0.55, 1], rotate: [-8, 0] }, { type: 'spring', visualDuration: 0.45, bounce: 0.4 });
  }

  protected saveRole(event: Event): void {
    event.preventDefault();
    const draft = this.role();
    if (!draft || this.busy()) return;
    if (!this.pageCount(draft)) return this.drawerError.set('Choose at least one page the role opens.');
    this.run(this.api.saveRole(draft.id, { name: draft.name, permissions: draft.permissions }), () => this.role.set(null));
  }

  protected deleteRole(): void {
    const draft = this.role();
    if (!draft?.id) return;
    this.run(this.api.deleteRole(draft.id), () => {
      this.deletingRole.set(false);
      this.role.set(null);
    });
  }

  // ---- staff ----
  protected openPerson(user: User | null): void {
    this.drawerError.set('');
    this.person.set(
      user
        ? { id: user.id, name: user.name, email: user.email, password: '', roleId: user.adminRoleId ?? null }
        : { id: null, name: '', email: '', password: newPassword(), roleId: this.roles()[0]?.id ?? null },
    );
  }

  protected patchPerson(patch: Partial<StaffDraft>): void {
    const draft = this.person();
    if (draft) this.person.set({ ...draft, ...patch });
  }

  protected savePerson(event: Event): void {
    event.preventDefault();
    const draft = this.person();
    if (!draft || this.busy() || !(event.target as HTMLFormElement).reportValidity()) return;
    if (draft.roleId === null) return this.drawerError.set('Choose a role.');
    const body = { name: draft.name, email: draft.email, password: draft.password, roleId: draft.roleId };
    this.run(this.api.saveStaff(draft.id, body), (page) => {
      this.person.set(null);
      if (draft.id === null || draft.password) {
        this.copied.set(false);
        const mailed = Boolean(page.mail?.sent);
        this.added.set({ name: draft.name || draft.email, email: draft.email, password: draft.password, isNew: draft.id === null, mailed });
      }
    });
  }

  protected remove(user: User): void {
    this.run(this.api.removeStaff(user.id), () => this.removing.set(null));
  }

  protected copy(done: { email: string; password: string }): void {
    const text = `Sign in at ${location.origin}/login\nEmail: ${done.email}\nPassword: ${done.password}`;
    navigator.clipboard.writeText(text).then(
      () => this.copied.set(true),
      () => this.copied.set(false),
    );
  }

  private run(req: ReturnType<StaffApi['load']>, done: (page: StaffPage) => void): void {
    this.busy.set(true);
    this.drawerError.set('');
    req.subscribe({
      next: (page) => {
        this.busy.set(false);
        this.page.set(page);
        done(page);
      },
      error: (err: Error) => {
        this.busy.set(false);
        // A confirm dialog's error belongs to the page; a drawer's stays in the drawer.
        if (this.removing()) {
          this.removing.set(null);
          this.error.set(err.message);
        } else {
          this.deletingRole.set(false);
          this.drawerError.set(err.message);
        }
      },
    });
  }
}

const actionsOf = (key: AdminSection) => ADMIN_SECTIONS.find((s) => s.key === key)?.actions ?? [];
