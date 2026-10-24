import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

import { Api, type Campaign, CampaignsApi, ContactsApi } from '../core/api';
import { Auth } from '../core/auth';
import { Store } from '../core/store';
import { StorageApi } from '../storage/storage-api';
import { type Template, TemplatesApi } from '../templates/templates-api';
import { CampaignDraft, OPT_OUT_TEXT, parseExtraNumbers, withOptOut, withoutOptOut } from './draft';

const KEY = 'wsender.campaignDraft.3.5';

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: 7,
    name: 'Diwali offer',
    status: 'done',
    templateId: null,
    body: `Hi {name}, 20% off\n\n${OPT_OUT_TEXT}`,
    segmentId: null,
    audience: [{ name: 'Asha', phone: '919876543210', extra: { city: 'Pune' } }],
    audienceSize: 1,
    mediaId: null,
    options: { pacing: 'safe', timezone: 'Asia/Kolkata', optOutLine: true },
    scheduledAt: null,
    startedAt: null,
    finishedAt: null,
    stats: {},
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

/** A fresh draft service over stub APIs; `transport` decides whether Meta mode can apply. */
function setup(transport = 'baileys') {
  const campaignsApi = {
    create: vi.fn((body) => of({ campaign: { ...campaign(), id: 11, name: body.name } })),
    update: vi.fn((id: number, body) => of({ campaign: { ...campaign(), id, name: body.name } })),
    get: vi.fn((id: number) => of({ campaign: campaign({ id }) })),
    replyRules: vi.fn(() => of({ campaignId: 'camp-7', rules: [] })),
    saveReplyRules: vi.fn((_id: number, rules) => of({ campaignId: 'camp-11', rules })),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: Api, useValue: { getConfig: () => of({ config: {} }) } },
      { provide: CampaignsApi, useValue: campaignsApi },
      { provide: ContactsApi, useValue: { segments: () => of({ segments: [] }) } },
      { provide: TemplatesApi, useValue: { get: () => of({ template: { id: 1, body: 'x' } }) } },
      { provide: StorageApi, useValue: { use: () => of({}) } },
      { provide: Auth, useValue: { user: signal({ id: 5 }), tenantId: signal(3) } },
      { provide: Store, useValue: { connection: signal({ transport }) } },
    ],
  });
  return { draft: TestBed.inject(CampaignDraft), campaignsApi };
}

describe('opt-out line', () => {
  it('is appended once, after a blank line', () => {
    const once = withOptOut('Hi {name}  \n');
    expect(once).toBe(`Hi {name}\n\n${OPT_OUT_TEXT}`);
    expect(withOptOut(once)).toBe(once);
  });

  it('is stripped back out of a saved body', () => {
    expect(withoutOptOut(`Hi\n\n${OPT_OUT_TEXT}`)).toEqual({ text: 'Hi', had: true });
    expect(withoutOptOut('Hi')).toEqual({ text: 'Hi', had: false });
  });
});

describe('CampaignDraft.buildCreate', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('appends the opt-out line to a free-form body only', () => {
    const { draft } = setup('cloud_api');
    draft.message.set('Hi {name}');
    draft.optOutLine.set(true);
    expect(draft.buildCreate().body).toBe(`Hi {name}\n\n${OPT_OUT_TEXT}`);
    expect(draft.previewText()).toBe(`Hi {name}\n\n${OPT_OUT_TEXT}`);

    draft.templateMode.set('meta');
    draft.pickMetaTemplate({
      id: 4,
      body: 'Approved {{1}}',
      paramMapping: {},
    } as unknown as Template);
    const meta = draft.buildCreate();
    expect(meta.body).toBe('Approved {{1}}');
    expect(meta.options?.optOutLine).toBe(false);
  });

  it('sends a contacts filter inline, or the segment when one is picked', () => {
    const { draft } = setup();
    draft.source.set('contacts');
    expect(draft.audienceReady()).toBe(false);
    draft.contactFilter.set({ tags: ['vip'] });
    expect(draft.audienceReady()).toBe(true);
    let body = draft.buildCreate();
    expect(body.audience).toEqual({ tags: ['vip'] });
    expect(body.segmentId).toBeNull();

    draft.segmentId.set(9);
    body = draft.buildCreate();
    expect(body.segmentId).toBe(9);
    expect(body.audience).toEqual([]);
  });
});

describe('CampaignDraft.buildCreate (link tracking, A/B, repeat, hand-picked)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('sends version B (and C) only while B has text, A being the main message', () => {
    const { draft } = setup();
    draft.message.set('Hi {name}');
    expect(draft.buildCreate().options?.variants).toBeNull();

    draft.variantB.set('   ');
    expect(draft.buildCreate().options?.variants).toBeNull();

    draft.variantB.set('Hello {name}');
    draft.variantC.set('Hey {name}');
    draft.optOutLine.set(true);
    const variants = draft.buildCreate().options?.variants;
    expect(variants?.map((v) => v.key)).toEqual(['A', 'B', 'C']);
    expect(variants?.[0].body).toBe(`Hi {name}\n\n${OPT_OUT_TEXT}`);
    expect(variants?.[1].body).toBe(`Hello {name}\n\n${OPT_OUT_TEXT}`);

    // C without B is dropped; Meta mode never sends versions.
    draft.variantB.set(null);
    expect(draft.buildCreate().options?.variants).toBeNull();
  });

  it('drops versions and link tracking in Meta mode', () => {
    const { draft } = setup('cloud_api');
    draft.variantB.set('Hello');
    draft.trackLinks.set(true);
    expect(draft.buildCreate().options?.trackLinks).toBe(true);
    draft.templateMode.set('meta');
    draft.pickMetaTemplate({ id: 4, body: 'x', paramMapping: {} } as unknown as Template);
    const meta = draft.buildCreate().options;
    expect(meta?.variants).toBeNull();
    expect(meta?.trackLinks).toBe(false);
  });

  it('offers link tracking only when a version has a URL', () => {
    const { draft } = setup();
    draft.message.set('Hi {name}');
    expect(draft.hasLink()).toBe(false);
    draft.message.set('Hi, see https://example.com/offer');
    expect(draft.hasLink()).toBe(true);
    draft.message.set('Hi');
    draft.variantB.set('Visit www.example.com');
    expect(draft.hasLink()).toBe(true);
  });

  it('sends the repeat, and omits it for a spread', () => {
    const { draft } = setup();
    expect(draft.buildCreate().options?.recurrence).toBeNull();
    draft.repeatEvery.set('week');
    expect(draft.buildCreate().options?.recurrence).toEqual({ every: 'week' });
    draft.repeatUntil.set('2027-01-31');
    expect(draft.buildCreate().options?.recurrence).toEqual({ every: 'week', until: '2027-01-31' });

    draft.scheduleMode.set('spread');
    expect(draft.buildCreate().options?.recurrence).toBeNull();
  });

  it('sends hand-picked contacts as a filter audience', () => {
    const { draft } = setup();
    draft.source.set('contacts');
    draft.contactFilter.set({ ids: [] });
    expect(draft.audienceReady()).toBe(false);
    draft.contactFilter.set({ ids: [4, 9, 12] });
    expect(draft.audienceReady()).toBe(true);
    expect(draft.buildCreate().audience).toEqual({ ids: [4, 9, 12] });
  });
});

describe('typed numbers on top of an audience', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('parses one number per line, adds the country code, drops junk and repeats', () => {
    expect(parseExtraNumbers('9876543210, Asha\n+44 7700 900123\t Bob\nabc\n98765 43210', '91')).toEqual(
      [
        { phone: '+919876543210', name: 'Asha', extra: {} },
        { phone: '+447700900123', name: 'Bob', extra: {} },
      ],
    );
  });

  it('sends them as an option for contacts, and merges them into a file list', () => {
    const { draft } = setup();
    draft.source.set('contacts');
    draft.contactFilter.set({ tags: ['vip'] });
    draft.extraNumbers.set('9876543210, Asha');
    expect(draft.buildCreate().options?.extraNumbers).toEqual([{ phone: '+919876543210', name: 'Asha' }]);

    draft.source.set('file');
    draft.savedAudience.set([{ name: 'Old', phone: '919876543210', extra: {} }]);
    draft.extraNumbers.set('9876543210\n9812345678, New');
    const body = draft.buildCreate();
    expect(body.options?.extraNumbers).toBeNull();
    expect((body.audience as { phone: string }[]).map((c) => c.phone)).toEqual([
      '919876543210',
      '+919812345678',
    ]);
  });
});

describe('CampaignDraft.save', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('creates once, then updates the same campaign', () => {
    const { draft, campaignsApi } = setup();
    draft.save().subscribe();
    expect(campaignsApi.create).toHaveBeenCalledTimes(1);
    expect(draft.editingId()).toBe(11);
    // No buttons, so no reply rules to store on a new campaign.
    expect(campaignsApi.saveReplyRules).not.toHaveBeenCalled();

    draft.save().subscribe();
    expect(campaignsApi.create).toHaveBeenCalledTimes(1);
    expect(campaignsApi.update).toHaveBeenCalledWith(11, expect.anything());
  });
});

describe('CampaignDraft.applyCampaign', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('duplicates as a new campaign with the stored list as its audience', () => {
    const { draft } = setup();
    draft.applyCampaign(campaign(), 'duplicate');
    expect(draft.editingId()).toBeNull();
    expect(draft.name()).toBe('Copy of Diwali offer');
    expect(draft.message()).toBe('Hi {name}, 20% off');
    expect(draft.optOutLine()).toBe(true);
    expect(draft.source()).toBe('file');
    expect(draft.validContacts()).toHaveLength(1);
    expect(draft.variables()).toEqual(['name', 'phone', 'city']);
    expect(draft.pacing()).toBe('safe');
    expect(draft.audienceReady()).toBe(true);
    // The line is not doubled on the way back out.
    expect(draft.buildCreate().body).toBe(`Hi {name}, 20% off\n\n${OPT_OUT_TEXT}`);
  });

  it('edits a scheduled campaign at its own wall-clock time', () => {
    const { draft } = setup();
    draft.applyCampaign(
      campaign({
        status: 'scheduled',
        scheduledAt: '2026-11-02T04:30:00.000Z',
        audience: { tags: ['vip'] },
      }),
      'edit',
    );
    expect(draft.editingId()).toBe(7);
    expect(draft.name()).toBe('Diwali offer');
    expect(draft.source()).toBe('contacts');
    expect(draft.contactFilter()).toEqual({ tags: ['vip'] });
    expect(draft.scheduleMode()).toBe('later');
    expect(draft.date()).toBe('2026-11-02');
    expect(draft.time()).toBe('10:00');
  });

  it('round-trips link tracking, versions and the repeat', () => {
    const { draft } = setup();
    draft.applyCampaign(
      campaign({
        status: 'scheduled',
        body: `Hi {name}\n\n${OPT_OUT_TEXT}`,
        options: {
          optOutLine: true,
          trackLinks: true,
          variants: [
            { key: 'A', body: `Hi {name}\n\n${OPT_OUT_TEXT}` },
            { key: 'B', body: `Hello {name}\n\n${OPT_OUT_TEXT}` },
          ],
          recurrence: { every: 'month', until: '2027-06-30' },
        },
      }),
      'edit',
    );
    expect(draft.message()).toBe('Hi {name}');
    expect(draft.variantB()).toBe('Hello {name}');
    expect(draft.variantC()).toBeNull();
    expect(draft.trackLinks()).toBe(true);
    expect(draft.repeatEvery()).toBe('month');
    expect(draft.repeatUntil()).toBe('2027-06-30');

    const options = draft.buildCreate().options;
    expect(options?.variants?.map((v) => v.body)).toEqual([
      `Hi {name}\n\n${OPT_OUT_TEXT}`,
      `Hello {name}\n\n${OPT_OUT_TEXT}`,
    ]);
    expect(options?.recurrence).toEqual({ every: 'month', until: '2027-06-30' });
    expect(options?.trackLinks).toBe(true);
  });

  it('starts from hand-picked contacts', () => {
    const { draft } = setup();
    draft.applyCampaign(campaign({ audience: { ids: [1, 2] } }), 'duplicate');
    expect(draft.source()).toBe('contacts');
    expect(draft.contactFilter()).toEqual({ ids: [1, 2] });
    expect(draft.audienceReady()).toBe(true);
  });

  it('refuses to edit a campaign that has started', () => {
    const { draft } = setup();
    let error = '';
    draft.prefillFrom(7, 'edit').subscribe({ error: (e: Error) => (error = e.message) });
    expect(error).toContain('duplicate it instead');
  });
});

describe('CampaignDraft autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('saves edits per tenant and user, and offers them back after a reload', () => {
    const first = setup().draft;
    first.init();
    first.message.set('Hello there');
    first.optOutLine.set(true);
    TestBed.tick();
    vi.advanceTimersByTime(600);
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').signals.message).toBe('Hello there');

    TestBed.resetTestingModule();
    const second = setup().draft;
    second.init();
    expect(second.savedDraft()?.name).toBe(first.name());
    // Nothing is overwritten while the banner waits for an answer.
    TestBed.tick();
    vi.advanceTimersByTime(600);
    expect(localStorage.getItem(KEY)).not.toBeNull();

    second.restore().subscribe();
    expect(second.savedDraft()).toBeNull();
    expect(second.message()).toBe('Hello there');
    expect(second.optOutLine()).toBe(true);
  });

  it('forgets the draft on Start fresh and once it is sent', () => {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, savedAt: 1, signals: { message: 'Old' } }));
    const { draft } = setup();
    draft.init();
    draft.discardSaved();
    expect(localStorage.getItem(KEY)).toBeNull();

    draft.message.set('New');
    TestBed.tick();
    vi.advanceTimersByTime(600);
    expect(localStorage.getItem(KEY)).not.toBeNull();
    draft.result.set({ campaign: campaign(), started: true });
    TestBed.tick();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { draft } = setup();
    expect(() => draft.init()).not.toThrow();
    draft.message.set('Still works');
    TestBed.tick();
    expect(() => vi.advanceTimersByTime(600)).not.toThrow();
    vi.restoreAllMocks();
  });
});
