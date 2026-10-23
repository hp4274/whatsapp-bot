import { linkify } from '../campaign/wa-format';
import { previewHtml } from './templates-api';

describe('template preview helpers', () => {
  it('marks filled variables and flags unfilled ones', () => {
    const r = previewHtml('Hi {name}, order *{id}* {x|soon}', { name: 'Asha' });
    expect(r.html).toBe(
      'Hi <mark class="var">Asha</mark>, order <b><mark class="missing">{id}</mark></b> <mark class="var">soon</mark>',
    );
    expect(r.text).toBe('Hi Asha, order *{id}* soon');
    expect(r.missing).toEqual(['id']);
  });

  it('escapes sample values', () => {
    expect(previewHtml('{a}', { a: '<b>x</b>' }).html).toBe(
      '<mark class="var">&lt;b&gt;x&lt;/b&gt;</mark>',
    );
  });

  it('styles links and leaves trailing punctuation outside', () => {
    expect(linkify('see https://x.com/a?b=1&amp;c=2.')).toBe(
      'see <span class="link">https://x.com/a?b=1&amp;c=2</span>.',
    );
    expect(linkify('go www.x.com<br>')).toBe('go <span class="link">www.x.com</span><br>');
  });
});
