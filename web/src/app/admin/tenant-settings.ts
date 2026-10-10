import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
} from '@angular/core';
import { forkJoin } from 'rxjs';

import { CustomSafetyState, SafetyPolicy, TenancyApi, TenantLimits } from '../core/api';
import { Tenant, TenantControls } from '../core/auth';
import { SAFETY_GROUPS } from '../core/safety-fields';
import { POLICY_SERVICES } from './policy-api';
import { PolicyEditor } from './policy-editor';
import { TenantAccounts } from './tenant-accounts';
import { serviceMeta } from './service-meta';

/** Which tab of the drawer is showing. */
export type SettingsTab = 'general' | 'limits' | 'safety' | 'rules' | 'accounts';

/** Working copy of one tenant's settings; nothing is sent until Save. */
type SettingsDraft = {
  tenant: Tenant;
  controls: TenantControls;
  safety: SafetyPolicy | null;
  custom: CustomSafetyState | null;
  limits: TenantLimits;
};

type LimitField = {
  key: 'maxChannels' | 'maxUsers' | 'maxTemplates' | 'maxContactsPerCampaign' | 'maxMediaMb';
  label: string;
  unit: string;
};

/** New tenants start with everything on; the platform admin narrows from there. */
const DEFAULT_CONTROLS: TenantControls = {
  sendingEnabled: true,
  inboundEnabled: true,
  campaignsEnabled: true,
  automationsEnabled: true,
};

const CONTROL_KEYS: readonly (keyof TenantControls)[] = [
  'sendingEnabled',
  'inboundEnabled',
  'campaignsEnabled',
  'automationsEnabled',
];

const CONTROL_LABELS: Record<keyof TenantControls, string> = {
  sendingEnabled: 'Outbound sending',
  inboundEnabled: 'Inbound webhooks',
  campaignsEnabled: 'Campaign sending',
  automationsEnabled: 'Automations',
};

/** 0 means unlimited for every numeric limit. */
const DEFAULT_LIMITS: TenantLimits = {
  maxChannels: 0,
  maxUsers: 0,
  maxTemplates: 0,
  maxContactsPerCampaign: 0,
  maxMediaMb: 0,
  allowCloudApi: true,
  allowWhatsappWeb: true,
  blockedWords: '',
  allowCustomSafety: false,
};

const LIMIT_FIELDS: readonly LimitField[] = [
  { key: 'maxChannels', label: 'WhatsApp numbers', unit: 'numbers' },
  { key: 'maxUsers', label: 'Team members', unit: 'seats' },
  { key: 'maxTemplates', label: 'Saved templates', unit: 'templates' },
  { key: 'maxContactsPerCampaign', label: 'Contacts per campaign', unit: 'contacts' },
  { key: 'maxMediaMb', label: 'Largest upload', unit: 'MB' },
];

const TABS: readonly { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: 'adjustments-horizontal' },
  { id: 'limits', label: 'Limits', icon: 'chart-donut' },
  { id: 'safety', label: 'Anti-ban', icon: 'shield' },
  { id: 'rules', label: 'Rules', icon: 'list-check' },
  { id: 'accounts', label: 'Accounts', icon: 'users' },
];

/**
 * The platform admin's settings drawer for one tenant: operational switches,
 * plan limits, the anti-ban policy and per-business platform rules.
 *
 * Edits live on a local copy and are saved together in one request group, so a
 * half-edited drawer never changes what the tenant may do. It is its own
 * component, not part of the tenant list, to keep each stylesheet small.
 * The Rules tab saves on its own (the policy editor has its own save bar), so
 * the drawer's Save button is hidden there.
 */
@Component({
  selector: 'app-tenant-settings',
  imports: [PolicyEditor, TenantAccounts],
  templateUrl: './tenant-settings.html',
  styleUrl: './tenant-settings.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantSettings {
  private readonly api = inject(TenancyApi);

  readonly tenant = input.required<Tenant>();
  readonly initialTab = input<SettingsTab>('general');
  /** How many services the platform offers, for the "n of m enabled" summary. */
  readonly serviceCount = input(0);
  readonly closed = output<void>();
  /** Saved: the parent should reload its list. */
  readonly saved = output<void>();
  /** The drawer for choosing services lives in the parent. */
  readonly chooseServices = output<Tenant>();

  protected readonly settings = signal<SettingsDraft | null>(null);
  protected readonly tab = linkedSignal<SettingsTab>(() => this.initialTab());
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  /** Revoking takes two clicks instead of a window.confirm. */
  protected readonly revokeConfirm = signal(false);

  protected readonly tabs = TABS;
  protected readonly controlKeys = CONTROL_KEYS;
  protected readonly limitFields = LIMIT_FIELDS;
  protected readonly safetyGroups = SAFETY_GROUPS;
  protected readonly ruleServices = POLICY_SERVICES.map((key) => ({ key, label: serviceMeta(key).label }));
  /** Which service's rules the Rules tab is showing. */
  protected readonly rulesService = signal(POLICY_SERVICES[0]);

  constructor() {
    effect(() => {
      const tenant = this.tenant();
      untracked(() => this.load(tenant));
    });
  }

  private load(tenant: Tenant) {
    this.revokeConfirm.set(false);
    this.error.set('');
    this.settings.set({
      tenant,
      controls: { ...DEFAULT_CONTROLS, ...(tenant.controls ?? {}) },
      safety: null,
      custom: null,
      limits: { ...DEFAULT_LIMITS, ...(tenant.limits ?? {}) },
    });
    this.api.safety(tenant.id).subscribe({
      next: ({ safety, custom }) =>
        this.settings.update((cur) =>
          cur?.tenant.id === tenant.id ? { ...cur, safety, custom } : cur,
        ),
      error: (err: Error) => this.error.set(err.message),
    });
  }

  protected close() {
    if (!this.saving()) this.closed.emit();
  }

  protected reset() {
    this.load(this.tenant());
  }

  /** Drop the tenant's own limits and take the permission back. Two clicks, no window.confirm. */
  protected revokeCustomSafety() {
    const cur = this.settings();
    if (!cur) return;
    if (!this.revokeConfirm()) {
      this.revokeConfirm.set(true);
      return;
    }
    this.revokeConfirm.set(false);
    this.saving.set(true);
    this.api.revokeCustomSafety(cur.tenant.id).subscribe({
      next: ({ custom }) => {
        this.saving.set(false);
        this.settings.update((s) =>
          s?.tenant.id === cur.tenant.id
            ? { ...s, custom, limits: { ...s.limits, allowCustomSafety: false } }
            : s,
        );
        this.saved.emit();
      },
      error: (err: Error) => {
        this.saving.set(false);
        this.error.set(err.message);
      },
    });
  }

  protected save() {
    const cur = this.settings();
    if (!cur) return;
    this.saving.set(true);
    this.error.set('');
    forkJoin([
      this.api.updateTenant(cur.tenant.id, { controls: cur.controls }),
      this.api.setLimits(cur.tenant.id, cur.limits),
      ...(cur.safety ? [this.api.setSafety(cur.tenant.id, cur.safety)] : []),
    ]).subscribe({
      next: () => {
        this.saving.set(false);
        this.saved.emit();
        this.closed.emit();
      },
      error: (err: Error) => {
        this.saving.set(false);
        this.error.set(err.message);
      },
    });
  }

  protected overrideCount(custom: CustomSafetyState): number {
    return Object.keys(custom.overrides ?? {}).length;
  }

  protected setSettingsControl(key: keyof TenantControls, checked: boolean) {
    this.settings.update((cur) =>
      cur ? { ...cur, controls: { ...cur.controls, [key]: checked } } : cur,
    );
  }

  protected setSafetyValue<K extends keyof SafetyPolicy>(key: K, value: SafetyPolicy[K]) {
    this.settings.update((cur) =>
      cur?.safety ? { ...cur, safety: { ...cur.safety, [key]: value } } : cur,
    );
  }

  protected setLimit<K extends keyof TenantLimits>(key: K, value: TenantLimits[K]) {
    this.settings.update((cur) =>
      cur ? { ...cur, limits: { ...cur.limits, [key]: value } } : cur,
    );
  }

  protected setLimitNumber(key: LimitField['key'], raw: string) {
    this.setLimit(key, Math.max(0, Math.floor(Number(raw) || 0)));
  }

  protected setSafetyNumber(key: keyof SafetyPolicy, raw: string) {
    this.setSafetyValue(key, Number(raw) as never);
  }

  protected controlLabel(key: keyof TenantControls): string {
    return CONTROL_LABELS[key];
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }
}
