import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';

import { Api, type CampaignStats, type ConnectionState } from './api';
import { Auth } from './auth';
import { Store } from './store';

/** The store with a hand-driven API: every connection and stats read is a Subject the test answers, late if it likes. */
function setup() {
  const connections: Subject<ConnectionState>[] = [];
  const stats: Subject<{ stats: CampaignStats }>[] = [];
  const channelId = signal<number | null>(1);
  TestBed.configureTestingModule({
    providers: [
      {
        provide: Api,
        useValue: {
          connection: () => connections[connections.push(new Subject<ConnectionState>()) - 1],
          stats: () => stats[stats.push(new Subject<{ stats: CampaignStats }>()) - 1],
        },
      },
      {
        provide: Auth,
        useValue: {
          channelId,
          token: signal('token'),
          isSuperAdmin: () => false,
          actingTenantId: () => null,
          useChannel: (id: number | null) => channelId.set(id),
        },
      },
    ],
  });
  return { store: TestBed.inject(Store), connections, stats };
}

describe('Store switching numbers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
    if (typeof globalThis.matchMedia !== 'function') vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it("drops the number it left's late answers, so a link popup is not closed by the other number's state", () => {
    const { store, connections, stats } = setup();
    store.start(); // number 1: its state is still on the way
    store.useChannel(2); // a link popup opens for number 2
    connections[0].next({ connected: true } as ConnectionState); // number 1 (just reconnected) answers late
    stats[0].next({ stats: { total: 40, pending: 30, processed: 10 } as CampaignStats });
    expect(store.connection().connected).toBe(false);
    expect(store.stats().total).toBe(0);

    connections[1].next({ connected: false } as ConnectionState); // number 2's own answer is taken
    stats[1].next({ stats: { total: 5, pending: 5, processed: 0 } as CampaignStats });
    expect(store.connection().connected).toBe(false);
    expect(store.stats().total).toBe(5);
  });
});
