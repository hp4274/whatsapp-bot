import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TenancyApi, TenantDetails } from '../core/api';
import type { Tenant } from '../core/auth';
import { LeadsApi } from './leads-api';

/** Business details, in the order a form or invoice reads them (server tenancy.js PROFILE_FIELDS). */
export const PROFILE_FIELDS: readonly {
  readonly key: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly half?: boolean;
  readonly max: number;
}[] = [
  { key: 'legalName', label: 'Legal name', placeholder: 'As on the GST certificate', max: 160 },
  { key: 'gstin', label: 'GSTIN', placeholder: '27AAPFU0939F1ZV', half: true, max: 15 },
  { key: 'pan', label: 'PAN', placeholder: 'AAPFU0939F', half: true, max: 10 },
  { key: 'industry', label: 'Industry', placeholder: 'Retail, education...', half: true, max: 80 },
  { key: 'website', label: 'Website', placeholder: 'https://', half: true, max: 200 },
  { key: 'email', label: 'Billing email', placeholder: 'accounts@business.com', max: 254 },
  { key: 'address', label: 'Address', placeholder: 'Street and area', max: 300 },
  { key: 'city', label: 'City', half: true, max: 80 },
  { key: 'state', label: 'State', half: true, max: 80 },
  { key: 'pincode', label: 'PIN code', half: true, max: 10 },
  { key: 'country', label: 'Country', placeholder: 'India', half: true, max: 80 },
];

/**
 * Tenant settings > Edit, in the drawer's left column: the business's name, ID, contact WhatsApp and whether Wapzo
 * messages it, and its owner's name and sign-in email. Saved together; a refused email or ID changes nothing.
 */
@Component({
  selector: 'app-tenant-details-edit',
  imports: [FormsModule],
  templateUrl: './tenant-details-edit.html',
  styleUrl: './tenant-details-edit.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantDetailsEdit implements OnInit {
  private readonly api = inject(TenancyApi);
  private readonly leadsApi = inject(LeadsApi);

  readonly tenant = input.required<Tenant>();
  /** Each save: the business as it is now (the form stays open; Done closes it). */
  readonly saved = output<Tenant>();
  readonly cancelled = output<void>();

  protected readonly form = signal<Required<Omit<TenantDetails, 'profile'>>>({
    name: '',
    slug: '',
    contactPhone: '',
    wapzoUpdates: true,
    ownerName: '',
    ownerEmail: '',
  });
  protected readonly profileFields = PROFILE_FIELDS;
  /** Business details being edited, all of them (blank = not given). */
  protected readonly profile = signal<Record<string, string>>({});
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  ngOnInit(): void {
    const t = this.tenant();
    this.form.set({
      name: t.name,
      slug: t.slug,
      contactPhone: t.contactPhone ?? '',
      wapzoUpdates: t.wapzoUpdates !== false,
      ownerName: '',
      ownerEmail: '',
    });
    this.profile.set(Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, t.profile?.[f.key] ?? ''])));
    // The owner is not on the business row: read it so the form starts from what is saved.
    this.leadsApi.users(t.id).subscribe({
      next: ({ users }) => {
        const owner = users.find((u) => u.role === 'owner');
        if (owner) this.form.update((f) => ({ ...f, ownerName: owner.name ?? '', ownerEmail: owner.email }));
      },
      error: () => undefined,
    });
  }

  protected set<K extends keyof Omit<TenantDetails, 'profile'>>(key: K, value: Required<Omit<TenantDetails, 'profile'>>[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  protected setProfile(key: string, value: string): void {
    this.profile.update((p) => ({ ...p, [key]: value }));
  }

  /** Saved once since the form opened, for the line beside Done. */
  protected readonly savedOnce = signal(false);
  /** A change made while a save runs is saved right after it. */
  private again = false;

  /** A box left changed: save the whole form, if it reads right (the browser says what is wrong otherwise). */
  protected autoSave(form: HTMLFormElement): void {
    if (this.busy()) {
      this.again = true;
      return;
    }
    if (!form.reportValidity()) return;
    const f = this.form();
    this.busy.set(true);
    this.error.set('');
    this.api
      .updateDetails(this.tenant().id, {
        ...f,
        name: f.name.trim(),
        slug: f.slug.trim(),
        contactPhone: f.contactPhone.trim(),
        profile: Object.fromEntries(Object.entries(this.profile()).map(([k, v]) => [k, v.trim()])),
        ownerName: f.ownerName.trim(),
        // An owner the form never loaded keeps their email.
        ...(f.ownerEmail.trim() ? { ownerEmail: f.ownerEmail.trim() } : { ownerEmail: undefined }),
      })
      .subscribe({
        next: ({ tenant }) => {
          this.busy.set(false);
          this.savedOnce.set(true);
          this.saved.emit(tenant);
          if (this.again) {
            this.again = false;
            this.autoSave(form);
          }
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.again = false;
          this.error.set(err.message);
        },
      });
  }
}
