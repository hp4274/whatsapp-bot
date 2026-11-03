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
import { DatePipe, DecimalPipe } from '@angular/common';
import { Observable, forkJoin, map, switchMap } from 'rxjs';

import { CustomSafetyState, SafetyPolicy, TenancyApi, TenantLimits } from '../core/api';
import { Tenant, TenantControls, TenantSubscriptionSummary } from '../core/auth';
import { SAFETY_GROUPS } from '../core/safety-fields';
import {
  BILLINGS,
  Balance,
  PAYMENTS,
  Payment,
  Plan,
  PlanLogEntry,
  PlansApi,
  Subscription,
  TENANT_LIMIT_FIELDS,
  UsageRow,
  billingOf,
  formatPrice,
  limitText,
  money,
  paidPrice,
  stateTone,
  subscriptionWhen,
} from './plans-api';
import { POLICY_SERVICES } from './policy-api';
import { PolicyEditor } from './policy-editor';
import { TenantAccounts } from './tenant-accounts';
import { TenantDetailsEdit } from './tenant-details-edit';
import { TenantPayments } from './tenant-payments';
import { AdminFeed } from './admin-feed';
import { LeadsApi } from './leads-api';
import { Activation, TenantSummary } from './tenant-summary';
import { serviceMeta } from './service-meta';
import { sentenceCase } from './text';

/** Which tab of the drawer is showing. */
export type SettingsTab = 'general' | 'plan' | 'payments' | 'limits' | 'safety' | 'rules' | 'accounts';

/** The Security card's two irreversible actions. */
type AccessAction = 'sessions' | 'keys';

/** Working copy of one tenant's settings; nothing is sent until Save. */
type SettingsDraft = {
  tenant: Tenant;
  controls: TenantControls;
  safety: SafetyPolicy | null;
  /** The policy as loaded: Save sends only the fields that differ from it. */
  safetyBase: SafetyPolicy | null;
  custom: CustomSafetyState | null;
  limits: TenantLimits;
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

/** null = no limit for every numeric limit; 0 allows none. */
const DEFAULT_LIMITS: TenantLimits = {
  maxChannels: null,
  maxUsers: null,
  maxTemplates: null,
  maxContactsPerCampaign: null,
  maxMediaMb: null,
  allowWhatsappWeb: true,
  blockedWords: '',
  allowCustomSafety: false,
};

/** An ISO time as the local calendar day (YYYY-MM-DD) a date box shows; '' for none. */
function localDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Plan first: it is what an admin opening a business usually came for. */
const TABS: readonly { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'plan', label: 'Plan', icon: 'crown' },
  { id: 'payments', label: 'Payments', icon: 'cash' },
  { id: 'general', label: 'General', icon: 'adjustments-horizontal' },
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
  imports: [DatePipe, DecimalPipe, PolicyEditor, TenantAccounts, TenantDetailsEdit, TenantPayments, TenantSummary],
  templateUrl: './tenant-settings.html',
  styleUrl: './tenant-settings.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantSettings {
  private readonly api = inject(TenancyApi);
  private readonly plansApi = inject(PlansApi);
  private readonly leadsApi = inject(LeadsApi);

  readonly tenant = input.required<Tenant>();
  readonly initialTab = input<SettingsTab>('plan');
  /** The services drawer is open beside this one: slide left to make room for it on the right. */
  readonly pushed = input(false);
  /** The business's place in the tenant list (1, 2, 3...), shown in the header instead of its database id. */
  readonly number = input<number | null>(null);
  /** How many services the platform offers, for the "n of m enabled" summary. */
  readonly serviceCount = input(0);
  readonly closed = output<void>();
  /** Saved: the parent should reload its list. */
  readonly saved = output<void>();
  /** The drawer for choosing services lives in the parent. */
  readonly chooseServices = output<Tenant>();

  /** Pill labels are sentence case: "past_due" reads "Past due". */
  protected readonly sentence = sentenceCase;
  protected readonly settings = signal<SettingsDraft | null>(null);
  protected readonly tab = linkedSignal<SettingsTab>(() => this.initialTab());
  /** The left column shows the Edit details form instead of the summary; closed for each business opened. */
  protected readonly editing = linkedSignal(() => {
    this.tenant();
    return false;
  });
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  /** Revoking takes two clicks instead of a window.confirm. */
  protected readonly revokeConfirm = signal(false);
  /** Security card: the action waiting on its confirm step, one in flight, and the last result. */
  protected readonly accessAsk = signal<AccessAction | null>(null);
  protected readonly accessBusy = signal<AccessAction | null>(null);
  protected readonly accessNotice = signal<{ readonly tone: 'ok' | 'bad'; readonly text: string } | null>(null);

  /** A pending business has no one signing in yet, so no Accounts tab until it is activated. */
  protected readonly tabs = computed(() =>
    this.settings()?.tenant.status === 'pending' ? TABS.filter((t) => t.id !== 'accounts') : TABS,
  );
  protected readonly accessActions = ACCESS_ACTIONS;
  protected readonly controlKeys = CONTROL_KEYS;
  protected readonly limitFields = TENANT_LIMIT_FIELDS;
  protected readonly limitText = limitText;
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
  protected readonly paidPrice = paidPrice;
  protected readonly stateTone = stateTone;
  protected readonly payments = PAYMENTS;
  /** Billing: the price typed for a plan with no list price, starting from the saved one. */
  protected readonly agreedAmount = linkedSignal<number | null>(() => this.sub()?.customPrice ?? null);
  /** Charged, paid and due: from the list, then from each plan action and the Payments tab. */
  protected readonly balance = linkedSignal<Balance | NonNullable<Tenant['balance']> | null>(
    () => this.tenant().balance ?? null,
  );
  protected readonly when = subscriptionWhen;
  /** Which service's rules the Rules tab is showing. */
  protected readonly rulesService = signal(POLICY_SERVICES[0]);
  /** A pending business just switched on: its sign-in, shown once in the left column. */
  protected readonly activation = signal<Activation | null>(null);
  /** Limits tab: what the business has used against each limit (null while loading or if it failed). */
  protected readonly usage = signal<UsageRow[] | null>(null);
  protected readonly uploadMb = signal(10);
  /** Plan tab: its history, newest first. */
  protected readonly history = signal<PlanLogEntry[]>([]);
  /** Plan tab: the end date picked (YYYY-MM-DD), starting from the saved one. */
  protected readonly endDate = linkedSignal(() => localDay(this.sub()?.validUntil));
  /** The saved end date as the same local day, to tell whether the box was changed. */
  protected readonly savedEndDay = computed(() => localDay(this.sub()?.validUntil));
  /** Quick amounts beside the top-up boxes. */
  protected readonly topupDayChips = [7, 30, 90];
  protected readonly topupMessageChips = [1000, 5000, 10000];
  protected readonly topupDays = signal<number | null>(null);
  protected readonly topupMessages = signal<number | null>(null);
  /** What the top-up costs; charged (unpaid until paid) when it is applied. Empty = no charge. */
  protected readonly topupPrice = signal<number | null>(null);
  /** Change plan: the plan picked, and the price typed for it when it has no list price (Enterprise, custom). */
  protected readonly pickedInfo = computed(() => this.plans().find((p) => p.key === this.pickedPlan()));
  protected readonly planAmount = linkedSignal<number | null>(() =>
    this.pickedPlan() === this.sub()?.planKey ? (this.sub()?.customPrice ?? null) : null,
  );
  /** A paying business moving to a plan with no list price says what it will pay for it. */
  protected readonly needsAmount = computed(() => {
    const p = this.pickedInfo();
    return !!p && !p.price && !this.free();
  });
  /** Under the plan cards: what moving (or renewing) charges. */
  protected readonly chargeNote = computed(() => {
    const p = this.pickedInfo();
    if (!p) return '';
    if (this.free()) return 'Marked free under Billing: the plan is not charged.';
    const price = p.price || this.planAmount();
    const verb = p.key === this.sub()?.planKey ? 'Renewing charges' : 'Moving charges';
    return price
      ? `${verb} ${money(price, p.currency)} for the ${p.interval}. It stays unpaid until you record a payment under Payments.`
      : `${p.name} has no list price: type what this business pays for it.`;
  });
  /** Plans that can be picked: the active ones, plus the current one even if it was archived since. */
  protected readonly choosablePlans = computed(() =>
    this.plans().filter((p) => p.active || p.key === this.sub()?.planKey),
  );

  /** A business marked free is free on whichever plan it moves to. */
  protected readonly free = computed(() => this.sub()?.payment === 'free');
  /** Free, with top-ups that were charged: shown as Hybrid. */
  protected readonly hybrid = computed(() => this.free() && (this.balance()?.topupCharged ?? 0) > 0);

  /** A plan card's message limits: "25,000 a month · 500 a day per number". */
  protected planMessages(plan: Plan): string {
    const month = plan.limits.messagesPerMonth;
    const monthly = month === null || month === undefined ? 'Unlimited a month' : `${month.toLocaleString()} a month`;
    const day = plan.dailyCap;
    const daily = day ? `${day.toLocaleString()} a day per number` : 'no daily cap';
    return `${monthly} · ${daily}`;
  }

  /** A plan card's title: "Business · Free" while the business is marked free, else the plan's name. */
  protected planTitle(plan: Plan): string {
    return this.free() ? `${plan.name} · Free` : plan.name;
  }

  /** Under the title: the plan's price, or its list price when the business pays nothing. */
  protected planPrice(plan: Plan): string {
    const agreed = plan.key === this.sub()?.planKey ? this.sub()?.customPrice : null;
    if (!this.free()) return paidPrice(plan, agreed);
    // A plan with no list price and nothing agreed yet: say so instead of "normally Custom".
    if (!plan.price && (agreed === null || agreed === undefined)) return 'Priced per contract';
    return `Normally ${paidPrice(plan, agreed)}`;
  }

  /** "Business · Free": the plan, and how it is paid when that is recorded. */
  protected readonly planLabel = computed(() => {
    const cur = this.sub();
    if (!cur) return '';
    const billing = billingOf(cur.payment, this.balance()?.topupCharged ?? 0);
    return billing ? `${this.planName(cur.planKey)} · ${BILLINGS[billing].label}` : this.planName(cur.planKey);
  });

  constructor() {
    this.loadPlans();
    // A plan, rule or this business changed (in another tab, by another admin, or saved here): the plan cards, usage
    // against limits and history show it at once. The working copy being edited on the right is left alone.
    inject(AdminFeed).watch(['tenants', 'policy', 'billing'], () => {
      const id = this.settings()?.tenant.id;
      this.loadPlans();
      if (id != null) {
        this.loadUsage(id);
        this.loadHistory(id);
      }
    });
    effect(() => {
      const tenant = this.tenant();
      untracked(() => {
        this.activation.set(null);
        this.usage.set(null);
        this.history.set([]);
        this.load(tenant);
        this.loadUsage(tenant.id);
        this.loadHistory(tenant.id);
      });
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
      safetyBase: null,
      custom: null,
      limits: { ...DEFAULT_LIMITS, ...(tenant.limits ?? {}) },
    });
    this.api.safety(tenant.id).subscribe({
      next: ({ safety, custom }) =>
        this.settings.update((cur) =>
          cur?.tenant.id === tenant.id ? { ...cur, safety, safetyBase: safety, custom } : cur,
        ),
      error: (err: Error) => this.error.set(err.message),
    });
  }

  private safetyPatch(cur: SettingsDraft): Partial<SafetyPolicy> {
    const { safety, safetyBase: base } = cur;
    if (!safety) return {};
    const changed = (Object.keys(safety) as (keyof SafetyPolicy)[]).filter((key) => safety[key] !== base?.[key]);
    return Object.fromEntries(changed.map((key) => [key, safety[key]])) as Partial<SafetyPolicy>;
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
    forkJoin(this.saveRequests(cur)).subscribe({
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

  /** General, Limits and Anti-ban in one go. Only what the admin changed: an untouched field saved back would pin
   * today's shown value for good. */
  private saveRequests(cur: SettingsDraft) {
    const safetyPatch = this.safetyPatch(cur);
    return [
      this.api.updateTenant(cur.tenant.id, { controls: cur.controls }),
      this.api.setLimits(cur.tenant.id, cur.limits),
      ...(Object.keys(safetyPatch).length ? [this.api.setSafety(cur.tenant.id, safetyPatch)] : []),
    ];
  }

  /**
   * Switch a pending business on from the left column. The right side's unsaved edits are saved first, so what the
   * admin set up is what the owner signs in to; then the owner's password is set and (if ticked) emailed.
   */
  protected activate(choice: { password: string; sendWelcome: boolean }) {
    const cur = this.settings();
    if (!cur || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    forkJoin(this.saveRequests(cur))
      .pipe(switchMap(() => this.leadsApi.activate(cur.tenant.id, choice)))
      .subscribe({
        next: ({ tenant, owner, email }) => {
          this.saving.set(false);
          this.activation.set({ email: owner.email, password: choice.password, mail: choice.sendWelcome ? email : null });
          this.load({ ...cur.tenant, ...tenant });
          this.saved.emit();
        },
        error: (err: Error) => {
          this.saving.set(false);
          this.error.set(err.message);
        },
      });
  }

  /**
   * One plan action on the server, then the same follow-up for all of them: the subscription shown is the one the
   * server returned (and the business, when it sends it back), the usage and history are read again, the list
   * behind the drawer is told, and `notice` says what happened.
   */
  private planAction(
    request: Observable<{ subscription?: Subscription; tenant?: Tenant }>,
    notice: string,
    reloadTenant = false,
  ) {
    const cur = this.settings();
    if (!cur) return;
    this.saving.set(true);
    this.error.set('');
    this.planNotice.set('');
    request.subscribe({
      next: ({ subscription, tenant }) => {
        this.saving.set(false);
        if (reloadTenant && tenant) this.load({ ...cur.tenant, ...tenant });
        if (tenant?.balance) this.balance.set(tenant.balance);
        if (subscription) this.sub.set(subscription);
        this.planNotice.set(notice);
        this.loadUsage(cur.tenant.id);
        this.loadHistory(cur.tenant.id);
        this.saved.emit();
      },
      error: (err: Error) => {
        this.saving.set(false);
        this.error.set(err.message);
      },
    });
  }

  /** Change plan, or renew with the current key; the server re-applies services and limits and charges the plan. */
  protected subscribe(planKey: string) {
    const cur = this.settings();
    if (!cur || !planKey) return;
    // Renewing keeps the price already set; moving to a plan with no list price sends the one typed.
    const amount = planKey !== this.sub()?.planKey && this.needsAmount() ? this.planAmount() : null;
    this.planAction(
      this.plansApi.subscribe(cur.tenant.id, planKey, undefined, undefined, amount),
      planKey === this.sub()?.planKey ? 'Plan renewed: a new period started.' : 'Plan applied. Services and limits now follow it.',
      true,
    );
  }

  /**
   * Edit details saved: the header and summary show the new name and number at once, the list behind follows, and
   * the unsaved edits on the right are kept.
   */
  protected detailsSaved(tenant: Tenant) {
    this.settings.update((s) => (s ? { ...s, tenant: { ...s.tenant, ...tenant } } : s));
    this.editing.set(false);
    this.saved.emit();
  }

  /** Paid or free, saved at once: the plan and its period stay, and nothing already charged changes. */
  protected setPayment(payment: Payment) {
    const cur = this.settings();
    if (!cur || (this.sub()?.payment ?? 'paid') === payment) return;
    this.planAction(
      this.plansApi.setPayment(cur.tenant.id, payment),
      payment === 'free' ? 'Marked free: plans and top-ups are not charged from now on.' : 'Marked paid.',
    );
  }

  protected setAgreed(raw: string) {
    const n = Math.round(Number(raw));
    this.agreedAmount.set(raw.trim() === '' || !Number.isFinite(n) || n < 0 ? null : n);
  }

  /** The price this business pays for a plan with no list price; it is charged when the plan is put on or renewed. */
  protected saveAgreed() {
    const cur = this.settings();
    if (!cur) return;
    this.planAction(
      this.plansApi.setCustomPrice(cur.tenant.id, this.agreedAmount()),
      'Plan price saved. It is charged when the plan is put on or renewed.',
    );
  }

  /** "₹2,497 unpaid". */
  protected remainingText(due: number): string {
    return `${money(due, this.currentPlan()?.currency ?? 'INR')} unpaid`;
  }

  protected cancelPlan(immediate: boolean) {
    const cur = this.settings();
    if (!cur) return;
    this.cancelAsk.set(false);
    this.planAction(this.plansApi.cancel(cur.tenant.id, immediate), immediate ? 'Plan ended.' : 'Plan will end at the period end.');
  }

  /** Save the end date picked, or remove it (null). */
  protected saveValidity(clear = false) {
    const cur = this.settings();
    if (!cur) return;
    const day = clear ? null : this.endDate() || null;
    // The end of that day where the admin is, so the date picked is the date every screen shows.
    const date = day ? new Date(`${day}T23:59:59.999`).toISOString() : null;
    this.planAction(
      this.plansApi.setValidity(cur.tenant.id, date),
      date ? 'End date saved.' : 'End date removed: the plan renews monthly.',
      true,
    );
  }

  /** Add the days and messages typed (either may be empty). */
  protected applyTopUp() {
    const cur = this.settings();
    if (!cur) return;
    const days = this.topupDays() ?? 0;
    const messages = this.topupMessages() ?? 0;
    if (!days && !messages) {
      this.error.set('Enter days, messages or both to top up.');
      return;
    }
    const parts = [days ? `${days} day${days === 1 ? '' : 's'}` : '', messages ? `${messages.toLocaleString()} messages` : '']
      .filter(Boolean)
      .join(' and ');
    // Charged on a free plan too: that is what makes it Hybrid.
    const amount = this.topupPrice() ?? 0;
    this.planAction(
      this.plansApi.topUp(cur.tenant.id, { days, messages, ...(amount ? { amount } : {}) }),
      `Topped up ${parts}${amount ? `; ${money(amount, this.currentPlan()?.currency ?? 'INR')} charged under Payments` : ''}.`,
      true,
    );
    this.topupDays.set(null);
    this.topupMessages.set(null);
    this.topupPrice.set(null);
  }

  /** The three limits from the Plan tab: only those keys, so the rest of the business's limits stay as saved. */
  protected savePlanLimits() {
    const cur = this.settings();
    if (!cur) return;
    const { maxChannels, maxUsers, maxTemplates, messagesPerMonth } = cur.limits;
    const requests: Observable<unknown>[] = [
      this.api.setLimits(cur.tenant.id, {
        maxChannels,
        maxUsers,
        maxTemplates,
        // Absent in the working copy = follow the plan, which the server is told as 'plan'.
        messagesPerMonth: messagesPerMonth === undefined ? 'plan' : messagesPerMonth,
      }),
    ];
    // The per-number day is the anti-ban daily limit: 0 here = the plan's day, sent as a reset (null).
    const day = cur.safety?.dailyLimit ?? null;
    if (day !== null && day !== cur.safetyBase?.dailyLimit) {
      requests.push(this.api.setSafety(cur.tenant.id, { dailyLimit: day || null } as unknown as Partial<SafetyPolicy>));
    }
    this.planAction(
      forkJoin(requests).pipe(
        map(() => {
          // Saved: the day becomes the baseline, so Anti-ban's Save does not send it again.
          this.settings.update((s) => (s?.safety && s.safetyBase ? { ...s, safetyBase: { ...s.safetyBase, dailyLimit: s.safety.dailyLimit } } : s));
          return {};
        }),
      ),
      'Limits saved.',
    );
  }

  /** Messages a month: following the plan (no own quota), or this business's own. */
  protected readonly followMonth = computed(() => this.settings()?.limits.messagesPerMonth === undefined);
  /** Messages a day per number: 0 is "no ceiling of its own", i.e. the plan's day. */
  protected readonly followDay = computed(() => !this.settings()?.safety?.dailyLimit);

  protected setMonthFollow(follow: boolean) {
    this.settings.update((cur) => {
      if (!cur) return cur;
      const rest = { ...cur.limits };
      delete rest.messagesPerMonth;
      // Leaving the plan's quota starts from it, so the box is never empty by surprise (empty = no limit).
      return { ...cur, limits: follow ? rest : { ...rest, messagesPerMonth: this.currentPlan()?.limits.messagesPerMonth ?? null } };
    });
  }

  /** An empty box is no limit; 0 allows none. */
  protected setMonth(raw: string) {
    this.setLimit('messagesPerMonth', raw.trim() === '' ? null : Math.max(0, Math.floor(Number(raw) || 0)));
  }

  protected setDayFollow(follow: boolean) {
    this.setSafetyValue('dailyLimit', (follow ? 0 : this.currentPlan()?.dailyCap || 250) as never);
  }

  /** At least 1 a day: to send nothing, switch off Outbound sending under General. An empty box is the plan's day. */
  protected setDay(raw: string) {
    this.setSafetyValue('dailyLimit', (raw.trim() === '' ? 0 : Math.max(1, Math.floor(Number(raw) || 1))) as never);
  }

  /** A whole number from a box; an empty box is "no limit" (null). */
  protected setCap(key: 'maxChannels' | 'maxUsers' | 'maxTemplates', raw: string) {
    this.setLimit(key, raw.trim() === '' ? null : Math.max(0, Math.floor(Number(raw) || 0)));
  }

  /** A top-up box: empty or 0 adds nothing. */
  protected topupNumber(raw: string): number | null {
    const n = Math.floor(Number(raw));
    return raw.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n;
  }

  private loadPlans() {
    this.plansApi.plans().subscribe({
      next: ({ plans }) => this.plans.set(plans),
      error: (err: Error) => this.error.set(err.message),
    });
  }

  private loadUsage(tenantId: number) {
    this.plansApi.usage(tenantId).subscribe({
      next: ({ rows, uploadMb }) => {
        if (this.settings()?.tenant.id !== tenantId) return;
        this.usage.set(rows);
        this.uploadMb.set(uploadMb);
      },
      error: () => this.usage.set(null),
    });
  }

  private loadHistory(tenantId: number) {
    this.plansApi.history(tenantId).subscribe({
      next: ({ logs }) => {
        if (this.settings()?.tenant.id === tenantId) this.history.set(logs);
      },
      error: () => this.history.set([]),
    });
  }

  /** How full a usage row is, for its bar: 0-100, and over a limit of 0 any use is full. */
  protected usagePct(row: UsageRow): number {
    if (row.limit === null) return 0;
    if (row.limit === 0) return row.used > 0 ? 100 : 0;
    return Math.min(100, Math.round((row.used / row.limit) * 100));
  }

  protected usageTone(row: UsageRow): string {
    const pct = this.usagePct(row);
    return row.limit === null ? 'free' : pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
  }

  protected actorName(entry: PlanLogEntry): string {
    return entry.actor === 'System' ? 'System' : entry.actor.name || entry.actor.email;
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

  protected setSafetyNumber(key: keyof SafetyPolicy, raw: string) {
    this.setSafetyValue(key, Number(raw) as never);
  }

  protected controlLabel(key: keyof TenantControls): string {
    return CONTROL_LABELS[key];
  }
}
