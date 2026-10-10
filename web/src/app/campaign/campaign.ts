import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { Api, CampaignsApi, RetargetFilter } from '../core/api';
import { Store } from '../core/store';
import { TemplatesApi } from '../templates/templates-api';
import { InteractiveDraft } from './interactive/interactive.model';
import { CampaignDraft, ComposerStep } from './draft';
import { PhonePreview } from './phone-preview';
import { AudienceStep } from './steps/audience-step';
import { MessageStep } from './steps/message-step';
import { ReviewStep } from './steps/review-step';

/** The composer's rail; step 4 is the result screen, reached only by sending. */
const STEPS: { n: ComposerStep; label: string; icon: string }[] = [
  { n: 1, label: 'Audience', icon: 'users' },
  { n: 2, label: 'Message', icon: 'notes' },
  { n: 3, label: 'Review', icon: 'list-check' },
  { n: 4, label: 'Send', icon: 'send' },
];

/** Accepted `?filter=` values for a re-target link; anything else falls back to 'failed'. */
const FILTERS: RetargetFilter[] = ['failed', 'unread', 'noreply', 'replied', 'clicked'];

/**
 * The campaign composer page: a four-step wizard (audience, message, review,
 * result) beside a live phone preview, plus a quick single-message mode.
 * All draft state lives in the root-provided CampaignDraft, so a half-built
 * campaign survives navigating away; this view only routes between steps and
 * applies `?template=` / `?retarget=` prefills.
 */
@Component({
  selector: 'app-campaign',
  imports: [DatePipe, FormsModule, RouterLink, PhonePreview, AudienceStep, MessageStep, ReviewStep],
  templateUrl: './campaign.html',
  styleUrl: './campaign.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CampaignView implements OnInit {
  private readonly api = inject(Api);
  private readonly campaignsApi = inject(CampaignsApi);
  private readonly templatesApi = inject(TemplatesApi);
  private readonly router = inject(Router);
  protected readonly store = inject(Store);
  protected readonly draft = inject(CampaignDraft);

  /** Query params (withComponentInputBinding). */
  readonly template = input<string>();
  readonly id = input<string>();
  readonly retarget = input<string>();
  readonly filter = input<string>();

  protected readonly steps = STEPS;
  protected readonly tab = signal<'composer' | 'single'>('composer');
  protected readonly notice = signal('');

  // Quick single message
  protected readonly recipient = signal('');
  protected readonly recipientName = signal('');
  protected readonly message = signal('Hello {name}, your order has been confirmed.');
  protected readonly busy = signal(false);
  protected readonly connected = computed(() => this.store.connection().connected);

  protected readonly contactLabel = computed(() => {
    const c = this.draft.previewContact();
    return c.name ? `${c.name}` : `+${c.phone}`;
  });

  ngOnInit(): void {
    this.draft.init();
    const id = this.id();
    if (id) {
      this.router.navigate(['/campaigns', id]);
      return;
    }
    const templateId = Number(this.template());
    if (templateId) this.prefillTemplate(templateId);
    const retargetId = Number(this.retarget());
    if (retargetId) this.prefillRetarget(retargetId, this.filter());
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
    this.draft.source.set('retarget');
    this.draft.retarget.set({ campaignId, filter: f, optionId: '' });
    this.draft.step.set(2);
    this.campaignsApi.get(campaignId).subscribe({
      next: ({ campaign }) => {
        this.draft.retargetCampaign.set(campaign);
        this.draft.name.set(`Follow-up: ${campaign.name}`);
      },
      error: () => undefined,
    });
  }

  /** Steps open in order: you can always go back, forward only once the earlier steps are ready. */
  protected canOpen(n: ComposerStep): boolean {
    const d = this.draft;
    const step = d.step();
    if (step === 4) return n === 4;
    if (n <= step) return true;
    if (n === 2) return d.audienceReady();
    if (n === 3) return d.audienceReady() && d.messageReady();
    return false;
  }

  protected open(n: ComposerStep): void {
    if (this.canOpen(n)) this.draft.goTo(n);
  }

  protected startOver(): void {
    this.draft.reset();
  }

  protected sendSingle(): void {
    if (!this.connected()) {
      this.notice.set('Connect a transport on the Connection page first.');
      return;
    }
    this.busy.set(true);
    this.api.sendMessage(this.recipient(), this.message(), this.recipientName()).subscribe({
      next: ({ messageId, recipient }) => {
        this.busy.set(false);
        this.notice.set('');
        this.store.setStatus(`Queued ${messageId.slice(0, 8)} -> +${recipient}`, 'primary');
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.notice.set(err.message);
      },
    });
  }
}
