import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TenancyApi } from '../core/api';
import { Auth, ROLE_RANK, Role, User } from '../core/auth';
import { ConfirmDialog } from '../core/confirm-dialog';

/** Placeholder rows shown while the first user list loads. */
const SKELETON_ROWS: readonly number[] = [0, 1, 2];

/** A loose shape check, so a typo is caught next to the form instead of after a round trip. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The server's team errors are short lower-case phrases meant for logs ("nothing to change");
 * these are the ones a person meets on this page, in words that say what to do.
 */
const FRIENDLY: Readonly<Record<string, string>> = {
  'nothing to change': 'Change the email or type a new password first.',
  'a valid email is required': 'Enter a valid email address.',
  'password must be at least 8 characters': 'Use a password of at least 8 characters.',
  'that email is already registered': 'That email already has an account. Use another one.',
};

/** Server text in sentence case with a full stop; a full plan also says how to make room. */
function plain(message: string): string {
  const known = FRIENDLY[message.trim().toLowerCase()];
  if (known) return known;
  let text = message.trim();
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (!/[.!?]$/.test(text)) text += '.';
  if (/^Your plan allows \d+ team members?\.$/.test(text)) {
    text += ' Disable or remove someone to free a seat.';
  }
  return text;
}

/**
 * Who can sign in to the workspace.
 *
 * Role rules are mirrored here only to hide controls the server would reject
 * anyway; the server remains the authority on who may create, change or remove whom.
 * An owner (or admin) changes a member's email and password here, and removes a
 * member; everyone's own sign-in is the account dialog in the sidebar.
 */
@Component({
  selector: 'app-team',
  imports: [ConfirmDialog, FormsModule],
  templateUrl: './team.html',
  styleUrl: './team.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // On the document, not the dialog: focus can drop to <body> (a disabled Save button), and Escape must still close it.
  // Not mid-save, or a failed save would report its error to a dialog that is already gone.
  host: { '(document:keydown.escape)': '!busy() && editing.set(null)' },
})
export class TeamView {
  private readonly api = inject(TenancyApi);
  private readonly auth = inject(Auth);

  protected readonly skeletonRows = SKELETON_ROWS;

  /** "super_admin" → "Super admin": pills and the role picker show sentence case, not the raw key. */
  protected roleLabel(role: string) {
    const words = role.replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  protected readonly users = signal<User[]>([]);
  protected readonly roles = signal<Role[]>([]);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly loading = signal(true);
  /** The list never arrived: the banner says so, and the table must not claim "No users yet". */
  protected readonly loadFailed = signal(false);
  protected readonly me = this.auth.user;

  protected readonly draft = signal({ name: '', email: '', password: '', role: 'agent' as Role });
  /** Why adding failed, shown inside the form; `addRetry` says whether trying again could help. */
  protected readonly addError = signal('');
  protected readonly addRetry = signal(false);

  /** You can only create people below you, which is what the server enforces too. */
  protected readonly assignable = computed(() => {
    const mine = this.me()?.role;
    if (!mine) return [];
    if (mine === 'super_admin') return this.roles();
    return this.roles().filter((r) => ROLE_RANK.indexOf(r) < ROLE_RANK.indexOf(mine));
  });

  private readonly editEmail = viewChild<ElementRef<HTMLInputElement>>('editEmail');

  constructor() {
    this.refresh();
    // The edit dialog takes focus as it opens, so the keyboard (and Escape) works inside it at once.
    effect(() => this.editEmail()?.nativeElement.focus());
  }

  protected refresh() {
    this.error.set('');
    this.api.users().subscribe({
      next: ({ users, roles }) => {
        this.users.set(users);
        this.roles.set(roles);
        this.loading.set(false);
        this.loadFailed.set(false);
      },
      error: (err: Error) => {
        this.loading.set(false);
        this.loadFailed.set(true);
        this.error.set(plain(err.message));
      },
    });
  }

  protected add(event?: Event) {
    event?.preventDefault();
    if (this.busy()) return;
    const d = this.draft();
    // Checked here rather than by the browser (the form is novalidate) so the message reads like the others.
    const invalid = !EMAIL_SHAPE.test(d.email.trim())
      ? 'Enter a valid email address.'
      : d.password.length < 8
        ? 'Use a password of at least 8 characters.'
        : '';
    this.addRetry.set(false);
    this.addError.set(invalid);
    if (invalid) return;
    this.busy.set(true);
    this.api
      .createUser({
        email: d.email.trim(),
        name: d.name.trim(),
        password: d.password,
        role: d.role,
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.draft.set({ name: '', email: '', password: '', role: 'agent' });
          this.refresh();
        },
        error: (err: Error) => {
          this.busy.set(false);
          const message = plain(err.message);
          this.addError.set(message);
          // A known refusal (bad field, taken email, full plan) fails the same way again; anything else may be a blip.
          this.addRetry.set(!Object.values(FRIENDLY).includes(message) && !message.startsWith('Your plan allows'));
        },
      });
  }

  /** The member being edited and the form for them: a blank password keeps theirs. */
  protected readonly editing = signal<User | null>(null);
  protected readonly editDraft = signal({ email: '', password: '' });
  protected readonly editError = signal('');
  /** The member awaiting the remove confirmation. */
  protected readonly removing = signal<User | null>(null);

  protected openEdit(user: User) {
    this.editError.set('');
    this.editDraft.set({ email: user.email, password: '' });
    this.editing.set(user);
  }

  protected saveEdit(event: Event) {
    event.preventDefault();
    const user = this.editing();
    if (!user || this.busy() || !(event.target as HTMLFormElement).reportValidity()) return;
    const d = this.editDraft();
    const email = d.email.trim();
    this.busy.set(true);
    this.editError.set('');
    this.api
      .setUserCredentials(user.id, {
        ...(email.toLowerCase() !== user.email ? { email } : {}),
        ...(d.password ? { password: d.password } : {}),
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.editing.set(null);
          this.refresh();
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.editError.set(plain(err.message));
        },
      });
  }

  protected remove(user: User) {
    this.removing.set(null);
    this.api.removeUser(user.id).subscribe({
      next: () => this.refresh(),
      error: (err: Error) => this.error.set(plain(err.message)),
    });
  }

  /** Enable or disable: a disabled member cannot sign in and holds no seat on the plan. */
  protected toggle(user: User) {
    this.error.set('');
    this.api.setUserDisabled(user.id, !user.disabled).subscribe({
      next: () => this.refresh(),
      error: (err: Error) => this.error.set(plain(err.message)),
    });
  }

  protected canManage(user: User): boolean {
    const mine = this.me();
    if (!mine || user.id === mine.id) return false;
    if (mine.role === 'super_admin') return true;
    return ROLE_RANK.indexOf(user.role) < ROLE_RANK.indexOf(mine.role);
  }
}
