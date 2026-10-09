import { Component, ElementRef, computed, inject, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { Api, CustomSafetyView, SafetyPolicy } from '../core/api';
import { SAFETY_GROUPS, SafetyField, safetyRisk } from '../core/safety-fields';

/**
 * A business changing its own anti-ban limits. Only shown when the platform
 * admin allows it; nothing can be changed until someone accepts the risk.
 * Agents get a 403 from the API and simply see the read-only note.
 */
@Component({
  selector: 'app-safety-controls',
  imports: [DatePipe],
  templateUrl: './safety-controls.html',
  styleUrl: './safety-controls.scss',
})
export class SafetyControls {
  private readonly api = inject(Api);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  /** Fired after limits change, so the page can refresh its live safety numbers. */
  readonly changed = output<void>();
  /** Whether custom limits are applied right now (drives the card's badge). */
  readonly active = output<boolean>();

  protected readonly view = signal<CustomSafetyView | null>(null);
  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly resetConfirm = signal(false);
  protected readonly groups = SAFETY_GROUPS;

  // Consent form
  protected readonly understood = signal(false);
  protected readonly fullName = signal('');
  protected readonly confirmation = signal('');
  protected readonly consentReady = computed(() => this.understood() && this.fullName().trim().length > 1
    && this.confirmation().trim().toLowerCase() === 'i accept');

  // Editor
  protected readonly draft = signal<SafetyPolicy | null>(null);
  protected readonly risks = computed(() => {
    const draft = this.draft();
    if (!draft) return {} as Record<string, string>;
    return Object.fromEntries((Object.keys(draft) as (keyof SafetyPolicy)[])
      .map((key) => [key, safetyRisk(key, draft[key], draft)]).filter(([, why]) => why));
  });
  protected readonly riskCount = computed(() => Object.keys(this.risks()).length);
  protected readonly needsConsent = computed(() => !this.view()?.consent);
  protected readonly hasOverrides = computed(() => Object.keys(this.view()?.overrides ?? {}).length > 0);

  constructor() {
    this.load();
  }

  private load(): void {
    this.api.customSafety().subscribe({
      next: (view) => this.show(view),
      error: () => this.view.set(null), // agents (403) and older servers: read-only note
    });
  }

  private show(view: CustomSafetyView): void {
    this.view.set(view);
    this.active.emit(view.active);
  }

  protected openEditor(): void {
    const view = this.view();
    if (!view) return;
    this.error.set('');
    this.resetConfirm.set(false);
    this.understood.set(false);
    this.fullName.set('');
    this.confirmation.set('');
    this.draft.set({ ...view.policy });
    this.open.set(true);
    setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>('.sc-drawer h3')?.focus());
  }

  protected close(): void {
    if (!this.busy()) this.open.set(false);
  }

  protected accept(): void {
    const view = this.view();
    if (!view || !this.consentReady()) return;
    this.busy.set(true);
    this.error.set('');
    this.api.acceptSafetyRisk({
      accept: true, version: view.consentVersion, fullName: this.fullName().trim(), confirmation: this.confirmation().trim(),
    }).subscribe({
      next: (next) => {
        this.busy.set(false);
        this.show(next);
        this.draft.set({ ...next.policy });
        this.changed.emit(); // stored overrides may apply now
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }

  protected setValue<K extends keyof SafetyPolicy>(key: K, value: SafetyPolicy[K]): void {
    this.draft.update((d) => (d ? { ...d, [key]: value } : d));
  }

  protected setNumber(key: keyof SafetyPolicy, raw: string): void {
    this.setValue(key, Number(raw) as never);
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected platformValue(key: keyof SafetyPolicy): string {
    return String(this.view()?.platform[key] ?? '');
  }

  protected changedFromPlatform(field: SafetyField): boolean {
    const draft = this.draft();
    return Boolean(draft && draft[field.key] !== this.view()?.platform[field.key]);
  }

  protected save(): void {
    const view = this.view();
    const draft = this.draft();
    if (!view || !draft) return;
    // Only what differs from the platform, plus anything already overridden.
    const patch = Object.fromEntries((Object.keys(draft) as (keyof SafetyPolicy)[])
      .filter((key) => draft[key] !== view.platform[key] || key in view.overrides)
      .map((key) => [key, draft[key]]));
    if (!Object.keys(patch).length) {
      this.open.set(false);
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.api.setCustomSafety(patch).subscribe({
      next: (next) => {
        this.busy.set(false);
        this.show(next);
        this.open.set(false);
        this.changed.emit();
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }

  /** Two clicks instead of window.confirm. */
  protected reset(): void {
    if (!this.resetConfirm()) {
      this.resetConfirm.set(true);
      return;
    }
    this.resetConfirm.set(false);
    this.busy.set(true);
    this.error.set('');
    this.api.resetCustomSafety().subscribe({
      next: (next) => {
        this.busy.set(false);
        this.show(next);
        this.draft.set({ ...next.policy });
        this.open.set(false);
        this.changed.emit();
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }
}
