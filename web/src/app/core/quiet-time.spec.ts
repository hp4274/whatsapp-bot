import {
  type QuietSlot,
  describeMinute,
  describeWindow,
  quietSlots,
  snapToStep,
  tipPlacement,
  windowSpeech,
} from './quiet-time';

describe('quiet-time tooltip helpers', () => {
  const at = (h: number, m = 0): number => new Date(2026, 0, 5, h, m).getTime();
  const windows = [
    { startAt: at(11, 39), endAt: at(14, 23) },
    { startAt: at(17, 11), endAt: at(18, 0) },
  ];
  const slotsAt = (now: number): QuietSlot[] => quietSlots(windows, now);

  it('describes a minute inside a window against the clock, not the cursor', () => {
    const now = at(13, 11);
    const tip = describeMinute(at(12, 0), slotsAt(now), now);
    expect(tip.time).toBe('12:00');
    expect(tip.title).toBe('Quiet time · 11:39–14:23 · 2h 44m');
    expect(tip.note).toBe('ends in 1h 12m');
    expect(describeMinute(now, slotsAt(now), now).time).toBe('Now');
  });

  it('describes the gaps: next, since, and nothing left', () => {
    const now = at(13, 11);
    expect(describeMinute(at(15, 0), slotsAt(now), now).note).toBe('next quiet time 17:11 · in 4h');
    expect(describeMinute(at(19, 0), slotsAt(now), now).note).toBe('no more quiet time today');
    const later = at(16, 0);
    expect(describeMinute(at(14, 40), slotsAt(later), later).note).toBe('since 14:23');
    expect(describeMinute(at(14, 40), slotsAt(later), later).title).toBe('Sending');
  });

  it('describes a window on its own: past, resting, ahead', () => {
    const now = at(15, 0);
    const [done, next] = slotsAt(now);
    expect(describeWindow(done, now).note).toBe('ended 37m ago');
    expect(describeWindow(next, now).note).toBe('starts in 2h 11m · ends in 3h');
    expect(windowSpeech(done)).toBe('Quiet time 11:39 to 14:23, 2 hours 44 minutes');
  });

  it('snaps to 5 minutes of the local day', () => {
    expect(snapToStep(at(11, 42), at(0))).toBe(at(11, 40));
  });

  it('places a tooltip inside the strip, flipping at the edges', () => {
    expect(tipPlacement(300, 200, 12, 600)).toMatchObject({ left: 200, width: 200, origin: 100 });
    const left = tipPlacement(20, 200, 12, 600);
    expect(left.left).toBe(30);
    const right = tipPlacement(590, 200, 12, 600);
    expect(right.left + right.width).toBeLessThanOrEqual(600);
    expect(right.left).toBe(380);
    const narrow = tipPlacement(50, 236, 12, 150);
    expect(narrow).toMatchObject({ left: 12, width: 138 });
  });
});
