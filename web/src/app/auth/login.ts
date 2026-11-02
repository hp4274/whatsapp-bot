import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { Auth, AuthError } from '../core/auth';
import { Store } from '../core/store';
import { LeadForm } from '../landing/lead-form';

/**
 * The front door: email and password, nothing else. There is no self-service
 * sign-up or reset because accounts are issued by an administrator, which is
 * what the forgot-password hint says instead of linking anywhere. An email with
 * no account opens the request-access dialog (the landing page's form), which
 * the super admin turns into an account from Leads.
 *
 * The email is remembered in localStorage (when asked) so a returning operator
 * only types the password; storage can be blocked, so every access is guarded.
 */
@Component({
  selector: 'app-login',
  imports: [FormsModule, LeadForm],
  templateUrl: './login.html',
  styleUrl: './login.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
  /** Whether the "ask your administrator" note under Forgot password is open. */
  protected readonly hint = signal(false);
  protected readonly remember = signal(true);
  /** The request-access dialog, opened when the server says the email has no account. */
  protected readonly signup = signal(false);
  private readonly signupRef = viewChild<ElementRef<HTMLDialogElement>>('signupDialog');

  constructor() {
    // The native <dialog> traps focus and closes on Escape; it only needs opening.
    effect(() => {
      const dialog = this.signupRef()?.nativeElement;
      if (dialog && this.signup() && !dialog.open) dialog.showModal();
    });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    // A single HTTP call that completes on its own, so no teardown is needed.
    this.auth.login(this.email().trim(), this.password()).subscribe({
      next: ({ user }) => {
        this.busy.set(false);
        this.rememberEmail();
        // Super admins land on the tenant list; they have no tenant of their own.
        if (user.role === 'super_admin') this.router.navigate(['/admin/tenants']);
        else {
          this.store.start();
          this.router.navigate(['/home']);
        }
      },
      error: (err: AuthError) => {
        this.busy.set(false);
        this.error.set(err.message);
        this.signup.set(err.signup === true);
      },
    });
  }

  private savedEmail(): string {
    try {
      return localStorage.getItem('wsender.email') ?? '';
    } catch {
      return '';
    }
  }

  private rememberEmail(): void {
    try {
      if (this.remember()) localStorage.setItem('wsender.email', this.email().trim());
      else localStorage.removeItem('wsender.email');
    } catch {
      /* storage blocked: nothing to remember */
    }
  }

  /** Moves the brand-wash highlight under the pointer. No transform, so nothing shifts. */
  protected glow(event: PointerEvent): void {
    const el = event.currentTarget as HTMLElement | null;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) return;
    el.style.setProperty(
      '--gleam-x',
      `${(((event.clientX - box.left) / box.width) * 100).toFixed(1)}%`,
    );
    el.style.setProperty(
      '--gleam-y',
      `${(((event.clientY - box.top) / box.height) * 100).toFixed(1)}%`,
    );
  }

  /** Parks the highlight back at the top once the pointer leaves. */
  protected rest(event: PointerEvent): void {
    const el = event.currentTarget as HTMLElement | null;
    el?.style.setProperty('--gleam-x', '50%');
    el?.style.setProperty('--gleam-y', '0%');
  }
}
