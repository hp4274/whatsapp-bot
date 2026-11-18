import type { Guide } from '../guides';

export const events: Guide = {
  title: 'Events guide',
  intro: 'Keep your workshops, classes and other events in one list.',
  tasks: [
    {
      title: 'Add an event',
      steps: [
        'Open Events and click New event.',
        'Fill in Title and Starts at - both are needed. Add Ends at, Venue, Capacity and Notes if you like.',
        'Pick a contact under Customer if the event is for one person.',
        'Leave Reference blank to get one made for you, pick a Status and click Create event.',
      ],
      tip: 'Keep it as Draft while you plan, and set it to Published when it is on.',
    },
    {
      title: 'Update an event',
      steps: [
        'Click the event in the list to open it.',
        'Change the time, Venue or Capacity, or the Status - Draft, Published, Full, Completed or Cancelled.',
        'Click Save changes.',
      ],
    },
    {
      title: 'See what happened to an event',
      steps: [
        'Open the event from the list.',
        'Scroll to Activity at the bottom of the panel.',
        'It lists when it was created, each status change and each edit, newest first.',
      ],
    },
    {
      title: 'Find an event',
      steps: [
        'Use the status chips (All, Draft, Published...) to show one status; each chip shows its count.',
        'Type in Search events to find a reference, a title, a venue or any detail.',
        'If nothing shows, click Clear filters.',
      ],
    },
    {
      title: 'Delete an event',
      steps: [
        'Open the event and click Delete.',
        'Click Delete again to confirm, or Keep to go back.',
      ],
      tip: 'Deleting cannot be undone. Setting the status to Cancelled keeps the record.',
    },
  ],
};
