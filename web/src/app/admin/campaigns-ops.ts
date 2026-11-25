import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, debounceTime, map, of, switchMap } from 'rxjs';

import { Pager, pageOf } from '../core/pager';
import { AdminFeed } from './admin-feed';
import { CampaignsOpsApi, type AiSettings, type CampaignFilter, type OpsCampaign } from './campaigns-ops-api';
import { sentenceCase } from './text';

/** The destructive action waiting on the confirm dialog. */
type Pending = { readonly kind: 'stop-all' } | { readonly kind: 'cancel'; readonly row: OpsCampaign };

/** Campaign rows per page. */
const PAGE_SIZE = 20;

/** Segments of the status filter; values are what the server's `?status=` accepts. */
const FILTERS: readonly { readonly value: CampaignFilter; readonly label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'paused', label: 'Paused' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
];

/** AI services for Make variations; ids match the server's PROVIDERS. All but Claude speak the OpenAI chat format. */
const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', keyHint: 'console.anthropic.com', keyStart: 'sk-ant-...' },
  { id: 'openai', label: 'OpenAI (ChatGPT)', keyHint: 'platform.openai.com', keyStart: 'sk-...' },
  { id: 'gemini', label: 'Google Gemini', keyHint: 'aistudio.google.com', keyStart: 'AIza...' },
  { id: 'groq', label: 'Groq', keyHint: 'console.groq.com', keyStart: 'gsk_...' },
  { id: 'openrouter', label: 'OpenRouter (many models)', keyHint: 'openrouter.ai', keyStart: 'sk-or-...' },
  { id: 'deepseek', label: 'DeepSeek', keyHint: 'platform.deepseek.com', keyStart: 'sk-...' },
  { id: 'custom', label: 'Other (OpenAI-compatible)', keyHint: 'your AI service', keyStart: '' },
] as const;

/** The service a key belongs to, from how it starts; null when the start does not say. */
export function detectProvider(key: string): string | null {
  const k = key.trim();
  if (k.startsWith('sk-ant-')) return 'anthropic';
  if (k.startsWith('sk-or-')) return 'openrouter';
  if (k.startsWith('gsk_')) return 'groq';
  if (k.startsWith('AIza')) return 'gemini';
  // DeepSeek keys are "sk-" + 32 hex characters; every other "sk-" key is OpenAI's.
  if (/^sk-[0-9a-f]{32}$/.test(k)) return 'deepseek';
  if (k.startsWith('sk-')) return 'openai';
  return null;
}


/**
 * Every bulk campaign on the platform, for the super admin.
 *
 * The kill-switch card sits on top because it is the emergency control: one
 * click stops every running send. It only *reads* the policy kill switch —
 * leaving it on permanently is a policy decision, made in policy settings, so
 * this panel never writes policy. Pause and resume are reversible and go
 * straight through; cancel and stop-all cannot be undone, so they confirm.
 */
@Component({
  selector: 'app-campaigns-ops',
  imports: [Pager],
  templateUrl: './campaigns-ops.html',
  styleUrl: './campaigns-ops.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CampaignsOps {
  private readonly api = inject(CampaignsOpsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogRef = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** Pill labels are sentence case: "past_due" reads "Past due". */
  protected readonly sentence = sentenceCase;
  protected readonly filters = FILTERS;
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly rows = signal<readonly OpsCampaign[]>([]);
  protected readonly killSwitch = signal<boolean | null>(null);
  protected readonly filter = signal<CampaignFilter>('all');
  /** Row id with a request in flight, so its buttons disable and nothing double-fires. */
  protected readonly busy = signal<number | null>(null);
  protected readonly stopping = signal(false);
  /** Result of the last action, shown above the table. */
  protected readonly notice = signal<{ readonly tone: 'ok' | 'bad'; readonly text: string } | null>(null);
  protected readonly pending = signal<Pending | null>(null);

  protected readonly pageSize = PAGE_SIZE;
  /** Back to the first page whenever the status filter (which refetches) changes. */
  protected readonly page = linkedSignal(() => {
    this.filter();
    return 0;
  });
  protected readonly shown = computed(() => pageOf(this.rows(), this.page(), PAGE_SIZE));

  protected readonly providers = PROVIDERS;
  /** Models the key can use, fetched from its service; null while there is nothing to ask with. */
  protected readonly models = signal<readonly string[] | null>(null);
  protected readonly modelsLoading = signal(false);
  protected readonly modelsError = signal<string | null>(null);
  /** The list plus the saved model, so a saved choice still shows before (or without) a fresh list. */
  protected readonly modelOptions = computed(() => {
    const list = this.models() ?? [];
    const current = this.aiModel();
    return current && !list.includes(current) ? [current, ...list] : list;
  });
  private readonly askModels = new Subject<void>();
  /** Saved AI settings; null until loaded. */
  protected readonly ai = signal<AiSettings | null>(null);
  protected readonly aiProvider = signal('anthropic');
  /** A new key being typed: the saved one is never sent to the browser. */
  protected readonly aiKey = signal('');
  protected readonly aiModel = signal('');
  protected readonly aiBaseUrl = signal('');
  protected readonly aiSaving = signal(false);
  protected readonly provider = computed(() => PROVIDERS.find((p) => p.id === this.aiProvider()) ?? PROVIDERS[0]);
  /** A key from one service does not work on another, so switching asks for a new one. */
  protected readonly needsKey = computed(() => !!this.ai() && this.aiProvider() !== this.ai()!.provider && !this.aiKey().trim());
  protected readonly aiChanged = computed(() => {
    const saved = this.ai();
    if (!saved) return false;
    return (
      !!this.aiKey().trim() ||
      this.aiProvider() !== saved.provider ||
      this.aiModel().trim() !== saved.model ||
      this.aiBaseUrl().trim() !== saved.baseUrl
    );
  });

  constructor() {
    this.load();
    // Every change to the service, key or address asks the service again, once the typing pauses.
    this.askModels
      .pipe(
        debounceTime(500),
        switchMap(() => {
          const ask = this.modelsRequest();
          if (!ask) return of(null);
          this.modelsLoading.set(true);
          return this.api.aiModels(ask).pipe(
            map((models) => ({ models, error: null })),
            catchError((err: Error) => of({ models: [] as string[], error: err.message })),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((r) => {
        this.modelsLoading.set(false);
        this.models.set(r?.models ?? null);
        this.modelsError.set(r?.error ?? null);
        // Keep the chosen model when the service offers it, else take Opus 5.5 or the first one.
        const list = r?.models ?? [];
        if (list.length && !list.includes(this.aiModel())) {
          this.aiModel.set(list.includes('claude-opus-5-5') ? 'claude-opus-5-5' : list[0]);
        }
      });
    this.api
      .aiSettings()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => this.setAi(s),
        error: (err: Error) => this.notice.set({ tone: 'bad', text: `Could not load the AI settings: ${err.message}` }),
      });
    // A run finishing, pausing on a limit or being stopped anywhere on the platform shows here as it happens.
    inject(AdminFeed).watch(['campaigns'], () => this.load(true), 600);
    // The native <dialog> gives focus trapping and Escape for free; it just needs opening.
    effect(() => {
      const dialog = this.dialogRef()?.nativeElement;
      if (!dialog) return;
      if (this.pending() && !dialog.open) dialog.showModal();
      if (!this.pending() && dialog.open) dialog.close();
    });
  }

  /** `quiet`: a live refresh, which keeps the table on screen instead of flashing the loader. */
  load(quiet = false): void {
    if (!quiet) {
      this.loading.set(true);
      this.error.set(null);
    }
    this.api
      .list(this.filter())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ killSwitch, campaigns }) => {
          this.killSwitch.set(killSwitch);
          this.rows.set(campaigns);
          this.loading.set(false);
        },
        error: (err: Error) => {
          this.error.set(err.message);
          this.loading.set(false);
        },
      });
  }

  protected saveAi(): void {
    if (!this.aiChanged() || this.needsKey()) return;
    const key = this.aiKey().trim();
    this.writeAi(
      {
        provider: this.aiProvider(),
        ...(key ? { apiKey: key } : {}),
        model: this.aiModel().trim(),
        baseUrl: this.aiProvider() === 'custom' ? this.aiBaseUrl().trim() : '',
      },
      'AI settings saved.',
    );
  }

  /** Typing or pasting a key picks its service, so the admin only has to paste. */
  protected typeKey(key: string): void {
    this.aiKey.set(key);
    const found = detectProvider(key);
    if (found && found !== this.aiProvider()) this.pickProvider(found);
    else this.askModels.next();
  }

  protected pickProvider(id: string): void {
    this.aiProvider.set(id);
    // Model names differ per service: keep the saved one only when going back to its service.
    this.aiModel.set(id === this.ai()?.provider ? this.ai()!.model : '');
    this.models.set(null);
    this.askModels.next();
  }

  protected typeBaseUrl(url: string): void {
    this.aiBaseUrl.set(url);
    this.askModels.next();
  }

  /** What to ask the models with: a typed key, or the saved key while its service is picked. */
  private modelsRequest(): { provider: string; apiKey?: string; baseUrl?: string } | null {
    const key = this.aiKey().trim();
    const provider = this.aiProvider();
    if (!key && !(this.ai()?.hasKey && provider === this.ai()?.provider)) return null;
    if (provider === 'custom' && !/^https?:\/\/\S+$/i.test(this.aiBaseUrl().trim())) return null;
    return { provider, ...(key ? { apiKey: key } : {}), ...(provider === 'custom' ? { baseUrl: this.aiBaseUrl().trim() } : {}) };
  }

  /** Saves at once, like any switch: no Save press needed. */
  protected toggleAi(enabled: boolean): void {
    this.writeAi(
      { enabled },
      enabled ? 'Make variations is shown to every business.' : 'Make variations is hidden from every business.',
    );
  }

  protected removeAiKey(): void {
    this.writeAi({ apiKey: '' }, 'API key removed: Make variations is off until a new key is saved.');
  }

  private writeAi(patch: Parameters<CampaignsOpsApi['saveAiSettings']>[0], done: string): void {
    this.aiSaving.set(true);
    this.notice.set(null);
    this.api
      .saveAiSettings(patch)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => {
          this.aiSaving.set(false);
          // The switch keeps whatever key or model is being typed in the form below it.
          if (patch.enabled !== undefined) this.ai.update((a) => a && { ...a, enabled: s.enabled });
          else this.setAi(s);
          this.notice.set({ tone: 'ok', text: done });
        },
        error: (err: Error) => {
          this.aiSaving.set(false);
          this.notice.set({ tone: 'bad', text: err.message });
        },
      });
  }

  private setAi(s: AiSettings): void {
    this.ai.set(s);
    this.aiProvider.set(s.provider);
    this.aiKey.set('');
    this.aiModel.set(s.model);
    this.aiBaseUrl.set(s.baseUrl);
    this.askModels.next();
  }

  protected setFilter(value: CampaignFilter): void {
    if (value === this.filter()) return;
    this.filter.set(value);
    this.rows.set([]);
    this.load();
  }

  protected pause(row: OpsCampaign): void {
    this.act(row, 'pause', `${row.name} paused.`);
  }

  protected resume(row: OpsCampaign): void {
    this.act(row, 'resume', `${row.name} resumed.`);
  }

  protected askCancel(row: OpsCampaign): void {
    this.pending.set({ kind: 'cancel', row });
  }

  protected askStopAll(): void {
    this.pending.set({ kind: 'stop-all' });
  }

  protected confirm(): void {
    const pending = this.pending();
    if (!pending) return;
    this.pending.set(null);
    if (pending.kind === 'cancel') this.act(pending.row, 'cancel', `${pending.row.name} cancelled.`);
    else this.stopAll();
  }

  protected dismiss(): void {
    this.pending.set(null);
  }

  protected canCancel(row: OpsCampaign): boolean {
    return row.status === 'running' || row.status === 'paused' || row.status === 'scheduled' || row.status === 'draft';
  }

  protected statusTone(status: OpsCampaign['status']): string {
    if (status === 'running') return 'tone-ok';
    if (status === 'paused') return 'tone-warn';
    if (status === 'scheduled') return 'tone-info';
    return 'tone-mute';
  }

  /** Under 10% is normal noise on a bulk send; above 25% usually means a bad list or a ban risk. */
  protected rateTone(rate: number): string {
    if (rate > 25) return 'tone-bad';
    if (rate >= 10) return 'tone-warn';
    return 'tone-mute';
  }

  protected when(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  private act(row: OpsCampaign, action: 'pause' | 'resume' | 'cancel', done: string): void {
    this.busy.set(row.id);
    this.notice.set(null);
    this.api
      .act(row.id, action)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ campaign }) => {
          this.busy.set(null);
          this.notice.set({ tone: 'ok', text: done });
          // Patch in place so the row stays put under a filter it may no longer match.
          this.rows.update((rows) =>
            rows.map((r) =>
              r.id === campaign.id
                ? { ...r, status: campaign.status, statusReason: campaign.options?.statusReason ?? null }
                : r,
            ),
          );
        },
        error: (err: Error) => {
          this.busy.set(null);
          this.notice.set({ tone: 'bad', text: err.message });
        },
      });
  }

  private stopAll(): void {
    this.stopping.set(true);
    this.notice.set(null);
    this.api
      .stopAll()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ cancelled, dropped, killSwitch }) => {
          this.stopping.set(false);
          this.killSwitch.set(killSwitch);
          this.notice.set({
            tone: 'ok',
            text: `Stopped ${cancelled} campaign${cancelled === 1 ? '' : 's'}, dropped ${dropped} queued message${dropped === 1 ? '' : 's'}.`,
          });
          this.load();
        },
        error: (err: Error) => {
          this.stopping.set(false);
          this.notice.set({ tone: 'bad', text: err.message });
        },
      });
  }
}
