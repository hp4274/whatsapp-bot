import type { Guide } from '../guides';

export const leads: Guide = {
  title: 'Leads guide',
  intro: 'Keep track of people who might buy, and follow them up on time.',
  tasks: [
    {
      title: 'Make a lead from every new person who messages',
      steps: [
        'Open Leads.',
        'Turn on the switch on Make a lead from every new person who messages.',
        'From then on, each new person\'s name, number and first message are saved here as a new lead, once per person.',
      ],
      tip: 'If the card shows a lock, this is not part of your plan - add leads by hand instead.',
    },
    {
      title: 'Add a lead by hand',
      steps: [
        'Click New lead.',
        'Under Customer, search your contacts by name or number and pick the person, if they are in your contacts.',
        'Fill in what you know: Name, Phone, Source, Interest, Value, Assigned to, Follow up at and Notes.',
        'Leave Reference blank to get one made for you, and pick a Status.',
        'Click Create lead.',
      ],
    },
    {
      title: 'Move a lead along',
      steps: [
        'Click the lead in the list to open it.',
        'Change the Status - New, Contacted, Qualified, Converted or Lost.',
        'Set Follow up at for the next time to get in touch, and add Notes about the talk.',
        'Click Save changes.',
      ],
      tip: 'Converted and Lost close the lead; the others count as open.',
    },
    {
      title: 'See what happened to a lead',
      steps: [
        'Open the lead from the list.',
        'Scroll to Activity at the bottom of the panel.',
        'It lists when it was created, each status change and each edit, newest first.',
      ],
    },
    {
      title: 'Find a lead',
      steps: [
        'Use the status chips (All, New, Contacted...) to show one status; each chip shows its count.',
        'Type in Search leads to find a reference, a name, a number or any detail such as the interest.',
        'If nothing shows, click Clear filters.',
      ],
    },
    {
      title: 'Delete a lead',
      steps: [
        'Open the lead and click Delete.',
        'Click Delete again to confirm, or Keep to go back.',
      ],
      tip: 'Deleting cannot be undone. Setting the status to Lost keeps the record.',
    },
  ],
};
