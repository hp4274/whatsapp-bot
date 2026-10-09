import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { Observable } from 'rxjs';

import { Auth } from '../core/auth';
import { Store } from '../core/store';
import {
  FaqCategory, FaqInput, FaqItem, FaqMiss, KnowledgeApi, KnowledgeDashboard, MATCH_TYPES, MatchResult, MatchType, similarity,
} from './knowledge-api';

type Tab = 'questions' | 'categories' | 'test' | 'gaps';

interface Draft {
  id: number | null;
  question: string;
  answer: string;
  keywords: string;
  categoryId: number | null;
  matchType: MatchType;
  locale: string;
  isActive: boolean;
  priority: number;
  outOfHours: boolean;
  fromMissId: number | null;
}

const MATCH_HINTS: Record<MatchType, string> = {
  CONTAINS: 'Fires when the message contains the question or any keyword.',
  EXACT: 'Fires only when the whole message equals the question or a keyword.',
  SIMILARITY: 'Fires when the wording is close enough (word overlap above the threshold).',
  REGEX: 'Keywords are regular expressions, tested against the raw message.',
  FALLBACK: 'Answers anything nothing else matched. Use for one catch-all at most.',
};

@Component({
  selector: 'app-knowledge',
  imports: [FormsModule, NgTemplateOutlet],
  templateUrl: './knowledge.html',
  styleUrl: './knowledge.scss',
})
export class KnowledgeView {
  private readonly api = inject(KnowledgeApi);
  private readonly auth = inject(Auth);
  private readonly store = inject(Store);

  protected readonly matchTypes = MATCH_TYPES;
  protected readonly matchHints = MATCH_HINTS;
  protected readonly tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'questions', label: 'Questions', icon: 'quiz' },
    { id: 'categories', label: 'Categories', icon: 'folder' },
    { id: 'test', label: 'Test', icon: 'science' },
    { id: 'gaps', label: 'Gaps', icon: 'troubleshoot' },
  ];

  protected readonly canWrite = computed(() => this.auth.atLeast('admin'));

  protected readonly data = signal<KnowledgeDashboard | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly notice = signal<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  protected readonly busy = signal(false);

  protected readonly tab = signal<Tab>('questions');
  protected readonly query = signal('');
  protected readonly filter = signal<'all' | 'none' | number>('all');

  protected readonly draft = signal<Draft | null>(null);
  protected readonly formError = signal('');
  protected readonly confirmId = signal<string | null>(null);

  protected readonly newCategory = signal('');
  protected readonly renaming = signal<{ id: number; name: string } | null>(null);

  protected readonly testText = signal('');
  protected readonly ignoreHours = signal(true);
  protected readonly testing = signal(false);
  protected readonly result = signal<MatchResult | null>(null);
  protected readonly testedText = signal('');

  protected readonly categories = computed(() => this.data()?.categories ?? []);
  protected readonly items = computed(() => this.data()?.items ?? []);
  protected readonly stats = computed(() => this.data()?.stats ?? null);
  protected readonly misses = computed(() => this.data()?.misses ?? []);
  protected readonly threshold = computed(() => this.data()?.similarityThreshold ?? 0.6);
  protected readonly uncategorised = computed(() => this.items().filter((i) => i.categoryId == null).length);
  protected readonly coverage = computed(() => Math.round((this.stats()?.coverage ?? 0) * 100));

  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    const f = this.filter();
    return this.items().filter((i) => {
      if (f === 'none' && i.categoryId != null) return false;
      if (typeof f === 'number' && i.categoryId !== f) return false;
      if (!q) return true;
      return i.question.toLowerCase().includes(q) || i.answer.toLowerCase().includes(q)
        || i.keywords.some((k) => k.toLowerCase().includes(q));
    });
  });

  /** Visible items grouped by category, in category order, uncategorised last. */
  protected readonly groups = computed(() => {
    const list = this.visible();
    const out: { key: string; name: string; items: FaqItem[] }[] = [];
    for (const c of this.categories()) {
      const items = list.filter((i) => i.categoryId === c.id);
      if (items.length) out.push({ key: `c${c.id}`, name: c.name, items });
    }
    const loose = list.filter((i) => i.categoryId == null || !this.categories().some((c) => c.id === i.categoryId));
    if (loose.length) out.push({ key: 'none', name: 'Uncategorised', items: loose });
    return out;
  });

  protected readonly nearMisses = computed(() =>
    this.items().filter((i) => i.missCount > 0).sort((a, b) => b.missCount - a.missCount).slice(0, 8));

  protected readonly maxMiss = computed(() => Math.max(1, ...this.misses().map((m) => m.count)));

  /** Runner-up items for the last test, excluding the winner. */
  protected readonly candidates = computed(() => {
    const r = this.result();
    const text = this.testedText();
    if (!r || !text) return [];
    return this.items()
      .filter((i) => i.isActive && i.id !== r.match?.item.id)
      .map((item) => ({ item, score: similarity(text, item) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
  });

  constructor() {
    this.load();
    this.store.watch(['faq', 'knowledge'], () => this.load());
  }

  protected load() {
    this.loading.set(!this.data());
    this.error.set('');
    this.api.dashboard().subscribe({
      next: (d) => { this.data.set(d); this.loading.set(false); },
      error: (e: Error) => { this.error.set(e.message); this.loading.set(false); },
    });
  }

  protected categoryName(id: number | null) {
    return id == null ? '' : this.categories().find((c) => c.id === id)?.name ?? '';
  }

  protected pct(score: number) { return Math.round(score * 100); }

  protected setFilter(value: string) {
    this.filter.set(value === 'all' || value === 'none' ? value : Number(value));
  }

  // ---------------------------------------------------------------- editor --
  protected add(prefill: Partial<Draft> = {}) {
    const f = this.filter();
    this.formError.set('');
    this.tab.set('questions');
    this.draft.set({
      id: null, question: '', answer: '', keywords: '', categoryId: typeof f === 'number' ? f : null,
      matchType: 'CONTAINS', locale: '', isActive: true, priority: 0, outOfHours: false, fromMissId: null, ...prefill,
    });
    this.focusEditor();
  }

  protected edit(item: FaqItem) {
    this.formError.set('');
    this.tab.set('questions');
    this.draft.set({
      id: item.id, question: item.question, answer: item.answer, keywords: item.keywords.join(', '),
      categoryId: item.categoryId, matchType: item.matchType, locale: item.locale, isActive: item.isActive,
      priority: item.priority, outOfHours: item.outOfHours, fromMissId: null,
    });
    this.focusEditor();
  }

  protected fromMiss(miss: FaqMiss) {
    this.add({ question: miss.text, keywords: miss.text, fromMissId: miss.id });
  }

  protected patch<K extends keyof Draft>(key: K, value: Draft[K]) {
    const d = this.draft();
    if (d) this.draft.set({ ...d, [key]: value });
  }

  protected cancel() { this.draft.set(null); this.formError.set(''); }

  protected save() {
    const d = this.draft();
    if (!d || this.busy()) return;
    if (!d.question.trim()) return this.formError.set('Write the question a customer would ask.');
    if (!d.answer.trim()) return this.formError.set('Write the answer the bot should send.');
    const body: FaqInput = {
      question: d.question.trim(), answer: d.answer.trim(),
      keywords: d.keywords.split(/[,\n]/).map((k) => k.trim()).filter(Boolean),
      categoryId: d.categoryId, matchType: d.matchType, locale: d.locale.trim(),
      isActive: d.isActive, priority: Number(d.priority) || 0, outOfHours: d.outOfHours,
    };
    const req: Observable<unknown> = d.id == null ? this.api.createItem(body) : this.api.updateItem(d.id, body);
    this.busy.set(true);
    req.subscribe({
      next: () => {
        this.busy.set(false);
        this.draft.set(null);
        this.flash('ok', d.id == null ? 'Question added.' : 'Changes saved.');
        if (d.fromMissId != null) this.api.dismissMiss(d.fromMissId).subscribe({ next: () => this.load(), error: () => this.load() });
        else this.load();
      },
      error: (e: Error) => { this.busy.set(false); this.formError.set(e.message); },
    });
  }

  protected toggle(item: FaqItem) {
    this.mutate(this.api.updateItem(item.id, { isActive: !item.isActive }), item.isActive ? 'Question paused.' : 'Question live.');
  }

  protected remove(item: FaqItem) {
    this.confirmId.set(null);
    if (this.draft()?.id === item.id) this.draft.set(null);
    this.mutate(this.api.deleteItem(item.id), 'Question deleted.');
  }

  // ------------------------------------------------------------ categories --
  protected addCategory() {
    const name = this.newCategory().trim();
    if (!name) return;
    const pos = Math.max(-1, ...this.categories().map((c) => c.position)) + 1;
    this.mutate(this.api.createCategory(name, pos), `Category "${name}" added.`, () => this.newCategory.set(''));
  }

  protected saveRename() {
    const r = this.renaming();
    if (!r?.name.trim()) return;
    this.mutate(this.api.updateCategory(r.id, { name: r.name.trim() }), 'Category renamed.', () => this.renaming.set(null));
  }

  protected setRename(name: string) {
    const r = this.renaming();
    if (r) this.renaming.set({ ...r, name });
  }

  protected move(index: number, delta: number) {
    const list = [...this.categories()];
    const other = list[index + delta];
    const self = list[index];
    if (!self || !other || this.busy()) return;
    // Rewrite positions densely so equal positions can never tie.
    list[index] = other;
    list[index + delta] = self;
    const writes = list.map((c, i) => ({ c, i })).filter(({ c, i }) => c.position !== i);
    this.busy.set(true);
    let left = writes.length;
    if (!left) return this.busy.set(false);
    for (const { c, i } of writes) {
      this.api.updateCategory(c.id, { position: i }).subscribe({
        next: () => { if (--left === 0) { this.busy.set(false); this.load(); } },
        error: (e: Error) => { this.busy.set(false); this.flash('bad', e.message); this.load(); left = -1; },
      });
    }
  }

  protected removeCategory(c: FaqCategory) {
    this.confirmId.set(null);
    if (this.filter() === c.id) this.filter.set('all');
    this.mutate(this.api.deleteCategory(c.id), `Category deleted. Its questions are now uncategorised.`);
  }

  // ------------------------------------------------------------------ test --
  protected runTest() {
    const text = this.testText().trim();
    if (!text || this.testing()) return;
    this.testing.set(true);
    this.api.match(text, this.ignoreHours()).subscribe({
      next: (r) => { this.result.set(r); this.testedText.set(text); this.testing.set(false); },
      error: (e: Error) => { this.testing.set(false); this.flash('bad', e.message); },
    });
  }

  protected tryPhrase(text: string) {
    this.testText.set(text);
    this.tab.set('test');
    this.runTest();
  }

  // ------------------------------------------------------------------ gaps --
  protected dismiss(miss: FaqMiss) {
    this.mutate(this.api.dismissMiss(miss.id), 'Dismissed.');
  }

  // --------------------------------------------------------------- helpers --
  private mutate(req: Observable<unknown>, success: string, after?: () => void) {
    if (this.busy()) return;
    this.busy.set(true);
    req.subscribe({
      next: () => { this.busy.set(false); after?.(); this.flash('ok', success); this.load(); },
      error: (e: Error) => { this.busy.set(false); this.flash('bad', e.message); },
    });
  }

  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private flash(tone: 'ok' | 'bad', text: string) {
    clearTimeout(this.flashTimer);
    this.notice.set({ tone, text });
    this.flashTimer = setTimeout(() => this.notice.set(null), tone === 'ok' ? 3200 : 7000);
  }

  private focusEditor() {
    setTimeout(() => document.getElementById('kb-question')?.focus({ preventScroll: false }), 0);
  }

  // ------------------------------------------------------------ hero tilt --
  protected tilt(e: PointerEvent) {
    if (e.pointerType === 'touch' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--px', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
    el.style.setProperty('--py', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  }

  protected untilt(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.style.removeProperty('--px');
    el.style.removeProperty('--py');
  }
}
