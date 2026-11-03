import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  input,
  output,
  viewChild,
} from '@angular/core';

/**
 * The one "are you sure" popup (Kardlyz confirm-dialog): dimmed page, a short question, Cancel and a red action.
 * Used for deleting a tenant, removing a team member and signing out, so they all look and behave the same.
 * Cancel takes focus when it opens, so Enter or Escape never does the destructive thing by accident.
 */
@Component({
  selector: 'app-confirm',
  template: `
    <div class="dialog-wrap" (click)="cancel.emit()" (keydown.escape)="cancel.emit()">
      <div
        class="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-desc"
        (click)="$event.stopPropagation()"
      >
        <h3 id="confirm-title">{{ heading() }}</h3>
        <p id="confirm-desc">{{ text() }}</p>
        <div class="dialog-actions">
          <button #cancelBtn class="btn" type="button" (click)="cancel.emit()">Cancel</button>
          <button class="btn" [class.danger-fill]="tone() === 'danger'" [class.primary]="tone() === 'primary'" type="button" (click)="confirm.emit()">
            {{ action() }}
          </button>
        </div>
      </div>
    </div>
  `,
  styleUrl: './confirm-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialog {
  readonly heading = input.required<string>();
  readonly text = input.required<string>();
  /** The red button's words: what happens, e.g. "Delete tenant". */
  readonly action = input.required<string>();
  /** Red for what removes or ends something; primary for a plain "yes, go ahead". */
  readonly tone = input<'danger' | 'primary'>('danger');
  readonly confirm = output<void>();
  readonly cancel = output<void>();

  private readonly cancelBtn = viewChild.required<ElementRef<HTMLButtonElement>>('cancelBtn');

  constructor() {
    afterNextRender(() => this.cancelBtn().nativeElement.focus());
  }
}
