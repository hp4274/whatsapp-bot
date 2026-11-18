import type { Guide } from '../guides';

export const whatsapp: Guide = {
  title: 'WhatsApp guide',
  intro: 'Link your WhatsApp numbers, keep them healthy and set when they may send.',
  tasks: [
    {
      title: 'Link your WhatsApp number with a QR code',
      steps: [
        'Open WhatsApp and click Link WhatsApp on your number\'s card.',
        'On your phone, open WhatsApp and go to Settings > Linked devices > Link a device.',
        'Point the camera at the code on the screen. It links in a few seconds.',
        'If the code runs out of time, click Get a new code and scan again.',
        'Once linked, the card shows Linked as your name and Ready to send.',
      ],
      tip: 'No WhatsApp Business account is needed. Keep your phone on and online.',
    },
    {
      title: 'Answer the 2 questions to start sending',
      steps: [
        'After linking, a popup asks Answer 2 questions to start sending (or click Answer 2 questions on the card).',
        'Pick How old is this number on WhatsApp? and How often do you use WhatsApp on this number?',
        'Click Start sending.',
        'The card then shows how many messages a day the number may send, and how high it will rise.',
      ],
      tip: 'An older, busier number can safely send more from day one. Skipping the questions raises the risk of a ban.',
    },
    {
      title: 'Add another number',
      steps: [
        'Click Add number at the top.',
        'Give it a Name your team will recognise, for example Sales line, and add the Phone number if you like.',
        'Check the time zone shown (change it under Advanced if needed).',
        'Click Add number, then link it with Link with QR code on its card.',
      ],
      tip: 'If you do not see Add number, your plan line shows how many numbers your plan includes.',
    },
    {
      title: 'Switch between your numbers',
      steps: [
        'The top strip shows how many numbers you have, how many are connected and sent today.',
        'The open card is the Selected number; your other numbers show as small cards below.',
        'Click Use this number on another card to open it.',
        'Look for the Recommended badge - it marks the best number to send on right now.',
      ],
    },
    {
      title: 'Check today\'s sending and health',
      steps: [
        'On a number\'s card, Today shows how many messages went out against today\'s limit.',
        'The Health score out of 100 drops when messages fail, people opt out or the day is used up.',
        'Under Ban protection, How your number is doing explains Why sending is slower right now.',
        'Open Details for today\'s counts, tips to make a new number look trusted, and Blocks and reports.',
        'Click Refresh to update the figures.',
      ],
      tip: 'Daily sending grows as people reply. Blocks and reports pause a campaign for you.',
    },
    {
      title: 'Set the hours a number may send',
      steps: [
        'On the number\'s card, open Advanced and find Sending hours.',
        'Choose Set hours, then pick the Days (or Weekdays / Every day).',
        'Set From and Until and check the Timezone.',
        'Click Save hours. Messages outside these hours wait until they start.',
        'To go back, click Send any time.',
      ],
    },
    {
      title: 'Choose what a number can send',
      steps: [
        'Open Advanced on the number\'s card.',
        'Under What this number can send, switch each message type on or off.',
        'Use All on or All off to change them all at once.',
      ],
      tip: 'Message types switched off here are never sent from that number.',
    },
    {
      title: 'Rename, set the main number, pause or delete',
      steps: [
        'Click the pencil next to the name or phone number to edit it, then the tick to save.',
        'Open Advanced > Manage and click Make main number to use it when nothing picks a number.',
        'Click Pause number to stop all sending; it unlinks the number, so you scan a new QR code to resume.',
        'Click Delete, then Delete number to remove it. Its message history stays.',
      ],
      tip: 'Your only number cannot be deleted.',
    },
    {
      title: 'Unlink or link a number again',
      steps: [
        'On a linked number, click Unlink number to sign it out.',
        'If a card says Lost connection to WhatsApp, link it again with a QR code.',
        'Click Link WhatsApp (or Link with QR code on a small card) and scan the new code.',
      ],
    },
    {
      title: 'Open your WhatsApp Business catalog',
      steps: [
        'On a linked WhatsApp Business number, click Catalog.',
        'Search products or pick a collection, and click Refresh to read the latest from WhatsApp.',
        'Tick the products you want and click Add to my Orders list.',
        'On a regular WhatsApp number, Catalog shows a lock: follow the steps and click Link a WhatsApp Business number.',
      ],
      tip: 'Add or change products in the WhatsApp Business app under Settings > Business tools > Catalog, then refresh here.',
    },
    {
      title: 'Change the sending limits',
      steps: [
        'Under Ban protection, open Advanced: sending limits.',
        'Click Change limits, read the warning, type your full name and I ACCEPT, then click Accept and continue.',
        'Change the values (risky ones are flagged in red) and click Save limits.',
        'To undo, click Go back to our standard limits, then click again to reset.',
      ],
      tip: 'Our standard limits keep your number safe. Turning off ban protection is how numbers get banned.',
    },
    {
      title: 'If WhatsApp bans your number',
      steps: [
        'Scroll to If WhatsApp bans your number and click Show the steps.',
        'A temporary ban shows a countdown in WhatsApp - wait it out and do not reinstall.',
        'On the phone, tap Request a review and explain your customers opted in.',
        'If that fails, use WhatsApp\'s contact form, and pause sending while the review runs.',
      ],
      tip: 'WhatsApp decides every appeal. This app cannot unban a number.',
    },
  ],
};
