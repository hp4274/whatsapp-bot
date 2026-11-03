import type { TenantSubscriptionSummary } from '../core/auth';

const DAY_MS = 24 * 3600 * 1000;
/** How far ahead "closing soon" looks. */
const WINDOW_DAYS = 7;

/** What ends next for a subscription, and when; null when nothing ends (it renews monthly with no end date). */
export function nextEnd(sub: TenantSubscriptionSummary | null | undefined, now: number): { at: number; label: string } | null {
  if (!sub || sub.state === 'expired') return null;
  const ends: { at: number; label: string }[] = [];
  const add = (iso: string | null | undefined, label: string) => {
    const at = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(at)) ends.push({ at, label });
  };
  // Already past its end and in grace: the grace running out is what comes next.
  if (sub.state === 'grace') add(sub.graceEndsAt, 'Grace ends');
  if (sub.state === 'trialing') add(sub.trialEndsAt, 'Trial ends');
  if (sub.cancelAtPeriodEnd) add(sub.currentPeriodEnd, 'Cancels');
  add(sub.validUntil, 'Plan ends');
  const upcoming = ends.filter((e) => e.at >= now).sort((a, b) => a.at - b.at);
  return upcoming[0] ?? null;
}

/**
 * What ends within the next 7 days for a business, soonest first (a trial, an end date, an end of period, or the
 * grace after one), with a line for its card: "Trial ends 10 Nov, in 3 days". Null when nothing does.
 */
export function closingSoon(sub: TenantSubscriptionSummary | null | undefined, now: number): { at: number; note: string } | null {
  const end = nextEnd(sub, now);
  if (!end || end.at > now + WINDOW_DAYS * DAY_MS) return null;
  // Whole days left, counted by calendar day, so "tomorrow" means tomorrow.
  const days = Math.round((new Date(end.at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY_MS);
  const day = new Date(end.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return { at: end.at, note: `${end.label} ${day}, ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : 'in ' + days + ' days'}` };
}
