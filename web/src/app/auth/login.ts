import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
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
  private readonly card = viewChild.required<ElementRef<HTMLElement>>('card');

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected submit(event: Event) {
    event.preventDefault();
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.auth.login(this.email().trim(), this.password()).subscribe({
      next: ({ user }) => {
        this.busy.set(false);
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

  /** Tilts the card toward the pointer. Pure transform, so it costs no layout. */
  protected tilt(event: PointerEvent) {
    const el = this.card().nativeElement;
    const box = el.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    el.style.setProperty('--tilt-x', `${(-y * 7).toFixed(2)}deg`);
    el.style.setProperty('--tilt-y', `${(x * 9).toFixed(2)}deg`);
    el.style.setProperty('--gleam-x', `${((x + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty('--gleam-y', `${((y + 0.5) * 100).toFixed(1)}%`);
  }

  protected level() {
    const el = this.card().nativeElement;
    el.style.setProperty('--tilt-x', '0deg');
    el.style.setProperty('--tilt-y', '0deg');
  }
}
