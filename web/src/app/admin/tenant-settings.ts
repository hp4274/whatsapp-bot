import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
import { Tenant, TenantControls, TenantSubscriptionSummary } from '../core/auth';
import { SAFETY_GROUPS } from '../core/safety-fields';
import {
  Plan,
  PlansApi,
  Subscription,
  formatPrice,
  stateTone,
  subscriptionWhen,
} from './plans-api';
import { POLICY_SERVICES } from './policy-api';
import { PolicyEditor } from './policy-editor';
import { TenantAccounts } from './tenant-accounts';
import { serviceMeta } from './service-meta';

/** Which tab of the drawer is showing. */
export type SettingsTab = 'general' | 'plan' | 'limits' | 'safety' | 'rules' | 'accounts';

/** The Security card's two irreversible actions. */
type AccessAction = 'sessions' | 'keys';

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
  campaignsEnabled: true,
  automationsEnabled: true,
};

const CONTROL_KEYS: readonly (keyof TenantControls)[] = [
  'sendingEnabled',
  'campaignsEnabled',
  'automationsEnabled',
];

const CONTROL_LABELS: Record<keyof TenantControls, string> = {
  sendingEnabled: 'Outbound sending',
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
  { id: 'plan', label: 'Plan', icon: 'crown' },
  { id: 'limits', label: 'Limits', icon: 'chart-donut' },
  { id: 'safety', label: 'Anti-ban', icon: 'shield' },
  { id: 'rules', label: 'Rules', icon: 'list-check' },
  { id: 'accounts', label: 'Accounts', icon: 'users' },
];

const ACCESS_ACTIONS: readonly {
  id: AccessAction;
  label: string;
  hint: string;
  confirm: string;
  icon: string;
}[] = [
  {
    id: 'sessions',
    label: 'Sign everyone out',
    hint: 'Ends every session of this business. People sign in again.',
    confirm: 'Sign out all',
    icon: 'logout',
  },
  {
    id: 'keys',
    label: 'Revoke all API keys',
    hint: 'Every integration using a key stops until the business makes a new one.',
    confirm: 'Revoke keys',
    icon: 'key-off',
  },
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
  private readonly plansApi = inject(PlansApi);

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
  /** Security card: the action waiting on its confirm step, one in flight, and the last result. */
  protected readonly accessAsk = signal<AccessAction | null>(null);
  protected readonly accessBusy = signal<AccessAction | null>(null);
  protected readonly accessNotice = signal<{ readonly tone: 'ok' | 'bad'; readonly text: string } | null>(null);

  protected readonly tabs = TABS;
  protected readonly accessActions = ACCESS_ACTIONS;
  protected readonly controlKeys = CONTROL_KEYS;
  protected readonly limitFields = LIMIT_FIELDS;
  protected readonly safetyGroups = SAFETY_GROUPS;
  protected readonly ruleServices = POLICY_SERVICES.map((key) => ({ key, label: serviceMeta(key).label }));
  /** Plan tab: shown subscription, replaced by what the server returns after each action. */
  protected readonly sub = linkedSignal<TenantSubscriptionSummary | Subscription | null>(
    () => this.tenant().subscription ?? null,
  );
  protected readonly plans = signal<Plan[]>([]);
  protected readonly pickedPlan = linkedSignal(() => this.sub()?.planKey ?? '');
  protected readonly currentPlan = computed(() =>
    this.plans().find((p) => p.key === this.sub()?.planKey),
  );
  protected readonly cancelAsk = signal(false);
  protected readonly planNotice = signal('');
  protected readonly formatPrice = formatPrice;
  protected readonly stateTone = stateTone;
  protected readonly when = subscriptionWhen;
  /** Which service's rules the Rules tab is showing. */
  protected readonly rulesService = signal(POLICY_SERVICES[0]);

  constructor() {
    this.plansApi.plans().subscribe({
      next: ({ plans }) => this.plans.set(plans),
      error: (err: Error) => this.error.set(err.message),
    });
    effect(() => {
      const tenant = this.tenant();
      untracked(() => this.load(tenant));
    });
  }

  private load(tenant: Tenant) {
    this.revokeConfirm.set(false);
    this.accessAsk.set(null);
    this.accessNotice.set(null);
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

  /**
   * Sign everyone out, or revoke every API key. Both take effect at once and
   * cannot be undone, so they run only from the confirm step, never the first click.
   */
  protected revokeAccess(action: AccessAction) {
    const cur = this.settings();
    if (!cur || this.accessBusy()) return;
    this.accessAsk.set(null);
    this.accessBusy.set(action);
    this.accessNotice.set(null);
    const request =
      action === 'sessions' ? this.api.revokeSessions(cur.tenant.id) : this.api.revokeKeys(cur.tenant.id);
    // The result shows in the Security card itself: the drawer's top banner is off-screen down here.
    request.subscribe({
      next: ({ count }) => {
        this.accessBusy.set(null);
        const s = count === 1 ? '' : 's';
        this.accessNotice.set({
          tone: 'ok',
          text: action === 'sessions' ? `Ended ${count} session${s}.` : `Revoked ${count} API key${s}.`,
        });
      },
      error: (err: Error) => {
        this.accessBusy.set(null);
        this.accessNotice.set({ tone: 'bad', text: err.message });
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

  /** Change plan, or renew with the current key; the server re-applies services and limits. */
  protected subscribe(planKey: string) {
    const cur = this.settings();
    if (!cur || !planKey) return;
    this.saving.set(true);
    this.error.set('');
    this.planNotice.set('');
    this.plansApi.subscribe(cur.tenant.id, planKey).subscribe({
      next: ({ subscription, tenant }) => {
        this.saving.set(false);
        this.load({ ...cur.tenant, ...tenant });
        this.sub.set(subscription);
        this.planNotice.set('Plan applied. Services and limits now follow it.');
        this.saved.emit();
      },
      error: (err: Error) => {
        this.saving.set(false);
        this.error.set(err.message);
      },
    });
  }

  protected cancelPlan(immediate: boolean) {
    const cur = this.settings();
    if (!cur) return;
    this.cancelAsk.set(false);
    this.saving.set(true);
    this.error.set('');
    this.planNotice.set('');
    this.plansApi.cancel(cur.tenant.id, immediate).subscribe({
      next: ({ subscription }) => {
        this.saving.set(false);
        this.sub.set(subscription);
        this.planNotice.set(immediate ? 'Plan ended.' : 'Plan will end at the period end.');
        this.saved.emit();
      },
      error: (err: Error) => {
        this.saving.set(false);
        this.error.set(err.message);
      },
    });
  }

  protected planName(key: string): string {
    return this.plans().find((p) => p.key === key)?.name ?? key;
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
