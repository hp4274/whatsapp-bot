import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TenancyApi } from '../core/api';
import { Auth, ROLE_RANK, Role, User } from '../core/auth';

@Component({
  selector: 'app-team',
  imports: [FormsModule],
  templateUrl: './team.html',
  styleUrl: './team.scss',
})
export class TeamView {
  private readonly api = inject(TenancyApi);
  private readonly auth = inject(Auth);

  protected readonly users = signal<User[]>([]);
  protected readonly roles = signal<Role[]>([]);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly me = this.auth.user;

  protected readonly draft = signal({ name: '', email: '', password: '', role: 'agent' as Role });

  /** You can only create people below you, which is what the server enforces too. */
  protected readonly assignable = computed(() => {
    const mine = this.me()?.role;
    if (!mine) return [];
    if (mine === 'super_admin') return this.roles();
    return this.roles().filter((r) => ROLE_RANK.indexOf(r) < ROLE_RANK.indexOf(mine));
  });

  constructor() {
    this.refresh();
  }

  protected refresh() {
    this.api.users().subscribe({
      next: ({ users, roles }) => {
        this.users.set(users);
        this.roles.set(roles);
      },
      error: (err: Error) => this.error.set(err.message),
    });
  }

  protected add(event: Event) {
    event.preventDefault();
    const d = this.draft();
    this.busy.set(true);
    this.error.set('');
    this.api
      .createUser({ email: d.email.trim(), name: d.name.trim(), password: d.password, role: d.role })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.draft.set({ name: '', email: '', password: '', role: 'agent' });
          this.refresh();
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message);
        },
      });
  }

  protected toggle(user: User) {
    this.api.setUserDisabled(user.id, !user.disabled).subscribe({
      next: () => this.refresh(),
      error: (err: Error) => this.error.set(err.message),
    });
  }

  protected canManage(user: User): boolean {
    const mine = this.me();
    if (!mine || user.id === mine.id) return false;
    if (mine.role === 'super_admin') return true;
    return ROLE_RANK.indexOf(user.role) < ROLE_RANK.indexOf(mine.role);
  }
}
