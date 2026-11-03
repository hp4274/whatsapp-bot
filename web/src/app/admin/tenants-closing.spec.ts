import type { TenantSubscriptionSummary } from '../core/auth';
import { nextEnd } from './tenants-closing';

const NOW = Date.parse('2026-11-02T10:00:00Z');
const day = (n: number) => new Date(NOW + n * 864e5).toISOString();
const sub = (over: Partial<TenantSubscriptionSummary>): TenantSubscriptionSummary => ({
  planKey: 'starter',
  planName: 'Starter',
  price: 999,
  currency: 'INR',
  interval: 'month',
  state: 'active',
  status: 'active',
  trialEndsAt: null,
  currentPeriodEnd: day(29),
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
  ...over,
});

describe('nextEnd', () => {
  it('is nothing for a plan that renews with no end date', () => {
    expect(nextEnd(sub({}), NOW)).toBeNull();
    expect(nextEnd(null, NOW)).toBeNull();
  });

  it('picks the soonest of a trial, an end date and a cancellation', () => {
    const s = sub({ state: 'trialing', trialEndsAt: day(5), validUntil: day(3), cancelAtPeriodEnd: true });
    expect(nextEnd(s, NOW)).toEqual({ at: Date.parse(day(3)), label: 'Plan ends' });
    expect(nextEnd(sub({ cancelAtPeriodEnd: true, currentPeriodEnd: day(2) }), NOW)?.label).toBe('Cancels');
  });

  it('shows the grace running out once the plan is past its end, and nothing once expired', () => {
    expect(nextEnd(sub({ state: 'grace', graceEndsAt: day(4), validUntil: day(-3) }), NOW)?.label).toBe('Grace ends');
    expect(nextEnd(sub({ state: 'expired', validUntil: day(-10) }), NOW)).toBeNull();
  });
});
