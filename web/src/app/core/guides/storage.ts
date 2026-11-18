import type { Guide } from '../guides';

export const storage: Guide = {
  title: 'Storage guide',
  intro: 'Every file you have uploaded, ready to reuse.',
  tasks: [
    {
      title: 'See how much space you use',
      steps: [
        'Open Storage.',
        'The top shows your Files count and Space used, and how much your plan allows.',
        'The bar splits the space between Contact lists and Attachments.',
      ],
      tip: 'Uploading the same file again reuses the stored copy, so it does not take extra space.',
    },
    {
      title: 'Find a file',
      steps: [
        'Click All, Contact lists or Attachments to filter.',
        'Type in Search files to find one by name.',
        'Use the arrows at the bottom to move between pages.',
      ],
    },
    {
      title: 'Send a campaign to a stored contact list',
      steps: [
        'Find the contact list (a CSV or Excel file you uploaded before).',
        'Click Use in campaign.',
        'A new campaign opens with that list already chosen - write the message and send.',
      ],
    },
    {
      title: 'Download a file',
      steps: [
        'Find the file and click Download.',
      ],
    },
    {
      title: 'Delete a file',
      steps: [
        'Click the bin button on the file.',
        'Click Delete? to confirm.',
      ],
      tip: 'Each card shows how many times the file was used, so you can clear out ones you never use.',
    },
    {
      title: 'See the latest files',
      steps: [
        'Click Refresh at the top right to load files uploaded since you opened the page.',
      ],
    },
  ],
};
