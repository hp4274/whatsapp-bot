import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { Auth } from '../core/auth';
import { Store } from '../core/store';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class LoginView {
  private readonly auth = inject(Auth);
  private readonly store = inject(Store);
  private readonly router = inject(Router);

  protected readonly email = signal(this.savedEmail());
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly show = signal(false);
  protected readonly hint = signal(false);
  protected readonly remember = signal(true);


  protected submit(event: Event) {
    event.preventDefault();
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.auth.login(this.email().trim(), this.password()).subscribe({
      next: ({ user }) => {
        this.busy.set(false);
        this.rememberEmail();
        // Super admins land on the tenant list; they have no tenant of their own.
        if (user.role === 'super_admin') this.router.navigate(['/admin/tenants']);
        else {
          this.store.start();
          this.router.navigate(['/connection']);
        }
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }

  private savedEmail(): string {
    try { return localStorage.getItem('wsender.email') ?? ''; } catch { return ''; }
  }

  private rememberEmail() {
    try {
      if (this.remember()) localStorage.setItem('wsender.email', this.email().trim());
      else localStorage.removeItem('wsender.email');
    } catch { /* storage blocked: nothing to remember */ }
  }

  /** Moves the highlight under the pointer. No transform, so inputs never shift. */
  protected glow(event: PointerEvent) {
    const el = event.currentTarget as HTMLElement | null;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return;
    el.style.setProperty('--gleam-x', `${(((event.clientX - box.left) / box.width) * 100).toFixed(1)}%`);
    el.style.setProperty('--gleam-y', `${(((event.clientY - box.top) / box.height) * 100).toFixed(1)}%`);
  }

  protected rest(event: PointerEvent) {
    const el = event.currentTarget as HTMLElement | null;
    el?.style.setProperty('--gleam-x', '50%');
    el?.style.setProperty('--gleam-y', '0%');
  }
}
