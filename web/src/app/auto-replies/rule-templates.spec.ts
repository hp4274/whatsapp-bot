import { validateInteractive } from '../campaign/interactive/interactive.model';
import { RULE_PACKS, RULE_TEMPLATES, hasPlaceholder, packRules, templatesFor } from './rule-templates';
import { typoExamples } from './rule-editor';

describe('rule templates', () => {
  it('each one is a rule the editor would save', () => {
    const keys = new Set<string>();
    for (const t of RULE_TEMPLATES) {
      expect(keys.has(t.key)).toBe(false);
      keys.add(t.key);
      expect(t.draft.keywords?.length).toBeGreaterThan(0);
      expect(t.draft.variants?.[0]?.trim()).toBeTruthy();
      expect(validateInteractive(t.draft.interactive)).toEqual([]);
      for (const q of t.draft.collect?.questions ?? []) expect(q.key && q.question).toBeTruthy();
    }
  });

  it('leaves out what the plan does not include', () => {
    const all = templatesFor({});
    const noQuestions = templatesFor({ 'autoReplies.allowQuestions': false });
    expect(all.length).toBe(RULE_TEMPLATES.length);
    expect(noQuestions.some((t) => t.draft.collect)).toBe(false);
    expect(noQuestions.length).toBeLessThan(all.length);
  });

  it('every set names real rules; placeholders are spotted', () => {
    const keys = new Set(RULE_TEMPLATES.map((t) => t.key));
    for (const p of RULE_PACKS) for (const k of p.rules) expect(keys.has(k)).toBe(true);
    expect(packRules(RULE_PACKS[0], {}).length).toBe(RULE_PACKS[0].rules.length);
    expect(hasPlaceholder(RULE_TEMPLATES.find((t) => t.key === 'location')!)).toBe(true);
    expect(hasPlaceholder(RULE_TEMPLATES.find((t) => t.key === 'order-status')!)).toBe(false);
  });

  it('shows typos the matcher forgives, never changing the first letter', () => {
    const t = typoExamples('price');
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((w) => w[0] === 'p' && w !== 'price')).toBe(true);
    expect(typoExamples('call me')).toEqual([]);
  });
});
