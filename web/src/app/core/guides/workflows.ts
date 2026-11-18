import type { Guide } from '../guides';

export const workflows: Guide = {
  title: 'Workflows guide',
  intro: 'Set up automations that message, tag and route your contacts on their own.',
  tasks: [
    {
      title: 'Install your first workflow from a recipe',
      steps: [
        'Open Workflows and switch to the Recipe gallery tab.',
        'Recipes are grouped by industry - read the description and the tags to see what each one needs.',
        'Click Install on the recipe you want.',
        'Give it a Name (optional) and turn on Activate now if it should start at once.',
        'Click Install. It opens in My workflows, with any templates it needs created for you.',
      ],
      tip: 'Left off, Activate now installs the workflow as a draft so you can check it first.',
    },
    {
      title: 'Turn a workflow on or off',
      steps: [
        'Open the My workflows tab.',
        'Click Activate on a draft or paused workflow to start it.',
        'Click Pause on an active workflow to stop it for now.',
      ],
    },
    {
      title: 'See what a workflow does',
      steps: [
        'In My workflows, click the arrow at the end of a row.',
        'Flow shows the trigger (When:) and each step in order.',
        'The row itself shows the trigger, the number of steps, the version and when it was last updated.',
      ],
    },
    {
      title: 'Check recent runs and retry a failed one',
      steps: [
        'Open a workflow\'s details with the arrow on its row.',
        'Recent runs lists each time it ran and its status; click the refresh button to update.',
        'Click a run to see each step and any error.',
        'For a Failed run, fix the cause and click Retry.',
      ],
      tip: 'No runs yet? Runs appear once the trigger fires, and only while the workflow is active.',
    },
    {
      title: 'Find a workflow',
      steps: [
        'In My workflows, use the chips All, Active, Paused or Draft to filter the list.',
        'The count on each chip shows how many are in that state.',
      ],
    },
    {
      title: 'Delete a workflow',
      steps: [
        'In My workflows, click the bin button on the row.',
        'Click Yes to confirm, or No to keep it.',
      ],
    },
  ],
};
