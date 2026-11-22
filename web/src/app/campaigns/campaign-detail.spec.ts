import { type WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of, take } from 'rxjs';

import { CampaignPolicy } from '../campaign/policy-api';
import { type Campaign, type CampaignAnalytics, CampaignsApi, type Channel, ChannelsApi } from '../core/api';
import { Store } from '../core/store';
import { CampaignDetailView } from './campaign-detail';

const HOUR = 3_600_000;

function analytics(
  sent: number,
  read: number,
  { status = 'done', finishedAt = new Date().toISOString() } = {},
): CampaignAnalytics {
  return {
    campaign: { id: 7, status, finishedAt, audienceSize: sent } as unknown as Campaign,
    funnel: { audience: sent, queued: sent, sent, delivered: read, read, replied: 0, failed: 0 },
    failures: [],
    clicks: null,
    recipients: [],
  } as unknown as CampaignAnalytics;
}

/** The detail page with a hand-driven API: every analytics call is a Subject the test settles. */
function setup() {
  const calls: Subject<CampaignAnalytics>[] = [];
  const streamOnline = signal(true);
  let numbers: Channel[] = [];
  // The page's reloaders by their first topic: 'campaigns' for the campaign, 'channels' for its numbers.
  const reloaders = new Map<string, () => void>();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: CampaignsApi,
        useValue: {
          analytics: () => {
            const call = new Subject<CampaignAnalytics>();
            calls.push(call);
            // Like HttpClient: one answer, then complete.
            return call.pipe(take(1));
          },
          get: () => new Subject(),
        },
      },
      { provide: CampaignPolicy, useValue: { load: () => undefined } },
      { provide: ChannelsApi, useValue: { list: () => of({ channels: numbers }) } },
      {
        provide: Store,
        useValue: {
          streamOnline,
          now: signal(Date.now()),
          watch: (topics: string[], reload: () => void) => reloaders.set(topics[0], reload),
        },
      },
    ],
  });
  const view = TestBed.runInInjectionContext(() => new CampaignDetailView());
  // The route binds `id`; there is no router here, so stand in for it.
  (view as unknown as { id: () => string }).id = () => '7';
  TestBed.tick();
  const state = view as unknown as {
    analytics: () => CampaignAnalytics | null;
    updatedAt: () => number | null;
    inflight: () => number;
    reload: () => void;
  };
  const setNumbers = (list: Channel[]) => {
    numbers = list;
    reloaders.get('channels')?.();
  };
  return { view: state, page: view, calls, streamOnline, setNumbers, fireEvent: () => reloaders.get('campaigns')?.() };
}

describe('CampaignDetailView freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('drops an older answer that lands after a newer one', () => {
    const { view, calls } = setup();
    expect(calls).toHaveLength(1);
    view.reload();
    calls[1].next(analytics(10, 6));
    calls[0].next(analytics(10, 2)); // the slow first request finally answers
    expect(view.analytics()?.funnel.read).toBe(6);
    expect(view.updatedAt()).not.toBeNull();
  });

  it('still applies an older answer that lands first, so a busy run is never starved', () => {
    const { view, calls } = setup();
    view.reload();
    calls[0].next(analytics(10, 2));
    expect(view.analytics()?.funnel.read).toBe(2);
    calls[1].next(analytics(10, 6));
    expect(view.analytics()?.funnel.read).toBe(6);
  });

  it('reloads on a server event, at most every 3s, and counts requests in flight', () => {
    const { view, calls, fireEvent } = setup();
    calls[0].next(analytics(10, 2));
    expect(view.inflight()).toBe(0);
    // A burst of events right after a read: one more read, once 3s have passed (it lists every recipient).
    fireEvent();
    fireEvent();
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(3_000);
    expect(calls).toHaveLength(2);
    expect(view.inflight()).toBe(1);
    calls[1].complete();
    expect(view.inflight()).toBe(0);
  });

  it('asks nothing for live events while the tab is hidden', () => {
    const { calls, fireEvent } = setup();
    calls[0].next(analytics(10, 2));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent();
    vi.advanceTimersByTime(10_000);
    expect(calls).toHaveLength(1);
  });

  it('keeps polling a finished campaign every ~10s while ticks are still missing', () => {
    const { calls } = setup();
    calls[0].next(analytics(10, 2));
    vi.advanceTimersByTime(9_000);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(3_000);
    expect(calls).toHaveLength(2);
    calls[1].next(analytics(10, 3));
    vi.advanceTimersByTime(12_000);
    expect(calls).toHaveLength(3);
  });

  it('stops polling once everything is read, when hidden, or after a week', () => {
    const settled = setup();
    settled.calls[0].next(analytics(10, 10));
    vi.advanceTimersByTime(60_000);
    expect(settled.calls).toHaveLength(1);
    TestBed.resetTestingModule();

    const hidden = setup();
    hidden.calls[0].next(analytics(10, 2));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.advanceTimersByTime(60_000);
    expect(hidden.calls).toHaveLength(1);
    TestBed.resetTestingModule();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

    const old = setup();
    old.calls[0].next(
      analytics(10, 2, { finishedAt: new Date(Date.now() - 8 * 24 * HOUR).toISOString() }),
    );
    vi.advanceTimersByTime(60_000);
    expect(old.calls).toHaveLength(1);
  });

  it('polls a live run every 3s, as before', () => {
    const { calls } = setup();
    calls[0].next(analytics(10, 0, { status: 'running' }));
    vi.advanceTimersByTime(3_000);
    expect(calls).toHaveLength(2);
  });

  it('polls a scheduled campaign only every ~30s, its start arriving as an event', () => {
    const { calls } = setup();
    calls[0].next(analytics(0, 0, { status: 'scheduled', finishedAt: '' }));
    vi.advanceTimersByTime(27_000);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(3_000);
    expect(calls).toHaveLength(2);
  });

  it('reads again when the event stream comes back', () => {
    const { calls, streamOnline } = setup();
    calls[0].next(analytics(10, 2));
    streamOnline.set(false);
    TestBed.tick();
    expect(calls).toHaveLength(1);
    streamOnline.set(true);
    TestBed.tick();
    expect(calls).toHaveLength(2);
  });
});

describe('CampaignDetailView numbers', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('offers Connect number for a paused run while its number is down, held for it or not, and Resume once back', () => {
    const { page, setNumbers } = setup();
    const view = page as unknown as { campaign: WritableSignal<Campaign | null>; numberDown: () => boolean };
    // Paused by its owner before the number dropped: not held for it, yet its Resume would be refused.
    view.campaign.set({ id: 7, channelId: 2, status: 'paused', options: {} } as unknown as Campaign);
    setNumbers([{ id: 2, status: 'active', health: { connected: false } } as unknown as Channel]);
    expect(view.numberDown()).toBe(true);
    setNumbers([{ id: 2, status: 'active', health: { connected: true } } as unknown as Channel]);
    expect(view.numberDown()).toBe(false);
  });
});
