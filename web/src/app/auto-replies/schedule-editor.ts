import { ChangeDetectionStrategy, Component, model } from '@angular/core';

import { ArSwitch, ArText } from './ar-fields';
import { DAYS, RuleSchedule } from './auto-replies.api';

/** Office hours most businesses start from, so switching the schedule on is one click. */
const DEFAULT: RuleSchedule = {
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  start: '09:00',
  end: '18:00',
  outsideReply: '',
};
/** Per-instance id counter for label/input pairs. */
let seq = 0;

/**
 * Optional time window for a rule: active days, a from/to time, and what to
 * say outside it. `null` means always on, which is why the switch maps
 * straight onto the model.
 */
@Component({
  selector: 'ar-schedule-editor',
  imports: [ArSwitch, ArText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` @let s = value();
    <ar-switch
      label="Only reply at certain times"
      [checked]="!!s"
      (checkedChange)="value.set($event ? defaults() : null)"
    />
    @if (s) {
      <div class="body enter">
        <div class="days" role="group" aria-label="Active days">
          @for (d of days; track d.key) {
            <button
              type="button"
              [class.on]="s.days.includes(d.key)"
              [attr.aria-pressed]="s.days.includes(d.key)"
              (click)="toggleDay(d.key)"
            >
              {{ d.label }}
            </button>
          }
        </div>
        <div class="times">
          <div class="field">
            <label [for]="uid + 's'">From</label
            ><input
              [id]="uid + 's'"
              type="time"
              [value]="s.start"
              (change)="patch({ start: v($event) })"
            />
          </div>
          <div class="field">
            <label [for]="uid + 'e'">To</label
            ><input
              [id]="uid + 'e'"
              type="time"
              [value]="s.end"
              (change)="patch({ end: v($event) })"
            />
          </div>
        </div>
        <div class="field">
          <label [for]="uid + 'o'"
            >Outside-hours reply
            <span class="hint">(leave empty to stay silent and let other rules try)</span></label
          >
          <ar-text
            [inputId]="uid + 'o'"
            [rows]="2"
            [value]="s.outsideReply"
            (valueChange)="patch({ outsideReply: $event })"
            placeholder="We're closed right now, back at 9 AM."
          />
        </div>
      </div>
    }`,
  styles: `
    :host {
      display: grid;
      gap: var(--space-md);
    }
    .body {
      display: grid;
      gap: var(--space-md);
      padding: var(--space-lg);
      border-radius: var(--radius-lg);
      background: var(--surface-sunken);
    }
    .days {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .days button {
      min-width: 50px;
      padding: 6px 13px;
      border-radius: 999px;
      border: 1px solid var(--border-color);
      background: var(--surface-card);
      color: var(--text-muted);
      font-weight: 500;
      font-size: 12.5px;
      transition:
        background var(--fast) var(--ease),
        border-color var(--fast) var(--ease),
        color var(--fast) var(--ease);
    }
    .days button:hover {
      color: var(--text-strong);
      border-color: var(--border-hover);
    }
    .days button.on {
      background: var(--primary-tint);
      border-color: color-mix(in srgb, var(--primary) 45%, transparent);
      color: var(--primary-text);
    }
    .times {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: var(--space-md);
    }
    .field {
      display: grid;
      gap: 7px;
    }
    .field label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-strong);
    }
    .hint {
      font-size: 12px;
      font-weight: 400;
      color: var(--text-muted);
    }
  `,
})
export class ScheduleEditor {
  readonly value = model<RuleSchedule | null>(null);
  protected readonly days = DAYS;
  protected readonly uid = `sch${++seq}`;

  protected defaults(): RuleSchedule {
    return { ...DEFAULT, days: [...DEFAULT.days] };
  }

  protected v(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  protected patch(p: Partial<RuleSchedule>): void {
    const s = this.value();
    if (s) this.value.set({ ...s, ...p });
  }

  protected toggleDay(day: string): void {
    const s = this.value();
    if (!s) return;
    const days = s.days.includes(day)
      ? s.days.filter((d) => d !== day)
      : DAYS.map((d) => d.key).filter((k) => k === day || s.days.includes(k));
    this.patch({ days });
  }
}
