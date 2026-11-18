import type { Guide } from '../guides';

export const home: Guide = {
  title: 'Home guide',
  intro: 'Your plan, your limits and your latest campaigns at a glance.',
  tasks: [
    {
      title: 'Answer the 2 questions for a new number',
      steps: [
        'If a card asks Answer 2 questions to start sending, pick How old is this number on WhatsApp?',
        'Then pick How often do you use WhatsApp on this number?',
        'Click Start sending. The card shows how many messages a day the number can send.',
        'Click Done to hide the card.',
      ],
      tip: 'Honest answers set a safe start for the number and lower the risk of a ban. Bulk sending waits until they are answered.',
    },
    {
      title: 'Answer questions you skipped',
      steps: [
        'A skipped number shows Answer the 2 questions you skipped on Home.',
        'Pick the two answers and click Start sending.',
      ],
      tip: 'A skipped number starts at your plan\'s full day, which is riskier for a new number.',
    },
    {
      title: 'Check how much of your plan you have used',
      steps: [
        'Look at Plan usage - your plan name and current period are at the top right.',
        'Each bar shows what you used out of your limit, for example Messages today or Contacts.',
        'Open More limits to see the rest, such as Templates, Team members and Storage.',
      ],
      tip: 'A bar turns warning colour as you near a limit. Unlimited means there is no cap; Not on your plan means you need a bigger plan.',
    },
    {
      title: 'Ask for a higher limit',
      steps: [
        'In Plan usage, click Request more.',
        'Pick the Limit, type the New limit and choose a Duration.',
        'Click Add another limit to ask for more than one at once.',
        'Optionally say Why do you need it?, then click Send request.',
      ],
      tip: 'The answer shows on Home next to Your limit request - click View to see it.',
    },
    {
      title: 'See your earlier limit requests',
      steps: [
        'Click Request more (or View next to your latest request).',
        'Scroll to Earlier requests to see each one, its status and how long a raised limit lasts.',
      ],
    },
    {
      title: 'See your campaign totals',
      steps: [
        'The row of numbers shows Campaigns, Running now, Messages sent and Failed.',
        'They update as your campaigns send.',
      ],
    },
    {
      title: 'Open a recent campaign',
      steps: [
        'Under Recent campaigns, click a campaign to open its live progress.',
        'Click View all to go to the full Campaigns list.',
      ],
    },
    {
      title: 'Start a new campaign',
      steps: [
        'Click New campaign at the top right of Home.',
        'Follow the steps to pick recipients, write the message and send.',
      ],
    },
  ],
};
