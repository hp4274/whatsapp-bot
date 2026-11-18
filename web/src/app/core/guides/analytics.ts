import type { Guide } from '../guides';

export const analytics: Guide = {
  title: 'Analytics guide',
  intro: 'See how your messages, campaigns and replies are doing. Keep this open while you work.',
  tasks: [
    {
      title: 'Pick the time range',
      steps: [
        'Open Analytics.',
        'At the top right, choose 7 days, 30 days or 90 days.',
        'Every figure on the page changes to match.',
        'Click the refresh button next to it to load the latest numbers.',
      ],
    },
    {
      title: 'Read the key figures',
      steps: [
        'The tiles at the top show Sent, Delivery rate, Read rate, Failed, Auto-reply hits and Median first response.',
        'The small line in each tile shows how it moved day by day.',
        'A high Failed number often means wrong numbers in your list - check History for the reasons.',
      ],
    },
    {
      title: 'Follow the daily trend',
      steps: [
        'Look at Daily trend.',
        'Point at the chart (or tap it) to see the numbers for a single day.',
        'Click Sent, Delivered, Read or Failed above the chart to hide or show that line.',
        'Click CSV to download the daily numbers.',
      ],
    },
    {
      title: 'Compare your campaigns',
      steps: [
        'Scroll to Campaigns to see each campaign sent in the range.',
        'Click a column heading - Sent, Delivered, Read rate, Failed, Last send - to sort by it.',
        'Click a campaign name to open its full report.',
        'Click CSV to download the table.',
      ],
      tip: 'Campaigns with a high read rate are worth copying - look at what you wrote.',
    },
    {
      title: 'Check how fast you reply',
      steps: [
        'Look at First response time.',
        'Median shows how long customers usually wait for the first reply; p90 shows the slow cases.',
        'Unanswered shows conversations nobody replied to yet.',
        'Distribution shows how many replies were fast and how many were slow.',
      ],
      tip: 'Auto-replies count as a reply, so good auto-reply rules bring this time down.',
    },
    {
      title: 'See how your auto-replies work',
      steps: [
        'Look at Auto-replies for Replies sent, Inbound and Matched a rule.',
        'Top rules shows which rules answer the most messages.',
        'Click Manage rules to change them.',
      ],
    },
    {
      title: 'Watch your monthly usage',
      steps: [
        'Look at Monthly usage for the messages sent in the last 6 months.',
        'The ring shows how much of this month\'s plan limit you have used.',
      ],
    },
    {
      title: 'See what is happening right now',
      steps: [
        'Scroll to Right now - these do not depend on the time range.',
        'Sending queue shows what is Pending, Sent this run, Failed this run and sent Today.',
        'Support shows open tickets and unread or unassigned conversations.',
        'Records shows your orders, bookings and other records by status.',
      ],
    },
  ],
};
