import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { Store } from '../core/store';
import { LimitRequestDrawer } from './limit-request';
import { type LimitRequest, LimitRequestsApi, type LimitRequestsState, askLine } from './limit-requests-api';

const DECLINED: LimitRequest = {
  id: 3,
  items: [{ key: 'maxTemplates', label: 'Templates', value: 80, days: 30 }],
  note: '',
  status: 'declined',
  reason: 'Use fewer drafts first.',
  createdAt: '2026-10-01T10:00:00+00:00',
  decidedAt: '2026-10-02T10:00:00+00:00',
};

const STATE: LimitRequestsState = {
  requests: [DECLINED],
  limits: [
    { key: 'maxTemplates', label: 'Templates', now: 50 },
    { key: 'maxUsers', label: 'Team members', now: null },
  ],
  durations: [7, 30, 90, 365, 0],
};

/** The drawer over a stub API; the test drives the rendered DOM. */
async function setup() {
  const api = {
    list: vi.fn(() => of(STATE)),
    create: vi.fn(() => of({ request: { ...DECLINED, id: 4, status: 'pending' as const, reason: '' } })),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: LimitRequestsApi, useValue: api },
      // Live reloads are not under test here.
      { provide: Store, useValue: { watch: () => undefined } },
    ],
  });
  const fixture = TestBed.createComponent(LimitRequestDrawer);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const send = () => el.querySelector<HTMLButtonElement>('footer .btn.primary')!;
  const add = () => el.querySelector<HTMLButtonElement>('.add')!;
  return { fixture, el, api, send, add };
}

describe('LimitRequestDrawer', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('starts with one ask on the first limit, says what it is now, and lists earlier answers', async () => {
    const { el, send } = await setup();
    expect(el.querySelectorAll('.ask').length).toBe(1);
    expect(el.querySelector('.ask .hint')?.textContent).toContain('Now: 50');
    expect(send().disabled).toBe(true);
    expect(el.querySelector('.req .s-pill')?.textContent).toContain('Declined');
    expect(el.querySelector('.req')?.textContent).toContain('Templates to 80 for 30 days');
    expect(el.querySelector('.reason')?.textContent).toContain('Use fewer drafts first.');
  });

  it('adds each limit once and sends every ask', async () => {
    const { fixture, el, api, send, add } = await setup();
    add().click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelectorAll('.ask').length).toBe(2);
    expect(add().disabled).toBe(true);
    const taken = el.querySelectorAll<HTMLOptionElement>('.ask:nth-child(2) select:first-of-type option')[0];
    expect(taken.disabled).toBe(true);
    expect(el.querySelector('.ask:nth-child(2) .hint')?.textContent).toContain('Now: no limit');

    el.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach((input, i) => {
      input.value = String(i ? 5 : 80);
      input.dispatchEvent(new Event('input'));
    });
    fixture.detectChanges();
    expect(send().disabled).toBe(false);

    send().click();
    expect(api.create).toHaveBeenCalledWith({
      items: [
        { key: 'maxTemplates', value: 80, days: 30 },
        { key: 'maxUsers', value: 5, days: 30 },
      ],
      note: '',
    });
  });
});

describe('askLine', () => {
  it('reads as a short sentence', () => {
    expect(askLine({ key: 'maxUsers', label: 'Team members', value: 12, days: 365 })).toBe('Team members to 12 for 1 year');
    expect(askLine({ key: 'maxUsers', label: 'Team members', value: 12, days: 0 })).toBe('Team members to 12 until changed');
  });
});
