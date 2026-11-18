import type { Guide } from '../guides';

export const tickets: Guide = {
  title: 'Tickets guide',
  intro: 'Track every customer issue until it is solved. Keep this open while you work.',
  tasks: [
    {
      title: 'Log a new ticket',
      steps: [
        'Open Tickets and click New ticket.',
        'Write a Subject, for example Order #1042 arrived damaged, and a Category if you use them.',
        'Pick a Priority - each one shows how many hours you have to respond (the SLA).',
        'Choose an Assignee, or leave it Unassigned.',
        'Under Customer, search a name or phone and pick the person so you can reply on WhatsApp.',
        'Click Create ticket.',
      ],
      tip: 'The customer must be in Contacts first to be linked.',
    },
    {
      title: 'Open tickets from WhatsApp automatically',
      steps: [
        'Click WhatsApp settings at the top.',
        'Turn on Open a ticket from the chat - a ticket opens when a customer asks for a person.',
        'Under Words that open a ticket, type words like complaint, refund, not working and click Save words.',
        'Further messages from the same customer join their open ticket.',
      ],
    },
    {
      title: 'Get alerts on your phone',
      steps: [
        'Click WhatsApp settings.',
        'Turn on Alert me on WhatsApp.',
        'You get a message for each new WhatsApp ticket and when a ticket passes its response time.',
      ],
    },
    {
      title: 'Find a ticket',
      steps: [
        'Type in Search reference, subject, category.',
        'Use the Status, Priority and Assignee lists to narrow the queue.',
        'Click the Overdue SLA or Waiting on customer box at the top to show just those.',
        'Click Clear to see the whole queue again.',
      ],
    },
    {
      title: 'Work on a ticket',
      steps: [
        'Click a ticket to open its details.',
        'The bar at the top shows how much response time is left.',
        'Change the Status, Priority or Assignee from the lists.',
        'When you mark it Resolved or Closed, tick Tell the customer on WhatsApp if you want them to know, then confirm.',
      ],
    },
    {
      title: 'Reply to the customer',
      steps: [
        'Open a ticket that has a customer linked.',
        'Read the chat under Conversation.',
        'Type in Reply on WhatsApp and click Send.',
      ],
      tip: 'If your plan does not include replying from tickets, reply from the Inbox instead.',
    },
    {
      title: 'Add an internal note',
      steps: [
        'Open the ticket.',
        'Type what happened or what was promised under Internal note.',
        'Click Add note. Notes are for your team only - the customer never sees them.',
        'Every change and note shows in the Timeline.',
      ],
    },
    {
      title: 'Rate how it went',
      steps: [
        'Open a resolved or closed ticket.',
        'Click the stars under Customer satisfaction.',
      ],
    },
    {
      title: 'Read your numbers',
      steps: [
        'Active shows open tickets out of the total.',
        'Overdue SLA shows tickets past their response time.',
        'Waiting on customer shows tickets waiting for a reply from them.',
        'Median resolve shows how long tickets usually take to solve.',
      ],
    },
  ],
};
