import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { concatMap, forkJoin, from, of, toArray } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { ActivityLog } from './activity-log';
import {
  ArToasts,
  AutoRepliesApi,
  AutoReplyRule,
  AutoReplySettings,
  Intent,
  Language,
  SystemStats,
} from './auto-replies.api';
import { RuleDraft, RuleEditor, emptyDraft, toPayload } from './rule-editor';
import { RuleList } from './rule-list';
import { RuleTemplate, hasPlaceholder } from './rule-templates';
import { ReportPanel } from './report';
import { SystemCards } from './system-cards';
import { TestConsole } from './test-console';

type TabId = 'basics' | 'rules' | 'report' | 'test' | 'log';

/**
 * One section at a time instead of one long page: most owners only ever need Basics, so keyword rules, the
 * sandbox and the log wait behind their own tabs. Each tab says in one line what it is for.
 * Orders and bookings (shop.ts) are not here: they open as their own feature (SOON_SERVICES in admin/service-meta.ts).
 */
const TABS: readonly { id: TabId; label: string; icon: string; lede: string }[] = [
  { id: 'basics', label: 'Basics', icon: 'bolt', lede: 'Welcome new customers, reply when you are closed, and hand a chat to a person when they ask.' },
  { id: 'rules', label: 'Keyword replies', icon: 'list-details', lede: 'Answer words like "price" or "location" with your own reply. Start from a ready-made set.' },
  { id: 'report', label: 'Reports', icon: 'chart-bar', lede: 'What customers ask most, what the bot answers, what it misses, and where people stop part-way.' },
  { id: 'test', label: 'Try it', icon: 'flask', lede: 'Type a message as a customer would and see exactly what goes back. Nothing is sent.' },
  { id: 'log', label: 'Activity', icon: 'history', lede: 'What the bot did with each message it got, and why it stayed quiet when it did.' },
];

/** Fill anything an older server row may lack, so the editor never sees undefined. */
function toDraft(r: AutoReplyRule): RuleDraft {
  return structuredClone({
    id: r.id,
    name: r.name ?? '',
    matchType: r.matchType,
    keyword: r.keyword ?? '',
    keywords: r.keywords?.length ? r.keywords : r.keyword ? [r.keyword] : [],
    replyBody: r.replyBody ?? '',
    variants: r.variants?.length ? r.variants : [r.replyBody ?? ''],
    media: r.media ?? null,
    interactive: r.interactive ?? null,
    menu: r.menu ?? {},
    schedule: r.schedule ?? null,
    audience: r.audience ?? { type: 'all' },
    actions: { ...r.actions, stop: r.actions?.stop ?? true },
    synonyms: r.synonyms ?? false,
    typos: r.typos ?? true,
    translations: r.translations ?? {},
    collect: r.collect ?? null,
    isActive: r.isActive,
  });
}

/**
 * The auto-reply workspace: built-in system replies, the priority-ordered
 * keyword rules with their editor, and a sandbox to try messages against both.
 *
 * The editor works on a draft compared to a JSON baseline, so switching rules
 * with unsaved edits asks first instead of silently dropping them. Toggles and
 * reorders are optimistic and roll back if the server refuses.
 */
@Component({
  selector: 'app-auto-replies',
  imports: [SystemCards, RuleList, RuleEditor, TestConsole, ActivityLog, ReportPanel],
  templateUrl: './auto-replies.html',
  styleUrl: './auto-replies.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutoRepliesView {
  private readonly api = inject(AutoRepliesApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly toasts = inject(ArToasts);

  protected readonly tabs = TABS;
  /** The open tab lives in the URL (?tab=shop), so a link or Back lands on the same one. */
  protected readonly tab = toSignal(
    this.route.queryParamMap.pipe(
      map((q) => (TABS.find((t) => t.id === q.get('tab'))?.id ?? 'basics') as TabId),
    ),
    { initialValue: 'basics' as TabId },
  );
  protected readonly lede = computed(() => TABS.find((t) => t.id === this.tab())?.lede ?? '');

  /** On a phone the tab row scrolls sideways: keep the open tab in sight, or a link to Activity lands on a row showing Basics. */
  private readonly tabNav = viewChild<ElementRef<HTMLElement>>('tabNav');
  private readonly keepTabInView = afterRenderEffect(() => {
    const nav = this.tabNav()?.nativeElement;
    const on = nav?.querySelector<HTMLElement>('#tab-' + this.tab());
    if (!nav || !on || nav.scrollWidth <= nav.clientWidth) return;
    const offset = on.getBoundingClientRect().left - nav.getBoundingClientRect().left;
    nav.scrollTo({ left: nav.scrollLeft + offset - (nav.clientWidth - on.offsetWidth) / 2, behavior: 'smooth' });
  });

  /** "Add a reply" in Reports: a new keyword rule for what nothing answered, opened on the Keyword replies tab. */
  protected answerFromReport(text: string): void {
    const keyword = text.trim().slice(0, 60);
    this.request({
      key: 'from-report',
      title: keyword,
      blurb: '',
      icon: 'message-question',
      draft: { name: keyword, matchType: 'ANY_OF', keywords: [keyword], replyBody: '', variants: [''] },
    });
    this.go('rules');
  }

  protected go(tab: TabId): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { tab }, queryParamsHandling: 'merge' });
  }

  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly rules = signal<AutoReplyRule[]>([]);
  protected readonly settings = signal<AutoReplySettings | null>(null);
  protected readonly sysStats = signal<SystemStats | null>(null);
  /** Opt-out words set by the platform: shown locked, never editable here. */
  protected readonly platformWords = signal<string[]>([]);
  /** What the editors offer, from the server: built-in intents and reply languages. */
  protected readonly intents = signal<Intent[]>([]);
  protected readonly languages = signal<Language[]>([]);
  protected readonly messageTypes = signal<string[]>([]);
  protected readonly planValues = signal<Record<string, unknown>>({});
  protected readonly draft = signal<RuleDraft | null>(null);
  /** JSON of the draft as last loaded or saved; `dirty` compares against it. */
  protected readonly baseline = signal('');
  protected readonly saving = signal(false);
  /** A rule (or 'new') the user tried to open while the current draft had unsaved edits. */
  protected readonly pending = signal<AutoReplyRule | RuleTemplate | 'new' | null>(null);

  protected readonly selectedId = computed(() => this.draft()?.id ?? null);
  protected readonly dirty = computed(
    () => !!this.draft() && JSON.stringify(this.draft()) !== this.baseline(),
  );
  protected readonly selectedStats = computed(
    () => this.rules().find((r) => r.id === this.selectedId())?.stats ?? null,
  );
  protected readonly businessName = computed(
    () => this.settings()?.businessName || 'Your business',
  );

  /** Plain-sentence notices for what the plan blocks, so a refused save is no surprise. */
  protected readonly planNotices = computed(() => {
    const v = this.planValues();
    const max = Number(v['autoReplies.maxRules'] ?? 0);
    const notes: string[] = [];
    if (max > 0 && this.rules().length >= max) {
      notes.push(`Your plan allows ${max} rule${max === 1 ? '' : 's'} and you have reached the limit.`);
    }
    if (v['autoReplies.allowKeywords'] === false) notes.push('Keyword rules are not included in your plan, so they will not reply.');
    if (v['autoReplies.allowMenus'] === false) notes.push('Menus are not included in your plan, so they will not reply.');
    const off: [string, string][] = [
      ['autoReplies.allowIntents', 'Intent rules and synonyms'],
      ['autoReplies.allowMessageTypes', 'Message-type rules'],
      ['autoReplies.allowQuestions', 'Rules that ask questions'],
      ['autoReplies.allowTranslations', 'Replies in other languages'],
    ];
    for (const [key, what] of off) {
      if (v[key] === false) notes.push(`${what} are not included in your plan, so they will not reply.`);
    }
    if (this.settings()?.enabled === false) notes.push('Auto replies are switched off: only STOP is answered. Switch them on under Settings.');
    return notes;
  });

  /** Header counts: rule hits plus the four system replies' hits. */
  protected readonly kpis = computed(() => {
    const rules = this.rules();
    const sys = Object.values(this.sysStats() ?? {});
    return {
      active: rules.filter((r) => r.isActive).length,
      today:
        rules.reduce((n, r) => n + (r.stats?.today ?? 0), 0) +
        sys.reduce((n, s) => n + (s?.today ?? 0), 0),
      week:
        rules.reduce((n, r) => n + (r.stats?.week ?? 0), 0) +
        sys.reduce((n, s) => n + (s?.week ?? 0), 0),
    };
  });

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set('');
    forkJoin({
      list: this.api.list(),
      cfg: this.api.settings(),
      // Notices are a nicety: a failed policy read must not hide the page.
      plan: this.api.policy().pipe(catchError(() => of({ values: {} }))),
    }).subscribe({
      next: ({ list, cfg, plan }) => {
        this.rules.set(list.rules);
        this.platformWords.set(list.platformOptOutWords ?? []);
        this.intents.set(list.intents ?? []);
        this.languages.set(list.languages ?? []);
        this.messageTypes.set(list.messageTypes ?? []);
        this.planValues.set(plan.values);
        this.settings.set(cfg.settings);
        this.sysStats.set(cfg.stats);
        this.loading.set(false);
        if (!this.draft() && list.rules.length) this.open(list.rules[0]);
      },
      error: (err: Error) => {
        this.loadError.set(err.message);
        this.loading.set(false);
      },
    });
  }

  // Selection ---------------------------------------------------------------
  protected request(target: AutoReplyRule | RuleTemplate | 'new'): void {
    this.revealEditor();
    if (target !== 'new' && 'id' in target && target.id === this.selectedId()) return;
    if (this.dirty()) {
      this.pending.set(target);
      return;
    }
    this.open(target);
  }

  private readonly injector = inject(Injector);
  private readonly editPane = viewChild<ElementRef<HTMLElement>>('editPane');
  /** Below 1000px the editor sits under the list: bring it (or the unsaved-changes prompt) into view, or a tap seems to do nothing. */
  private revealEditor(): void {
    if (!matchMedia('(max-width: 999px)').matches) return;
    afterNextRender(() => this.editPane()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' }), { injector: this.injector });
  }

  protected open(target: AutoReplyRule | RuleTemplate | 'new'): void {
    if (target !== 'new' && 'draft' in target) {
      // A template opens filled in but unsaved: the baseline is a blank rule, so leaving asks first.
      this.draft.set(structuredClone({ ...emptyDraft(), ...target.draft, id: null }));
      this.baseline.set(JSON.stringify(emptyDraft()));
      this.pending.set(null);
      return;
    }
    const d = target === 'new' ? emptyDraft() : toDraft(target);
    this.draft.set(d);
    this.baseline.set(JSON.stringify(d));
    this.pending.set(null);
  }

  protected discardPending(): void {
    const p = this.pending();
    if (p) this.open(p);
  }

  protected cancelNew(): void {
    const first = this.rules()[0];
    if (first) this.open(first);
    else this.draft.set(null);
  }

  // Persistence -------------------------------------------------------------
  protected readonly addingSet = signal(false);

  /**
   * Save a set's rules one after another, in its order (specific rules first, so they run first). A rule still
   * holding a [placeholder] starts switched off, so no "[your address]" reaches a customer.
   */
  protected addTemplates(templates: readonly RuleTemplate[]): void {
    if (!templates.length || this.addingSet()) return;
    this.addingSet.set(true);
    from(templates)
      .pipe(
        concatMap((t) =>
          this.api.create(toPayload({ ...emptyDraft(), ...t.draft, id: null, isActive: !hasPlaceholder(t) })),
        ),
        toArray(),
      )
      .subscribe({
        next: (created) => {
          const rules = created.map((c) => c.rule);
          this.rules.update((list) => [...list, ...rules]);
          this.addingSet.set(false);
          const off = rules.filter((r) => !r.isActive).length;
          this.toasts.ok(
            `${rules.length} rule${rules.length === 1 ? '' : 's'} added` +
              (off ? `. ${off} start switched off: fill in your [details], then switch them on.` : '.'),
          );
          const firstOff = rules.find((r) => !r.isActive);
          if (firstOff && !this.dirty()) this.open(firstOff);
        },
        error: (err) => {
          this.addingSet.set(false);
          this.toasts.error(err);
          this.load();
        },
      });
  }

  protected save(): void {
    const d = this.draft();
    if (!d || this.saving()) return;
    this.saving.set(true);
    const payload = toPayload(d);
    const req = d.id === null ? this.api.create(payload) : this.api.update(d.id, payload);
    req.subscribe({
      next: ({ rule }) => {
        this.rules.update((list) =>
          d.id === null ? [...list, rule] : list.map((r) => (r.id === rule.id ? rule : r)),
        );
        this.open(rule);
        this.saving.set(false);
        this.toasts.ok(d.id === null ? 'Rule created' : 'Rule saved');
      },
      error: (err) => {
        this.saving.set(false);
        this.toasts.error(err);
      },
    });
  }

  protected remove(): void {
    const id = this.selectedId();
    if (id === null) return;
    this.api.remove(id).subscribe({
      next: () => {
        this.rules.update((list) => list.filter((r) => r.id !== id));
        this.cancelNew();
        this.toasts.ok('Rule deleted');
      },
      error: (err) => this.toasts.error(err),
    });
  }

  protected toggle({ rule, active }: { rule: AutoReplyRule; active: boolean }): void {
    const flip = (v: boolean) =>
      this.rules.update((list) => list.map((r) => (r.id === rule.id ? { ...r, isActive: v } : r)));
    flip(active);
    const d = this.draft();
    if (d?.id === rule.id) {
      this.draft.set({ ...d, isActive: active });
      this.baseline.set(JSON.stringify({ ...JSON.parse(this.baseline()), isActive: active }));
    }
    this.api.update(rule.id, { isActive: active }).subscribe({
      next: () => this.toasts.ok(`${rule.name} ${active ? 'activated' : 'paused'}`),
      error: (err) => {
        flip(!active);
        this.toasts.error(err);
      },
    });
  }

  protected reorder(ids: number[]): void {
    const before = this.rules();
    const byId = new Map(before.map((r) => [r.id, r]));
    this.rules.set(ids.map((id) => byId.get(id)).filter((r): r is AutoReplyRule => !!r));
    this.api.reorder(ids).subscribe({
      next: ({ rules }) => this.rules.set(rules),
      error: (err) => {
        this.rules.set(before);
        this.toasts.error(err);
      },
    });
  }

  protected setDraft(d: RuleDraft): void {
    this.draft.set(d);
  }
}
