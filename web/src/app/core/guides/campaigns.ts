import type { Guide } from '../guides';

export const campaigns: Guide = {
  title: 'Campaigns guide',
  intro: 'Everything you can do with campaigns, step by step. Keep this open while you work.',
  tasks: [
    {
      title: 'Send your first campaign',
      steps: [
        'Open Campaigns and click New campaign.',
        'Who: choose where the recipients come from - your contacts (a saved segment or tags) or a CSV / Excel file.',
        'Message: write the message. Tap a field such as {name} to fill each person\'s own details.',
        'When & send: pick Send right away or a later date and time.',
        'Check the summary under Last look before it goes out, then click the send button.',
      ],
      tip: 'Messages go out at a safe pace to protect your number, so a large list takes a while.',
    },
    {
      title: 'Send to people from an Excel or CSV file',
      steps: [
        'In New campaign, step Who, drop your CSV or Excel file on Drop a CSV or Excel file here.',
        'Under Columns in your file, tell us which column is the Phone number and which is the Recipient name.',
        'Set the Country code if your numbers are written without it.',
        'Any other column can be used in the message: Add a column and pick it in the message as a field.',
        'Open See skipped rows to find numbers that could not be read, fix them in the file and click Replace file.',
      ],
    },
    {
      title: 'Send to a group of your contacts',
      steps: [
        'In step Who, choose your contacts.',
        'Pick a Saved segment, or None - choose by tags instead.',
        'Under Send to people who, choose Has any of these tags or Has all of these tags.',
        'Use Leave out anyone with to skip a tag, for example people who already bought.',
        'The count at the top updates as you change the choice.',
      ],
      tip: 'Save the group as a segment on the Contacts page to reuse it next time.',
    },
    {
      title: 'Write a good message',
      steps: [
        'Start from a template with Use a saved template, or write the message yourself.',
        'Add each person\'s details with fields like {name}; set a Value for every row for people who have none.',
        'Attach a photo, PDF or video if it helps.',
        'Use Add buttons for quick replies; Auto-reply when someone taps a button answers them for you.',
        'Watch the phone preview on the right - it shows what each person gets.',
        'Click Send a test to my number to see it on your own phone first.',
      ],
      tip: 'Short, personal messages with the customer\'s name get more replies and fewer blocks.',
    },
    {
      title: 'Schedule a campaign for later',
      steps: [
        'In step When & send, choose Later.',
        'Pick the Date, the Time and check the Time zone.',
        'Finish the steps and confirm - the campaign shows as Scheduled in the list.',
        'Open it from Campaigns any time before it starts to check or cancel it.',
      ],
    },
    {
      title: 'Spread a big list over several days',
      steps: [
        'In step When & send, turn on Spread over several days.',
        'Pick the From and To dates and the Daily start time.',
        'The summary shows how many go each day and when it Finishes around.',
      ],
      tip: 'Spreading keeps each day within your number\'s safe daily limit.',
    },
    {
      title: 'Repeat a campaign every day, week or month',
      steps: [
        'In step When & send, find Repeat.',
        'Choose Every day, Every week or Every month (Don\'t repeat sends it once).',
        'Each run sends to the same audience; the campaign page shows its Next run and Previous run.',
        'To stop the repeats, open the campaign and stop it.',
      ],
    },
    {
      title: 'Send one quick message',
      steps: [
        'On New campaign, switch the tab at the top to Quick single message.',
        'Type the number and the message, and send.',
      ],
      tip: 'Use this for one person; use the Composer for a list.',
    },
    {
      title: 'Follow a campaign while it sends',
      steps: [
        'Open Campaigns and click the campaign (or Open campaign).',
        'The top shows how many are Sent, Delivered, Read and Replied, updating live.',
        'How it went compares this campaign with your earlier ones.',
        'Button clicks shows which buttons people tapped.',
        'Failures by reason lists the numbers that did not get it, and why.',
      ],
    },
    {
      title: 'Pause, resume or cancel',
      steps: [
        'Open the campaign from Campaigns.',
        'Click Pause to hold it; click Resume when you are ready to carry on.',
        'To end it, click Stop sending the rest, then click again to confirm. People who already got it keep their message.',
      ],
      tip: 'A campaign held by a daily limit carries on by itself the next day.',
    },
    {
      title: 'Follow up with people who did not reply',
      steps: [
        'Open a campaign that has sent, and scroll to Follow up.',
        'Click a Send to: button - for example the people who read it but did not reply.',
        'A new campaign opens with those people already chosen: write the follow-up and send it.',
      ],
      tip: 'Anyone who opted out is left out automatically.',
    },
    {
      title: 'Find a campaign',
      steps: [
        'On Campaigns, use the status chips (Scheduled, Running, Finished...) to filter the list.',
        'Click Refresh to update the numbers.',
        'Drafts you left half-way show as Saved, but not started - open one to carry on.',
      ],
    },
  ],
};
