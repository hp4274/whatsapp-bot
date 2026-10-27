import type { SafetyStatus } from '../../core/api';
import { finishEstimate } from './review-step';

/** The finish line under the review step's limits: when, and how long if everyone is new. */
describe('finishEstimate', () => {
  const safety = (days: number | null, newChats?: { limit: number; left: number }) =>
    ({
      enabled: true,
      estimateSeconds: { min: 0, max: 0, typical: 0, days, finishesOn: '2026-10-29' },
      budgets: newChats && {
        bulk: { limit: 20, used: 0, left: 20, resetsAt: '' },
        newChats: { ...newChats, used: 0, opensAt: null },
        hour: { limit: 8, used: 0, left: 8 },
      },
    }) as Pick<SafetyStatus, 'enabled' | 'estimateSeconds' | 'budgets'>;

  it('says nothing when it all goes today or nothing is capped', () => {
    expect(finishEstimate(safety(1), 10)).toBeNull();
    expect(finishEstimate(safety(null), 10)).toBeNull();
    expect(finishEstimate({ ...safety(3), enabled: false }, 10)).toBeNull();
  });

  it('gives the day, and the longer run if everyone is new to the number', () => {
    const f = finishEstimate(safety(3, { limit: 5, left: 5 }), 50)!;
    expect(f.days).toBe(3);
    expect(f.label).toContain('29');
    // 5 strangers today, then 5 a day for the other 45.
    expect(f.worst).toBe(10);
    expect(finishEstimate(safety(3, { limit: 50, left: 50 }), 50)!.worst).toBeNull();
  });
});
