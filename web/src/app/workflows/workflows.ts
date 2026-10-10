import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Store } from '../core/store';
import { Tilt } from '../school/tilt';
import {
  ApiError,
  Recipe,
  RunStep,
  RunStatus,
  Workflow,
  WorkflowRun,
  WorkflowStatus,
  WorkflowStep,
  WorkflowsApi,
} from './workflows-api';

/** `mine` lists installed workflows; `gallery` is the recipe catalogue they come from. */
type Tab = 'mine' | 'gallery';
type Filter = WorkflowStatus | null;

/** Tabler icon per trigger family (the part of the event name before the dot). */
const TRIGGER_ICONS: Record<string, string> = {
  appointment: 'calendar-event',
  order: 'shopping-cart',
  payment: 'cash',
  lead: 'user-search',
  subscription: 'refresh',
  event: 'confetti',
  student: 'school',
  attendance: 'checklist',
  homework: 'book-2',
  exam_result: 'crown',
  fee: 'receipt',
  message: 'message',
  contact: 'address-book',
  ticket: 'ticket',
  timetable: 'calendar-week',
  notice: 'speakerphone',
};
/** Tabler icon per step action. */
const ACTION_ICONS: Record<string, string> = {
  send_template: 'file-text',
  send_message: 'send',
  wait: 'hourglass-high',
  condition: 'list-details',
  branch: 'arrows-split',
  add_tag: 'tag',
  remove_tag: 'tag-off',
  update_contact: 'user',
  create_ticket: 'ticket',
  assign_agent: 'headset',
  webhook: 'webhook',
  stop_workflow: 'player-stop',
  start_workflow: 'player-play',
};

/**
 * Workflows the tenant runs, plus the recipe gallery they install from.
 *
 * Each row expands in place to show its flow and recent runs, so an operator
 * can find out why a message did or did not go out without leaving the list.
 * Store-driven refreshes are quiet (no skeleton) to avoid the list flickering
 * while runs are being written.
 */
@Component({
  selector: 'app-workflows',
  imports: [FormsModule, Tilt],
  templateUrl: './workflows.html',
  styleUrl: './workflows.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowsView {
  private readonly api = inject(WorkflowsApi);
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly tab = signal<Tab>('mine');
  protected readonly filters: Filter[] = [null, 'active', 'paused', 'draft'];
  protected readonly filter = signal<Filter>(null);

  protected readonly workflows = signal<Workflow[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly disabled = signal(false);
  protected readonly busy = signal<number | null>(null);
  protected readonly confirmId = signal<number | null>(null);
  protected readonly rowError = signal<{ id: number; msg: string } | null>(null);
  protected readonly highlightId = signal<number | null>(null);
  protected readonly toast = signal('');

  protected readonly expanded = signal<number | null>(null);
  protected readonly runs = signal<WorkflowRun[]>([]);
  protected readonly runsLoading = signal(false);
  protected readonly runsError = signal('');
  protected readonly openRun = signal<{ run: WorkflowRun; steps: RunStep[] } | null>(null);
  protected readonly runLoading = signal<string | null>(null);
  protected readonly retrying = signal<string | null>(null);

  protected readonly recipes = signal<Recipe[]>([]);
  protected readonly recipesLoading = signal(false);
  protected readonly recipesError = signal('');
  protected readonly installKey = signal<string | null>(null);
  protected readonly installing = signal(false);
  protected readonly installError = signal('');
  protected installName = '';
  protected installActivate = false;

  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly counts = computed(() => {
    const out: Record<string, number> = { all: 0, active: 0, paused: 0, draft: 0 };
    for (const w of this.workflows()) {
      out['all'] += 1;
      out[w.status] = (out[w.status] ?? 0) + 1;
    }
    return out;
  });

  protected readonly visible = computed(() => {
    const f = this.filter();
    return f ? this.workflows().filter((w) => w.status === f) : this.workflows();
  });

  protected readonly groups = computed(() => {
    const map = new Map<string, Recipe[]>();
    for (const r of this.recipes()) {
      const key = r.industry || 'General';
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return [...map.entries()].map(([industry, items]) => ({ industry, items }));
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.toastTimer) clearTimeout(this.toastTimer);
    });
    this.load();
    this.store.watch(['workflows', 'workflow-runs', 'recipes', 'objects'], () => {
      this.load(true);
      const id = this.expanded();
      if (id != null) this.loadRuns(id, true);
      if (this.recipes().length) this.loadRecipes(true);
    });
  }

  // ------------------------------------------------------------- tabs --
  protected select(tab: Tab): void {
    this.tab.set(tab);
    if (tab === 'gallery' && !this.recipes().length && !this.recipesLoading()) this.loadRecipes();
  }

  protected tabKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: Tab = this.tab() === 'mine' ? 'gallery' : 'mine';
    this.select(next);
    document.getElementById(`wf-tab-${next}`)?.focus();
  }

  // -------------------------------------------------------- workflows --
  protected load(quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.error.set('');
    this.api.list().subscribe({
      next: ({ workflows }) => {
        this.workflows.set(workflows);
        this.loading.set(false);
      },
      error: (err: ApiError) => {
        this.disabled.set(err.status === 403);
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected setStatus(w: Workflow, status: WorkflowStatus): void {
    this.busy.set(w.id);
    this.rowError.set(null);
    this.api.setStatus(w.id, status).subscribe({
      next: ({ workflow }) => {
        this.replace(workflow);
        this.busy.set(null);
        this.flash(status === 'active' ? `${w.name} is active.` : `${w.name} is paused.`);
      },
      error: (err: ApiError) => {
        this.busy.set(null);
        this.rowError.set({ id: w.id, msg: err.message });
      },
    });
  }

  protected remove(w: Workflow): void {
    this.busy.set(w.id);
    this.api.remove(w.id).subscribe({
      next: () => {
        this.workflows.update((list) => list.filter((x) => x.id !== w.id));
        this.busy.set(null);
        this.confirmId.set(null);
        if (this.expanded() === w.id) this.expanded.set(null);
        this.flash(`${w.name} deleted.`);
      },
      error: (err: ApiError) => {
        this.busy.set(null);
        this.confirmId.set(null);
        this.rowError.set({ id: w.id, msg: err.message });
      },
    });
  }

  protected toggle(w: Workflow): void {
    if (this.expanded() === w.id) {
      this.expanded.set(null);
      return;
    }
    this.expanded.set(w.id);
    this.openRun.set(null);
    this.loadRuns(w.id);
  }

  // ------------------------------------------------------------- runs --
  protected loadRuns(id: number, quiet = false): void {
    if (!quiet) {
      this.runsLoading.set(true);
      this.runsError.set('');
      this.runs.set([]);
    }
    this.api.runs(id).subscribe({
      next: ({ runs }) => {
        if (this.expanded() === id) this.runs.set(runs);
        this.runsLoading.set(false);
      },
      error: (err: ApiError) => {
        this.runsError.set(err.message);
        this.runsLoading.set(false);
      },
    });
  }

  protected showRun(r: WorkflowRun): void {
    if (this.openRun()?.run.runId === r.runId) {
      this.openRun.set(null);
      return;
    }
    this.runLoading.set(r.runId);
    this.api.run(r.runId).subscribe({
      next: (detail) => {
        this.openRun.set(detail);
        this.runLoading.set(null);
      },
      error: (err: ApiError) => {
        this.runsError.set(err.message);
        this.runLoading.set(null);
      },
    });
  }

  protected retry(r: WorkflowRun): void {
    this.retrying.set(r.runId);
    this.api.retry(r.runId).subscribe({
      next: ({ run }) => {
        this.runs.update((list) => list.map((x) => (x.runId === run.runId ? run : x)));
        this.retrying.set(null);
        this.flash('Run restarted.');
      },
      error: (err: ApiError) => {
        this.runsError.set(err.message);
        this.retrying.set(null);
      },
    });
  }

  // ---------------------------------------------------------- recipes --
  protected loadRecipes(quiet = false): void {
    if (!quiet) this.recipesLoading.set(true);
    this.recipesError.set('');
    this.api.recipes().subscribe({
      next: ({ recipes }) => {
        this.recipes.set(recipes);
        this.recipesLoading.set(false);
      },
      error: (err: ApiError) => {
        this.disabled.set(err.status === 403);
        this.recipesError.set(err.message);
        this.recipesLoading.set(false);
      },
    });
  }

  protected openInstall(r: Recipe): void {
    this.installKey.set(r.key);
    this.installName = '';
    this.installActivate = false;
    this.installError.set('');
  }

  protected install(r: Recipe): void {
    if (this.installing()) return;
    this.installing.set(true);
    this.installError.set('');
    const name = this.installName.trim();
    this.api
      .install(r.key, {
        ...(name ? { name } : {}),
        status: this.installActivate ? 'active' : 'draft',
      })
      .subscribe({
        next: ({ workflow, templates }) => {
          this.installing.set(false);
          this.installKey.set(null);
          this.workflows.update((list) => [workflow, ...list.filter((w) => w.id !== workflow.id)]);
          this.filter.set(null);
          this.tab.set('mine');
          this.highlightId.set(workflow.id);
          setTimeout(() => this.highlightId.set(null), 2400);
          const made = templates.length
            ? ` and ${templates.length} template${templates.length === 1 ? '' : 's'}`
            : '';
          this.flash(
            `Installed ${workflow.name}${made}${workflow.status === 'active' ? '' : ' as a draft. Activate it when ready'}.`,
          );
        },
        error: (err: ApiError) => {
          this.installing.set(false);
          this.installError.set(err.message);
        },
      });
  }

  // ---------------------------------------------------------- display --
  protected humanize(value: string | null | undefined): string {
    const text = String(value ?? '')
      .replace(/[._]+/g, ' ')
      .trim();
    return text ? text[0].toUpperCase() + text.slice(1) : '';
  }

  protected triggerIcon(type: string): string {
    return TRIGGER_ICONS[String(type).split('.')[0]] ?? 'bolt';
  }

  protected actionIcon(action: string): string {
    return ACTION_ICONS[action] ?? 'settings';
  }

  /** One line about what a step does, from its params. */
  protected stepDetail(s: WorkflowStep): string {
    const p = s.params ?? {};
    if (s.action === 'wait') {
      const parts: string[] = [];
      if (p['until']) parts.push(`until ${String(p['until']).replace(/^event\.data\./, '')}`);
      for (const unit of ['days', 'hours', 'minutes', 'seconds']) {
        const n = Number(p[unit]);
        if (n) parts.push(`${n > 0 ? '+' : ''}${n} ${unit}`);
      }
      return parts.join(' ');
    }
    if (p['template']) return `Template: ${String(p['template'])}`;
    if (p['text']) return String(p['text']).slice(0, 80);
    if (Array.isArray(p['tags'])) return (p['tags'] as unknown[]).join(', ');
    if (p['url']) return String(p['url']);
    if (p['subject']) return String(p['subject']);
    return '';
  }

  protected runTone(status: RunStatus | string): string {
    if (status === 'completed' || status === 'succeeded' || status === 'done') return 'ok';
    if (status === 'failed') return 'bad';
    if (status === 'waiting' || status === 'running') return 'info';
    return 'mute';
  }

  protected ago(iso: string | null | undefined): string {
    const t = iso ? new Date(iso).getTime() : NaN;
    if (Number.isNaN(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  private replace(workflow: Workflow): void {
    this.workflows.update((list) => list.map((w) => (w.id === workflow.id ? workflow : w)));
  }

  private flash(text: string): void {
    this.toast.set(text);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(''), 3500);
  }
}
