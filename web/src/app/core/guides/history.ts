import type { Guide } from '../guides';

export const history: Guide = {
  title: 'History guide',
  intro: 'See every message sent from your account and what happened to it. Keep this open while you work.',
  tasks: [
    {
      title: 'Check if a message reached someone',
      steps: [
        'Open History.',
        'Type the number in Recipient, then press Enter.',
        'Look at the Status column - Sent, Delivered or Read.',
        'Updated shows when the status last changed.',
      ],
    },
    {
      title: 'Find messages that failed',
      steps: [
        'Pick Failed in the status list (it starts on All statuses).',
        'Read the Error column to see why each one did not go.',
        'Attempts shows how many times we tried.',
      ],
      tip: 'Not on WhatsApp means the number has no WhatsApp account - remove it from your contacts.',
    },
    {
      title: 'Filter by status',
      steps: [
        'Open the status list and pick one, for example Queued, Delivered, Read or Cancelled.',
        'The coloured counts next to the filters show how many messages are in each status.',
        'Click Clear filters when nothing matches, to see everything again.',
      ],
    },
    {
      title: 'Get the latest statuses',
      steps: [
        'Click Refresh at the top.',
        'Use the page buttons at the bottom to move through older messages.',
      ],
    },
  ],
};
