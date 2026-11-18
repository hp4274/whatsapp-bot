import type { Guide } from '../guides';

export const team: Guide = {
  title: 'Team guide',
  intro: 'Choose who can sign in to your workspace and what they may do.',
  tasks: [
    {
      title: 'Add a teammate',
      steps: [
        'Open Team and find Add a user on the right.',
        'Fill in their Name, Email and a Password of at least 8 characters.',
        'Pick their Role.',
        'Click Add user. Share the email and password with them so they can sign in.',
      ],
      tip: 'Your plan sets how many team members you can have.',
    },
    {
      title: 'Pick the right role',
      steps: [
        'Roles go Agent, then Admin, then Owner.',
        'The Role list only offers roles below your own - an Owner can add Admins and Agents, an Admin can add Agents.',
        'You can only change, disable or remove people with a lower role than yours.',
      ],
    },
    {
      title: 'Change someone\'s email or password',
      steps: [
        'In People, find the person and click Change login.',
        'Edit the Email, or type a New password (leave it blank to keep the old one).',
        'Click Save.',
      ],
      tip: 'A new password signs them out on every device.',
    },
    {
      title: 'Stop someone signing in for a while',
      steps: [
        'In People, click Disable next to the person. Their Status shows Disabled.',
        'Click Enable to let them sign in again.',
      ],
      tip: 'Disabling frees a seat on your plan.',
    },
    {
      title: 'Remove someone from the team',
      steps: [
        'In People, click the bin button next to the person.',
        'Click Remove to confirm.',
        'They are signed out and cannot sign in again. What they did stays in the history.',
      ],
    },
  ],
};
