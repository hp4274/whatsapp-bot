import type { Guide } from '../guides';

export const subscriptions: Guide = {
  title: 'Subscriptions guide',
  intro: 'Keep track of your customers\' plans and when they run out.',
  tasks: [
    {
      title: 'Add a subscription',
      steps: [
        'Open Subscriptions and click New subscription.',
        'Under Customer, search your contacts by name or number and pick the person.',
        'Fill in Plan and Expires at - both are needed. Add Amount, Currency, Starts at and Notes if you like.',
        'Tick Auto renew if the plan renews by itself.',
        'Leave Reference blank to get one made for you, pick a Status and click Create subscription.',
      ],
      tip: 'The customer must be in your contacts first. Add them on the Contacts page if the search finds no one.',
    },
    {
      title: 'Renew or change a subscription',
      steps: [
        'Click the subscription in the list to open it.',
        'Set the new Expires at date, or change the Plan or Amount.',
        'Update the Status - Trial, Active, Past due, Expired or Cancelled.',
        'Click Save changes.',
      ],
    },
    {
      title: 'See what happened to a subscription',
      steps: [
        'Open the subscription from the list.',
        'Scroll to Activity at the bottom of the panel.',
        'It lists when it was created, each status change and each edit, newest first.',
      ],
    },
    {
      title: 'Find a subscription',
      steps: [
        'Use the status chips (All, Active, Past due...) to show one status; each chip shows its count.',
        'Type in Search subscriptions to find a reference, a name, a number or a plan.',
        'If nothing shows, click Clear filters.',
      ],
      tip: 'Click Past due to see who needs a reminder to pay.',
    },
    {
      title: 'Delete a subscription',
      steps: [
        'Open the subscription and click Delete.',
        'Click Delete again to confirm, or Keep to go back.',
      ],
      tip: 'Deleting cannot be undone. Setting the status to Cancelled keeps the record.',
    },
  ],
};
