import { clampPage, pageOf } from './pager';

describe('pageOf', () => {
  const items = Array.from({ length: 45 }, (_, i) => i);

  it('slices one page', () => {
    expect(pageOf(items, 0, 20)).toEqual(items.slice(0, 20));
    expect(pageOf(items, 2, 20)).toEqual([40, 41, 42, 43, 44]);
  });

  it('clamps a page the list no longer has, so a shrunk list never shows an empty page', () => {
    expect(clampPage(9, 45, 20)).toBe(2);
    expect(pageOf(items, 9, 20)).toEqual([40, 41, 42, 43, 44]);
    expect(clampPage(-1, 45, 20)).toBe(0);
    expect(pageOf([], 3, 20)).toEqual([]);
  });
});
