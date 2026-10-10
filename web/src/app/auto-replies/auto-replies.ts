import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import {
  ArToasts,
  AutoRepliesApi,
  AutoReplyRule,
  AutoReplySettings,
  SystemStats,
} from './auto-replies.api';
import { RuleDraft, RuleEditor, emptyDraft, toPayload } from './rule-editor';
import { RuleList } from './rule-list';
import { SystemCards } from './system-cards';
import { TestConsole } from './test-console';

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
  imports: [SystemCards, RuleList, RuleEditor, TestConsole],
  templateUrl: './auto-replies.html',
  styleUrl: './auto-replies.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutoRepliesView {
  private readonly api = inject(AutoRepliesApi);
  protected readonly toasts = inject(ArToasts);

  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly rules = signal<AutoReplyRule[]>([]);
  protected readonly settings = signal<AutoReplySettings | null>(null);
  protected readonly sysStats = signal<SystemStats | null>(null);
  /** Opt-out words set by the platform: shown locked, never editable here. */
  protected readonly platformWords = signal<string[]>([]);
  protected readonly planValues = signal<Record<string, unknown>>({});
  protected readonly draft = signal<RuleDraft | null>(null);
  /** JSON of the draft as last loaded or saved; `dirty` compares against it. */
  protected readonly baseline = signal('');
  protected readonly saving = signal(false);
  /** A rule (or 'new') the user tried to open while the current draft had unsaved edits. */
  protected readonly pending = signal<AutoReplyRule | 'new' | null>(null);

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
  protected request(target: AutoReplyRule | 'new'): void {
    if (target !== 'new' && target.id === this.selectedId()) return;
    if (this.dirty()) {
      this.pending.set(target);
      return;
    }
    this.open(target);
  }

  protected open(target: AutoReplyRule | 'new'): void {
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
