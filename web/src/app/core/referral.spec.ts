import { referralCode, rememberReferral } from './referral';

describe('referral link', () => {
  beforeEach(() => localStorage.removeItem('wapzo.ref'));

  it('keeps the code for 30 days, a newer link replacing it', () => {
    rememberReferral('?ref=RAVI-42', 0);
    expect(referralCode(29 * 864e5)).toBe('RAVI-42');
    expect(referralCode(31 * 864e5)).toBe('');
    rememberReferral('?x=1&ref=ASHA-20', 0);
    expect(referralCode(1)).toBe('ASHA-20');
  });

  it('ignores a URL without one, or with junk', () => {
    rememberReferral('?ref=RAVI-42', 0);
    rememberReferral('?page=2', 0);
    rememberReferral('?ref=<script>', 0);
    expect(referralCode(1)).toBe('RAVI-42');
  });
});
