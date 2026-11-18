import type { Guide } from '../guides';

export const contacts: Guide = {
  title: 'Contacts guide',
  intro: 'Keep your customer list tidy, tagged and ready to message. Keep this open while you work.',
  tasks: [
    {
      title: 'Add one contact by hand',
      steps: [
        'Open Contacts and click Add contact.',
        'Type the Phone, and add a Name and Email if you have them.',
        'Under Tags, type tags separated by commas, for example vip, follow-up.',
        'Open More options to add Extra details, one per line, like doctor=Mehta.',
        'Click Save contact.',
      ],
    },
    {
      title: 'Import contacts from Excel or CSV',
      steps: [
        'Click Import and stay on File.',
        'Drop your file on Drop a CSV or Excel file here. The first row should be column names.',
        'In Map columns, tell us what each column holds: Phone number, Name, Email, Tags, Extra detail or Don\'t import.',
        'Check the preview and any warnings about wrong numbers, then click Continue.',
        'In Tag, add a tag for everyone in the file (or skip it) and click Import.',
        'The Result shows how many are new, updated and invalid. Open Show the skipped rows to see what was left out.',
      ],
      tip: 'A number already in your book is updated, never duplicated.',
    },
    {
      title: 'Paste a list of numbers',
      steps: [
        'Click Import and switch to Paste numbers.',
        'Paste numbers one per line, or any text with numbers in it - a WhatsApp chat, an email or a list from Excel.',
        'Add a Tag if you like, then click Check numbers.',
        'Check how many were found, then click Import.',
      ],
    },
    {
      title: 'Add members of your WhatsApp groups',
      steps: [
        'Click Import, open More options and click From WhatsApp groups.',
        'Search for groups and tick the ones you want, or use Select all.',
        'Click Add to contacts - members are saved and tagged with the group name.',
        'Or click Download CSV to get the members as a file.',
      ],
      tip: 'Your number must be linked by QR. Broadcast lists can\'t be read - only groups and communities.',
    },
    {
      title: 'Find a contact',
      steps: [
        'Type in Search name, number or email.',
        'Use the buttons next to it - Any, Can message, Opted in, Unknown, Opted out, Not on WhatsApp - to filter by consent.',
        'Click a tag under Tags on the left to show only people with that tag.',
        'To filter by an extra detail, pick the detail, type a value and click Filter.',
        'Click Clear to remove all filters. Click a column heading to sort.',
      ],
    },
    {
      title: 'Save a group as a segment',
      steps: [
        'Set the search, tags or detail filter you want.',
        'Under Segments, type a name in Save this view as... and click Save.',
        'Click the segment any time to show those people again; All contacts shows everyone.',
        'To delete one, click the bin next to it and confirm Delete.',
      ],
      tip: 'Segments can be picked as the audience when you send a campaign.',
    },
    {
      title: 'Edit a contact',
      steps: [
        'Click the contact in the list to open their details.',
        'Click Edit name & email, change them and click Save.',
        'Under Tags, type in Add tag... and press Enter, or click the x on a tag to remove it.',
        'Under Extra details, click Add detail, fill in the key and value, then click Save details.',
        'Timeline shows every message sent to and received from this number.',
      ],
    },
    {
      title: 'Opt someone out or back in',
      steps: [
        'Open the contact and use the switch next to Can receive messages.',
        'To opt out, add a Reason (for example replied STOP) and click Opt out.',
        'To opt back in, write how they agreed and click Opt in.',
      ],
      tip: 'Only opt someone back in if they asked to hear from you again. Opted-out people get no messages.',
    },
    {
      title: 'Change many contacts at once',
      steps: [
        'Tick the boxes next to the contacts, or the box at the top to pick the whole page.',
        'To go beyond the page, click Select all ... matching.',
        'In the bar that appears, choose Tag, Untag, Opt out, Opt in, Send campaign, CSV or Delete.',
        'Confirm the action - deleting keeps message history but loses tags and details.',
      ],
      tip: 'To clean your list, filter Not on WhatsApp, select all matching and delete.',
    },
    {
      title: 'Merge duplicate numbers',
      steps: [
        'When a banner says numbers are saved more than once, click Review & merge.',
        'In each group, pick the contact to keep.',
        'Click Merge into kept, or Merge all groups to do them all. Tags and details are combined.',
        'Click Not duplicates to skip a group.',
      ],
    },
    {
      title: 'Send birthday greetings',
      steps: [
        'Click Greetings at the top.',
        'Turn on Send birthday greetings.',
        'Under Contact detail that holds the date, pick the detail with the birthday.',
        'Write the Message - {name} becomes the contact\'s name - and click Save.',
      ],
      tip: 'Greetings go once a year on the day, after 9 am. Dates like 18/11 or 1990-11-18 work.',
    },
    {
      title: 'Export your contacts',
      steps: [
        'Filter the list if you only want some people.',
        'Click Export to download them as a CSV file.',
        'To export only some, select them and click CSV in the bar.',
      ],
    },
  ],
};
