import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ContactsApi, GreetingSettings } from '../core/api';
import { Store } from '../core/store';

/**
 * Birthday greetings: which contact detail holds the date and what to send. The server sends it once a year on the
 * day, after 9am on the number's clock (contactGreetings.js). Live: another tab's save or a platform rule change
 * reloads it, unless this one has unsaved edits.
 */
@Component({
  selector: 'app-greetings-card',
  imports: [FormsModule],
  templateUrl: './greetings-card.html',
  styleUrl: './greetings-card.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GreetingsCard {
  private readonly api = inject(ContactsApi);
  private readonly store = inject(Store);

  readonly fieldKeys = input<string[]>([]);
  readonly closed = output<void>();

  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  /** The platform rule contacts.allowDateGreetings. */
  protected readonly allowed = signal(true);
  protected readonly form = signal<GreetingSettings>({ enabled: false, field: '', message: '' });
  protected readonly dirty = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly saved = signal(false);

  /** Date-looking keys first, so "dob" or "birthday" is the obvious pick. */
  protected readonly keys = computed(() => {
    const keys = [...new Set([...this.fieldKeys(), this.form().field].filter(Boolean))];
    const datey = (k: string) => (/birth|dob|date|bday/i.test(k) ? 0 : 1);
    return keys.sort((a, b) => datey(a) - datey(b) || a.localeCompare(b));
  });
  protected readonly preview = computed(() =>
    this.form().message.replace(/\{name(?:\|[^{}]*)?\}/g, 'Asha'),
  );

  constructor() {
    this.load();
    this.store.watch(['contacts', 'config'], () => {
      if (!this.dirty()) this.load(true);
    });
  }

  protected load(quiet = false) {
    if (!quiet) this.loading.set(true);
    this.api.greetings().subscribe({
      next: ({ settings, allowed }) => {
        this.form.set(settings);
        this.allowed.set(allowed);
        this.loadError.set('');
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.loadError.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected patch(change: Partial<GreetingSettings>) {
    this.form.update((f) => ({ ...f, ...change }));
    this.dirty.set(true);
    this.saved.set(false);
  }

  protected save() {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.api.saveGreetings(this.form()).subscribe({
      next: ({ settings }) => {
        this.form.set(settings);
        this.dirty.set(false);
        this.busy.set(false);
        this.saved.set(true);
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }
}
