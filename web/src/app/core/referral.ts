/**
 * A marketer's link (`/?ref=RAVI-42`): the code is kept for 30 days, so a visitor who asks for an account later, or
 * from the sign-in page, still counts for the marketer (server referrals.js). The server ignores a code it does not
 * know, so nothing here checks it.
 */

const KEY = 'wapzo.ref';
const DAYS = 30;

/** Keep the `ref` of a URL's query, if it has one; a newer link replaces an older one. */
export function rememberReferral(search: string, now = Date.now()): void {
  const code = new URLSearchParams(search).get('ref')?.trim();
  if (!code || !/^[\w-]{3,20}$/.test(code)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ code, until: now + DAYS * 864e5 }));
  } catch {
    // Storage off (private mode): the code just is not kept.
  }
}

/** The code kept, while it is fresh; '' for none. */
export function referralCode(now = Date.now()): string {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { code?: string; until?: number } | null;
    return kept?.code && (kept.until ?? 0) > now ? kept.code : '';
  } catch {
    return '';
  }
}
