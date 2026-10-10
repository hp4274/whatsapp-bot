import { renderTemplate } from './auto-replies.api';
import { emptyDraft, toPayload } from './rule-editor';

describe('auto-replies helpers', () => {
  it('renders variables, fallbacks and unknown fields', () => {
    const at = new Date(2026, 0, 5, 9, 0);
    const out = renderTemplate(
      '{time_greeting} {first_name}, {city|friend} from {business_name}',
      {
        name: 'Aarav Sharma',
        phone: '91',
        businessName: 'Acme',
      },
      at,
    );
    expect(out).toBe('Good morning Aarav, friend from Acme');
  });

  it('keeps legacy fields in step and prunes follow-ups for removed options', () => {
    const d = emptyDraft();
    d.keywords = ['menu', 'help'];
    d.variants = ['  first ', '', 'second'];
    d.interactive = { type: 'buttons', buttons: [{ id: 'A', title: 'A' }] };
    d.menu = { A: { replyBody: 'a' }, GONE: { replyBody: 'x' } };
    const p = toPayload(d);
    expect(p.keyword).toBe('menu');
    expect(p.replyBody).toBe('first');
    expect(p.variants).toEqual(['first', 'second']);
    expect(Object.keys(p.menu)).toEqual(['A']);
    expect(p.name).toBe('menu');
  });
});
