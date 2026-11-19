import type { Guide } from '../guides';

export const templates: Guide = {
  title: 'Templates guide',
  intro: 'Save the messages you send again and again, and reuse them in campaigns.',
  tasks: [
    {
      title: 'Create a template',
      steps: [
        'Open Templates and click New template.',
        'Give it a Name, for example order_shipped.',
        'Write the Message. Use B, I, S and the code button to format text.',
        'Click Variable to add a field like {name} that fills in for each person.',
        'Check the Live preview on the right, then click Save.',
      ],
      tip: 'Write {key|fallback} to show a fallback word when a contact has no value, for example {name|there}.',
    },
    {
      title: 'Start from a ready-made template',
      steps: [
        'Click Start from library.',
        'Find a message that fits and click Copy into my templates.',
        'It is added to your list - open it with the pencil button to reword it before sending.',
      ],
    },
    {
      title: 'Add a photo, video or PDF',
      steps: [
        'In the template, under Header media, click Upload image, video or PDF.',
        'Pick the file. It shows in the preview once uploaded.',
        'Click Remove to take it off.',
      ],
      tip: 'Already uploaded the file before? Under Advanced, paste its media id in Reuse a file you uploaded before and click Attach.',
    },
    {
      title: 'Add buttons or a menu',
      steps: [
        'Under Buttons, pick Quick replies, Call to action or List menu (None keeps a plain message).',
        'Quick replies: click Add quick reply and type each Button title.',
        'Call to action: click Add action and choose Visit website, Call number or Copy code.',
        'List menu: set the Menu button text, then click Add option for each choice.',
        'Use the arrows to reorder and the x to remove one.',
      ],
      tip: 'Buttons and menus are sent as real WhatsApp buttons. A few phones may not show them.',
    },
    {
      title: 'Preview a template as a real contact',
      steps: [
        'In the editor, find Preview as a contact under the phone preview.',
        'Search a name or number and pick the contact.',
        'The preview shows exactly what they get, and warns if they are missing a field.',
        'Click the x to go back to the example values.',
      ],
      tip: 'Under Advanced, Example values set what the preview shows for each field. They are never sent.',
    },
    {
      title: 'Sort templates by type and category',
      steps: [
        'In the editor, open Advanced.',
        'Pick a Type and a Category (Marketing, Utility or Authentication).',
        'Click Save.',
      ],
      tip: 'Type and category only help you sort and filter. They do not change how the message is sent.',
    },
    {
      title: 'Find a template',
      steps: [
        'Click a category on the left (or All) to filter the list.',
        'Type in Search by name or wording.',
        'Use the type chips (Any type, Text, Media...) to narrow it further.',
        'Click Clear filters if nothing matches.',
      ],
    },
    {
      title: 'Use a template in a campaign',
      steps: [
        'On the template card, click Use (or Use in campaign inside the editor).',
        'A new campaign opens with the message filled in - pick who gets it and send.',
      ],
      tip: 'The card shows how many times it was sent and when it was last used.',
    },
    {
      title: 'Edit a template',
      steps: [
        'Click the pencil button on the template card.',
        'Change what you need and click Save.',
        'Each save keeps the old wording as a version you can go back to.',
      ],
    },
    {
      title: 'Go back to an older version',
      steps: [
        'Click History on the template card.',
        'Find the version you want and click Restore.',
      ],
    },
    {
      title: 'Fix a template waiting for review or rejected',
      steps: [
        'A Pending review template cannot be sent until it is approved.',
        'A Rejected template shows the reason on its card.',
        'Open it with the pencil, change the wording and click Save to send it for review again.',
      ],
    },
    {
      title: 'Delete a template',
      steps: [
        'Click the bin button on the template card.',
        'Click Delete to confirm, or Keep to cancel. Its history is deleted too.',
      ],
    },
  ],
};
