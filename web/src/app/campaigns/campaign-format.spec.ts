import type { Campaign } from '../core/api';
import { progressOf, stopQuestion, waitingWhy } from './campaign-format';

const campaign = (over: Partial<Campaign>): Campaign =>
  ({ id: 1, name: 'C', status: 'running', channelId: 1, audienceSize: 0, options: {}, stats: {}, ...over }) as Campaign;

describe('progressOf', () => {
  it('adds up: sent, failed, skipped and waiting make the total', () => {
    const p = progressOf(
      campaign({
        stats: { total: 2598, pending: 2368, sent: 204, failed: 0, byStatus: { NOT_ON_WHATSAPP: 20, CANCELLED: 6 } },
      }),
    );
    expect([p.done, p.total, p.skipped, p.waiting]).toEqual([230, 2598, 26, 2368]);
    expect(p.sent + p.failed + p.skipped + p.waiting).toBe(p.total);
  });

  it('counts a multi-day campaign against its whole list, and says which day it is', () => {
    const now = Date.parse('2026-11-02T10:00:00Z');
    const p = progressOf(
      campaign({
        options: { spread: { from: '2026-11-01', to: '2026-11-10', startTime: '10:00', total: 5000, cursor: 1000 } },
        stats: { total: 1000, pending: 400, sent: 600, failed: 0 },
      } as Partial<Campaign>),
      now,
    );
    expect([p.done, p.total, p.pct, p.waiting]).toEqual([600, 5000, 12, 4400]);
    expect([p.day, p.days]).toEqual([2, 10]);
  });

  it('reads nothing sent before the first snapshot, not everything', () => {
    expect(progressOf(campaign({ audienceSize: 50 })).done).toBe(0);
    expect(progressOf(campaign({ audienceSize: 50 })).waiting).toBe(50);
  });
});

describe('waitingWhy and stopQuestion', () => {
  it('names a daily-limit hold only while the campaign reads running', () => {
    expect(waitingWhy(campaign({ options: { statusReason: "Today's limit reached" } }))).toBe("Today's limit reached");
    expect(waitingWhy(campaign({ status: 'paused', options: { statusReason: 'x' } }))).toBeNull();
  });

  it('says what stopping costs', () => {
    expect(stopQuestion(2368)).toBe(`Stop? ${(2368).toLocaleString()} won't get it`);
    expect(stopQuestion(0)).toBe('Stop sending?');
  });
});
