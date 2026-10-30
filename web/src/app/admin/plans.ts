import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, forkJoin } from 'rxjs';

import { TenancyApi } from '../core/api';
import type { Tenant } from '../core/auth';
import { Tilt } from '../school/tilt';
import {
  PLAN_LIMIT_FIELDS,
  PLAN_QUOTA_FIELDS,
  Plan,
  PlansApi,
  SubscriptionState,
  formatPrice,
  money,
  stateTone,
  subscriptionWhen,
} from './plans-api';
import { PolicyEditor } from './policy-editor';
import { serviceMeta } from './service-meta';
import { sentenceCase } from './text';

/** The plan being edited; `isNew` unlocks the key field (keys are immutable ids). */
type PlanEditor = { isNew: boolean; plan: Plan };

/** Subscriptions filter; 'none' = businesses on a custom deal with no plan. */
type SubFilter = 'all' | SubscriptionState | 'none';

const BLANK_PLAN: Plan = {
  key: '',
  name: '',
  tier: 1,
  description: '',
  price: 0,
  currency: 'INR',
  interval: 'month',
  trialDays: 14,
  services: [],
  tenantLimits: {
    maxChannels: 0,
    maxUsers: 0,
    maxTemplates: 0,
    maxContactsPerCampaign: 0,
    maxMediaMb: 0,
    allowWhatsappWeb: true,
  },
  // Unlimited until the admin sets one, as the server reads a missing quota.
  limits: { messagesPerMonth: null, apiRequests: null, storageMb: null },
  active: true,
};

/** Plan keys are URL path segments and immutable ids, so keep them boring. */
const KEY_PATTERN = /^[a-z0-9_-]+$/;

const SKELETON: readonly number[] = [0, 1, 2];

/**
 * Plans & billing for the super admin: the plan catalogue (what each plan
 * costs and what it switches on) and every business's subscription.
 *
 * A plan is not just a price: saving a business onto one replaces its services
 * and tenant limits with the plan's, so the cards show those up front. Admin
 * plan changes are immediate (the server resets the period), which is why
 * there is no proration UI here.
 */
@Component({
  selector: 'app-admin-plans',
  imports: [Tilt, PolicyEditor],
  templateUrl: './plans.html',
  styleUrl: './plans.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlansView {
  private readonly api = inject(PlansApi);
  private readonly tenancy = inject(TenancyApi);
  private readonly destroyRef = inject(DestroyRef);

  /** Pill labels are sentence case: "past_due" reads "Past due". */
  protected readonly sentence = sentenceCase;
  protected readonly tab = signal<'plans' | 'subs'>('plans');
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly plans = signal<Plan[]>([]);
  protected readonly services = signal<string[]>([]);
  protected readonly tenants = signal<Tenant[]>([]);
  protected readonly skeleton = SKELETON;
  protected readonly limitFields = PLAN_LIMIT_FIELDS;
  protected readonly quotaFields = PLAN_QUOTA_FIELDS;

  protected readonly editor = signal<PlanEditor | null>(null);
  protected readonly saving = signal(false);
  protected readonly editorError = signal('');
  /** Delete asks inline (second click) instead of window.confirm. */
  protected readonly deleteConfirm = signal(false);

  protected readonly filter = signal<SubFilter>('all');
  /** Plan chosen in each row's picker, by tenant id; unset = the current plan. */
  protected readonly picked = signal<Record<number, string>>({});
  protected readonly busyId = signal<number | null>(null);
  protected readonly cancelAsk = signal<number | null>(null);
  protected readonly notice = signal('');

  protected readonly activePlans = computed(() =>
    this.plans()
      .filter((p) => p.active)
      .sort((a, b) => a.tier - b.tier),
  );
  protected readonly archivedPlans = computed(() => this.plans().filter((p) => !p.active));
  /** Middle tier gets the "popular" lift, like a pricing page. */
  protected readonly featuredKey = computed(() => {
    const list = this.activePlans();
    return list.length > 2 ? list[Math.floor(list.length / 2)].key : null;
  });

  protected readonly counts = computed(() => {
    const c = { active: 0, trialing: 0, grace: 0, expired: 0, none: 0, expiring: 0 };
    for (const t of this.tenants()) {
      const s = t.subscription;
      if (!s) c.none++;
      else {
        c[s.state]++;
        if (s.state === 'grace' || (s.cancelAtPeriodEnd && s.state !== 'expired')) c.expiring++;
      }
    }
    return c;
  });

  /** Active subscriptions only; yearly plans count as price/12. One entry per currency. */
  protected readonly mrr = computed(() => {
    const byCurrency = new Map<string, number>();
    for (const t of this.tenants()) {
      const s = t.subscription;
      if (s?.state !== 'active' || !s.price) continue;
      const monthly = s.interval === 'year' ? s.price / 12 : s.price;
      byCurrency.set(s.currency, (byCurrency.get(s.currency) ?? 0) + monthly);
    }
    return [...byCurrency].map(([currency, amount]) => money(Math.round(amount), currency));
  });

  protected readonly rows = computed(() => {
    const f = this.filter();
    return this.tenants().filter((t) =>
      f === 'all' ? true : f === 'none' ? !t.subscription : t.subscription?.state === f,
    );
  });

  protected readonly keyValid = computed(() => {
    const e = this.editor();
    return !!e && (!e.isNew || KEY_PATTERN.test(e.plan.key)) && !!e.plan.name.trim();
  });

  protected readonly formatPrice = formatPrice;
  protected readonly money = money;
  protected readonly stateTone = stateTone;
  protected readonly when = subscriptionWhen;

  constructor() {
    this.load();
  }

  protected load() {
    this.loading.set(true);
    this.error.set('');
    forkJoin([this.api.plans(), this.tenancy.tenants()])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ([{ plans, services }, { tenants }]) => {
          this.plans.set(plans);
          this.services.set(services);
          this.tenants.set(tenants);
          this.picked.set({});
          this.loading.set(false);
        },
        error: (err: Error) => {
          this.loading.set(false);
          this.error.set(err.message);
        },
      });
  }

  // ---- plan editor ----

  protected newPlan() {
    const tier = Math.max(0, ...this.plans().map((p) => p.tier)) + 1;
    this.openEditor({ isNew: true, plan: { ...BLANK_PLAN, tier } });
  }

  protected edit(plan: Plan) {
    this.openEditor({ isNew: false, plan });
  }

  private openEditor(editor: PlanEditor) {
    this.editorError.set('');
    this.deleteConfirm.set(false);
    this.editor.set(editor);
  }

  protected closeEditor() {
    if (!this.saving()) this.editor.set(null);
  }

  protected patch(change: Partial<Plan>) {
    this.editor.update((e) => (e ? { ...e, plan: { ...e.plan, ...change } } : e));
  }

  protected patchNumber(key: 'tier' | 'price' | 'trialDays', raw: string) {
    this.patch({ [key]: Math.max(0, Number(raw) || 0) });
  }

  protected patchLimit(key: keyof Plan['tenantLimits'], value: number | boolean) {
    const e = this.editor();
    if (!e) return;
    const v = typeof value === 'number' ? Math.max(0, Math.floor(value || 0)) : value;
    this.patch({ tenantLimits: { ...e.plan.tenantLimits, [key]: v } });
  }

  /** Empty = unlimited (null); a number, 0 included, is the cap. */
  protected patchQuota(key: keyof Plan['limits'], raw: string) {
    const e = this.editor();
    if (!e) return;
    const v = raw.trim() === '' ? null : Math.max(0, Math.floor(Number(raw) || 0));
    this.patch({ limits: { ...e.plan.limits, [key]: v } });
  }

  protected toggleService(service: string) {
    const e = this.editor();
    if (!e) return;
    const has = e.plan.services.includes(service);
    this.patch({
      services: has ? e.plan.services.filter((s) => s !== service) : [...e.plan.services, service],
    });
  }

  protected save() {
    const e = this.editor();
    if (!e || !this.keyValid()) return;
    this.saving.set(true);
    this.editorError.set('');
    const { subscribers: _ignored, ...plan } = e.plan;
    this.api
      .savePlan({
        ...plan,
        key: plan.key.trim(),
        name: plan.name.trim(),
        currency: plan.currency.trim().toUpperCase(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.editor.set(null);
          this.load();
        },
        error: (err: Error) => {
          this.saving.set(false);
          this.editorError.set(err.message);
        },
      });
  }

  /** Built-in plans revert to their defaults; custom plans are removed (409 while subscribed). */
  protected remove() {
    const e = this.editor();
    if (!e || e.isNew) return;
    if (!this.deleteConfirm()) {
      this.deleteConfirm.set(true);
      return;
    }
    this.deleteConfirm.set(false);
    this.saving.set(true);
    this.editorError.set('');
    this.api
      .deletePlan(e.plan.key)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ removed }) => {
          this.saving.set(false);
          this.editor.set(null);
          this.notice.set(
            removed ? `${e.plan.name} was deleted.` : `${e.plan.name} was reset to its defaults.`,
          );
          this.load();
        },
        error: (err: Error) => {
          this.saving.set(false);
          this.editorError.set(err.message);
        },
      });
  }

  // ---- subscriptions ----

  protected pickedPlan(t: Tenant): string {
    return this.picked()[t.id] ?? t.subscription?.planKey ?? '';
  }

  protected pick(t: Tenant, key: string) {
    this.picked.update((p) => ({ ...p, [t.id]: key }));
  }

  /** Same endpoint for change and renew: renew is just the current plan again. */
  protected apply(t: Tenant, planKey: string) {
    if (!planKey) return;
    this.run(t, this.api.subscribe(t.id, planKey), `${t.name} is now on ${this.planName(planKey)}.`);
  }

  protected cancel(t: Tenant, immediate: boolean) {
    this.cancelAsk.set(null);
    this.run(
      t,
      this.api.cancel(t.id, immediate),
      immediate ? `${t.name}'s plan has ended.` : `${t.name}'s plan ends at the period end.`,
    );
  }

  private run(t: Tenant, call: Observable<unknown>, done: string) {
    this.busyId.set(t.id);
    this.error.set('');
    this.notice.set('');
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.busyId.set(null);
        this.notice.set(done);
        this.load();
      },
      error: (err: Error) => {
        this.busyId.set(null);
        this.error.set(err.message);
      },
    });
  }

  protected planName(key: string): string {
    return this.plans().find((p) => p.key === key)?.name ?? key;
  }

  protected serviceLabel(key: string): string {
    return serviceMeta(key).label;
  }

  protected serviceIcon(key: string): string {
    return serviceMeta(key).icon;
  }
}
