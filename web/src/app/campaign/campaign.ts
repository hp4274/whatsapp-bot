import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  OnInit,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';

import { Api, CampaignsApi, RetargetFilter, type UploadedMedia } from '../core/api';
import { focusInPage } from '../core/scroll';
import { Store } from '../core/store';
import { TemplatesApi } from '../templates/templates-api';
import { InteractiveEditor } from './interactive/interactive-editor';
import { InteractiveDraft, validateInteractive } from './interactive/interactive.model';
import { CampaignPolicy } from './policy-api';
import { formatBytes } from './wa-format';
import { CampaignDraft, ComposerStep } from './draft';
import { PhonePreview } from './phone-preview';
import { AudienceStep } from './steps/audience-step';
import { MessageStep } from './steps/message-step';
import { ReviewStep } from './steps/review-step';

/** The composer's rail, in plain words; the result screen after sending is not a step. */
const STEPS: { n: ComposerStep; label: string; icon: string }[] = [
  { n: 1, label: 'Who', icon: 'users' },
  { n: 2, label: 'Message', icon: 'message' },
  { n: 3, label: 'When & send', icon: 'send' },
];

/** Accepted `?filter=` values for a re-target link; anything else falls back to 'failed'. */
const FILTERS: RetargetFilter[] = ['failed', 'unread', 'noreply', 'replied', 'clicked', 'clickedLink'];

/**
 * The campaign composer page: a three-step wizard (who, message, when & send)
 * beside a live phone preview, a result screen once sent, plus a quick
 * single-message mode. All draft state lives in the root-provided
 * CampaignDraft, so a half-built campaign survives navigating away (and a
 * reload, through its autosave); this view routes between steps and applies
 * the prefill links: `?template=`, `?retarget=&filter=`, `?segment=`,
 * `?tags=a,b`, `?duplicate=` and `?edit=`. Hand-picked contacts arrive in the
 * navigation state (`contactIds`), never the URL, since there can be thousands.
 */
@Component({
  selector: 'app-campaign',
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    PhonePreview,
    AudienceStep,
    MessageStep,
    ReviewStep,
    InteractiveEditor,
  ],
  templateUrl: './campaign.html',
  styleUrl: './campaign.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CampaignView implements OnInit {
  private readonly api = inject(Api);
  private readonly campaignsApi = inject(CampaignsApi);
  private readonly templatesApi = inject(TemplatesApi);
  private readonly router = inject(Router);
  /**
   * Read while the route activates: ngOnInit runs after NavigationEnd (zoneless
   * change detection), when `currentNavigation()` is already null. Only a fresh
   * navigation carries it, so a reload never re-applies hand-picked ids.
   */
  private readonly navState = this.router.currentNavigation()?.extras.state as
    | { contactIds?: unknown }
    | undefined;
  private readonly destroyRef = inject(DestroyRef);
  protected readonly store = inject(Store);
  protected readonly draft = inject(CampaignDraft);
  protected readonly policy = inject(CampaignPolicy);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** Query params (withComponentInputBinding). */
  readonly template = input<string>();
  readonly id = input<string>();
  readonly retarget = input<string>();
  readonly filter = input<string>();
  readonly segment = input<string>();
  readonly tags = input<string>();
  readonly duplicate = input<string>();
  readonly edit = input<string>();

  protected readonly steps = STEPS;
  protected readonly tab = signal<'composer' | 'single'>('composer');
  protected readonly notice = signal('');
  /** A ?duplicate= / ?edit= campaign is loading; the steps would show a blank draft meanwhile. */
  protected readonly loadingCampaign = signal(false);
  /** The failed campaign load, so its banner can offer Try again. */
  protected readonly loadError = signal<{
    message: string;
    id: number;
    mode: 'duplicate' | 'edit';
  } | null>(null);
  /** Continue was picked and the draft's sheet or saved list is still loading. */
  protected readonly restoring = signal(false);

  // Quick single message
  protected readonly recipient = signal('');
  protected readonly recipientName = signal('');
  protected readonly message = signal('Hello {name}, your order has been confirmed.');
  protected readonly busy = signal(false);
  protected readonly file = signal<UploadedMedia | null>(null);
  protected readonly uploading = signal(false);
  protected readonly buttons = signal<InteractiveDraft | null>(null);
  protected readonly buttonErrors = computed(() => validateInteractive(this.buttons()));
  protected readonly size = formatBytes;
  protected readonly connected = computed(() => this.store.connection().connected);

  protected readonly contactLabel = computed(() => {
    const c = this.draft.previewContact();
    return c.name ? `${c.name}` : `+${c.phone}`;
  });

  protected readonly title = computed(() =>
    this.draft.editingId() !== null && !this.draft.result() ? 'Edit campaign' : 'New campaign',
  );

  /**
   * Why people were left out, from the start response. Not-opted-in and a
   * lowered speed are already spelled out in `policyNotes`, so they are not
   * repeated here; whatever the counters do not explain was already queued or
   * a repeated number.
   */
  protected readonly skipReasons = computed(() => {
    const r = this.draft.result();
    if (!r?.started) return [];
    const rows = [
      { n: r.skippedOptOut ?? 0, icon: 'user-off', text: 'opted out of your messages' },
      { n: r.skippedMuted ?? 0, icon: 'bell-off', text: 'asked not to get campaigns for a while' },
      {
        n: r.skippedFrequency ?? 0,
        icon: 'clock-pause',
        text: "already got today's maximum of bulk messages",
      },
      {
        n: r.skippedTemplateVars ?? 0,
        icon: 'template-off',
        text: 'had no value for a slot the template needs',
      },
    ];
    const explained = rows.reduce((t, x) => t + x.n, 0) + (r.skippedNoOptIn ?? 0);
    const other = (r.skipped ?? 0) - explained;
    if (other > 0) {
      rows.push({ n: other, icon: 'repeat', text: 'were repeated numbers or already queued' });
    }
    return rows.filter((x) => x.n > 0);
  });

  constructor() {
    // A step change (or the result screen) swaps the whole panel, so move focus
    // (and the screen reader) to the new heading; the first render leaves focus alone.
    let first = true;
    effect(() => {
      this.draft.step();
      this.draft.result();
      if (first) {
        first = false;
        return;
      }
      untracked(() => afterNextRender(() => this.focusStepHeading(), { injector: this.injector }));
    });
  }

  private focusStepHeading(): void {
    const h = this.host.nativeElement.querySelector<HTMLElement>('.main h3, .finish h3');
    if (!h) return;
    h.tabIndex = -1;
    // A plain focus() also scrolls the clipped shell and the document.
    focusInPage(h);
  }

  ngOnInit(): void {
    this.draft.init();
    this.policy.load();
    const id = this.id();
    if (id) {
      this.router.navigate(['/campaigns', id]);
      return;
    }
    // Only a fresh navigation carries ids: a reload must not overwrite the draft with them again.
    const picked = this.navState?.contactIds;
    const contactIds = Array.isArray(picked)
      ? picked.filter((n): n is number => Number.isInteger(n))
      : [];
    // A "start from this" link is a new intent: it replaces an earlier session's draft.
    const linked = [
      contactIds.length ? 'ids' : '',
      this.template(),
      this.retarget(),
      this.segment(),
      this.tags(),
      this.duplicate(),
      this.edit(),
    ];
    if (linked.some(Boolean)) this.draft.discardSaved();
    const editId = Number(this.edit());
    const duplicateId = Number(this.duplicate());
    if (editId || duplicateId) {
      this.loadCampaign(editId || duplicateId, editId ? 'edit' : 'duplicate');
      return;
    }
    if (contactIds.length) {
      this.prefillContacts(contactIds);
      // The browser keeps navigation state across a reload, and Angular hands it back as
      // the initial navigation's state: drop the ids once used so a reload keeps the draft.
      const rest = { ...((history.state ?? {}) as Record<string, unknown>) };
      delete rest['contactIds'];
      history.replaceState(rest, '');
    }
    const templateId = Number(this.template());
    if (templateId) this.prefillTemplate(templateId);
    const retargetId = Number(this.retarget());
    if (retargetId) this.prefillRetarget(retargetId, this.filter());
    const segmentId = Number(this.segment());
    if (segmentId) this.prefillSegment(segmentId);
    const tags = (this.tags() ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (tags.length && !segmentId) this.prefillTags(tags);
  }

  protected loadCampaign(id: number, mode: 'duplicate' | 'edit'): void {
    this.loadError.set(null);
    this.loadingCampaign.set(true);
    this.tab.set('composer');
    this.draft
      .prefillFrom(id, mode)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (campaign) => {
          this.loadingCampaign.set(false);
          this.store.setStatus(
            mode === 'edit' ? `Editing "${campaign.name}"` : `Copied "${campaign.name}"`,
            'primary',
          );
        },
        error: (err: Error) => {
          this.loadingCampaign.set(false);
          this.loadError.set({ message: err.message, id, mode });
        },
      });
  }

  private prefillTemplate(id: number): void {
    this.templatesApi.get(id).subscribe({
      next: ({ template }) => {
        const t = template as typeof template & {
          mediaId?: string | null;
          interactive?: InteractiveDraft | null;
        };
        this.draft.message.set(t.body ?? '');
        this.draft.templateId.set(t.id ?? id);
        if (t.interactive) this.draft.interactive.set(t.interactive);
        if (t.mediaId) {
          this.draft.setAttachment({
            mediaId: t.mediaId,
            filename: 'Template attachment',
            mimetype: '',
            size: 0,
            previewUrl: '',
          });
        }
        this.store.setStatus(`Loaded template "${t.name}"`, 'primary');
      },
      error: (err: Error) => this.notice.set(`Could not load the template: ${err.message}`),
    });
  }

  private prefillRetarget(campaignId: number, filter: string | undefined): void {
    const f = FILTERS.includes(filter as RetargetFilter) ? (filter as RetargetFilter) : 'failed';
    this.leaveResult();
    this.draft.source.set('retarget');
    this.draft.retarget.set({ campaignId, filter: f, optionId: '' });
    this.draft.step.set(1);
    this.campaignsApi.get(campaignId).subscribe({
      next: ({ campaign }) => {
        this.draft.retargetCampaign.set(campaign);
        this.draft.name.set(`Follow-up: ${campaign.name}`);
      },
      error: () => undefined,
    });
  }

  /** `?segment=<id>` from the contacts page: the saved segment is the audience. */
  private prefillSegment(id: number): void {
    const d = this.draft;
    this.leaveResult();
    d.source.set('contacts');
    d.contactFilter.set({});
    d.segment.set(null);
    d.segmentId.set(id);
    d.step.set(1);
    d.loadSegment(id).subscribe({
      next: (segment) => {
        if (!segment) this.notice.set('That segment no longer exists - pick who gets it below.');
      },
      error: (err: Error) => this.notice.set(`Could not load the segment: ${err.message}`),
    });
  }

  /** `?tags=a,b` from the contacts page: everyone carrying all of those tags. */
  private prefillTags(tags: string[]): void {
    const d = this.draft;
    this.leaveResult();
    d.source.set('contacts');
    d.segmentId.set(null);
    d.segment.set(null);
    d.contactsCount.set(null);
    d.contactFilter.set({ tags });
    d.step.set(1);
  }

  /** Rows ticked on the contacts page: the audience is exactly those contacts. */
  private prefillContacts(ids: number[]): void {
    const d = this.draft;
    this.leaveResult();
    d.source.set('contacts');
    d.segmentId.set(null);
    d.segment.set(null);
    d.contactFilter.set({ ids });
    d.contactsCount.set(ids.length);
    d.step.set(1);
  }

  /** A prefill link opened over a finished campaign starts a new one. */
  private leaveResult(): void {
    if (this.draft.result()) this.draft.reset();
  }

  protected resume(): void {
    this.restoring.set(true);
    this.draft
      .restore()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.restoring.set(false),
        error: (err: Error) => {
          this.restoring.set(false);
          this.notice.set(err.message);
        },
      });
  }

  protected startFresh(): void {
    this.draft.discardSaved();
  }

  /** Steps open in order: you can always go back, forward only once the earlier steps are ready. */
  protected canOpen(n: ComposerStep): boolean {
    const d = this.draft;
    if (d.result()) return false;
    if (n <= d.step()) return true;
    if (n === 2) return d.audienceReady();
    return d.composeReady();
  }

  protected open(n: ComposerStep): void {
    if (this.canOpen(n)) this.draft.goTo(n);
  }

  protected startOver(): void {
    this.draft.reset();
  }

  /** The /campaign?duplicate= flow, run in place: this page is already the composer. */
  protected duplicateSent(id: number): void {
    this.loadCampaign(id, 'duplicate');
  }

  /** The server checks type and size (16 MB, 64 MB for video) and says why it refused. */
  protected onAttach(event: Event): void {
    const input = event.target as HTMLInputElement;
    const picked = input.files?.[0];
    input.value = '';
    if (!picked) return;
    this.uploading.set(true);
    this.api.uploadMedia(picked).subscribe({
      next: (media) => {
        this.file.set({ ...media, mimetype: media.mimetype || picked.type });
        this.uploading.set(false);
      },
      error: (err: Error) => {
        this.uploading.set(false);
        this.notice.set(err.message);
      },
    });
  }

  protected sendSingle(): void {
    if (!this.connected()) {
      this.notice.set('Connect a transport on the Connection page first.');
      return;
    }
    this.busy.set(true);
    const extras = { mediaId: this.file()?.mediaId ?? null, interactive: this.buttons() };
    this.api.sendMessage(this.recipient(), this.message(), this.recipientName(), extras).subscribe({
      next: ({ messageId, recipient }) => {
        this.busy.set(false);
        this.notice.set('');
        this.file.set(null);
        this.buttons.set(null);
        this.store.setStatus(`Queued ${messageId.slice(0, 8)} -> +${recipient}`, 'primary');
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.notice.set(err.message);
      },
    });
  }
}
