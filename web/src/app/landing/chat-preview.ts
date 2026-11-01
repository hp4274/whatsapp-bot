import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';

import { Tilt } from '../school/tilt';
import { SegThumb } from './motion';

/** Who sent a line in the hero's chat preview: the customer, or the business's number. */
type Side = 'in' | 'out';

interface ChatLine {
  readonly side: Side;
  readonly text: string;
  readonly time: string;
}

interface Scenario {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly contact: string;
  readonly lines: readonly ChatLine[];
}

/**
 * The hero's live preview: one auto-reply conversation per kind of business.
 * Menus are numbered replies because a QR-linked number cannot send native
 * WhatsApp buttons or lists, so the preview shows what the product really sends.
 * Names and figures are sample content.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    key: 'shop',
    label: 'Shop',
    icon: 'building-store',
    contact: 'Priya Shah',
    lines: [
      { side: 'in', text: 'Hi, is the blue cotton kurta still in stock?', time: '9:41' },
      {
        side: 'out',
        text: 'Hi Priya! Reply with a number:\n1  Check stock\n2  Track my order\n3  Talk to the team',
        time: '9:41',
      },
      { side: 'in', text: '1', time: '9:42' },
      {
        side: 'out',
        text: 'Blue cotton kurta, size M: 4 left. Shall we hold one for you until 7 pm?',
        time: '9:42',
      },
    ],
  },
  {
    key: 'school',
    label: 'School',
    icon: 'school',
    contact: 'Aarav’s parent',
    lines: [
      {
        side: 'out',
        text: 'Reminder: Term 2 fees of ₹12,500 for Aarav (Class 6B) are due on 10 November.',
        time: '8:00',
      },
      { side: 'in', text: 'Can I pay this in two parts?', time: '8:14' },
      {
        side: 'out',
        text: 'Yes. Reply 1 for the two-instalment plan, or 2 to speak to the school office.',
        time: '8:14',
      },
      { side: 'in', text: '1', time: '8:15' },
    ],
  },
  {
    key: 'clinic',
    label: 'Clinic',
    icon: 'stethoscope',
    contact: 'Rohan Mehta',
    lines: [
      { side: 'in', text: 'Need an appointment tomorrow please', time: '18:20' },
      {
        side: 'out',
        text: 'Dr. Iyer is free tomorrow at 10:30, 12:00 and 16:15. Reply with a time.',
        time: '18:20',
      },
      { side: 'in', text: '12:00', time: '18:21' },
      {
        side: 'out',
        text: 'Booked: Tuesday 12:00 with Dr. Iyer. We will remind you an hour before.',
        time: '18:21',
      },
    ],
  },
];

/**
 * The landing hero's live thing: pick a kind of business and watch Wapzo answer
 * one of its customers. Each switch re-keys the thread, so the messages play in
 * again one by one.
 */
@Component({
  selector: 'app-chat-preview',
  imports: [Tilt, SegThumb],
  templateUrl: './chat-preview.html',
  styleUrl: './chat-preview.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatPreview {
  protected readonly scenarios = SCENARIOS;
  protected readonly scenarioKey = signal(SCENARIOS[0].key);
  protected readonly scenario = computed(
    () => SCENARIOS.find((s) => s.key === this.scenarioKey()) ?? SCENARIOS[0],
  );
}
