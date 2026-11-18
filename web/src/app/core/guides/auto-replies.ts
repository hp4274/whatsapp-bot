import type { Guide } from '../guides';

export const autoReplies: Guide = {
  title: 'Auto-replies guide',
  intro: 'Set up replies that answer your customers on WhatsApp by themselves.',
  tasks: [
    {
      title: 'Turn auto replies on or off',
      steps: [
        'Open Auto-replies and stay on the Basics tab.',
        'Under System replies, flip the Auto replies on / Auto replies off switch.',
        'Fill in your Business name - replies can show it as {business_name}.',
      ],
    },
    {
      title: 'Welcome new customers',
      steps: [
        'On Basics, find the Welcome card and click Configure.',
        'Turn on Enabled and write the Message. Add a photo or file if you like.',
        'Set Send at most once every ... hours per contact so nobody gets it twice.',
        'Click Save.',
      ],
    },
    {
      title: 'Reply when you are closed',
      steps: [
        'On Basics, click Configure on the Away / hours card.',
        'Turn on Enabled and write the Message customers get after hours.',
        'Under Business hours, switch each day on and set when you open and close.',
        'Add Holidays: pick a date and press Enter.',
        'Click Save.',
      ],
    },
    {
      title: 'Answer when nothing else matched',
      steps: [
        'On Basics, click Configure on the Default fallback card.',
        'Write the Message, for example how to reach you.',
        'Set Only once per ... hours per contact (0 = every time).',
        'Optionally set Hand over to a person on the ... message the bot does not understand.',
        'Click Save.',
      ],
    },
    {
      title: 'Hand a chat to a person',
      steps: [
        'On Basics, click Configure on the Human handoff card and turn on Enabled.',
        'Add Trigger keywords such as agent or talk to someone.',
        'Write the Confirmation message the customer gets.',
        'Set how many hours the bot stays quiet in that chat after a handoff, then click Save.',
      ],
      tip: 'When you reply to a customer from your phone, the bot also stays quiet in that chat for the same time.',
    },
    {
      title: 'Set reply speed and language',
      steps: [
        'On Basics, open Reply speed and language.',
        'Set Reply after ... seconds and At most ... replies per contact an hour.',
        'Under Reply language, choose The customer\'s language or Always one language.',
        'For mixed messages, set Hinglish / Gujlish to Answer in kind or Prefer Hindi / Gujarati.',
      ],
    },
    {
      title: 'Add ready-made keyword replies',
      steps: [
        'Open the Keyword replies tab and click Templates.',
        'Pick a set for your kind of business.',
        'Tick the rules you want and click Add ... rules, or Edit before adding to change one first.',
        'Rules marked Starts off need your details filled in - open them, fill in the [details] and switch them on.',
      ],
    },
    {
      title: 'Create a keyword reply',
      steps: [
        'On Keyword replies, click New rule and name it.',
        '1 Trigger: choose how to match (Contains, Exact, Fuzzy, Intent...) and type the keywords. Press Enter or a comma after each.',
        '2 Reply: write the answer. Add a photo or file, and Other languages if you like.',
        '3 Buttons & menu and 4 Ask questions are optional - add them if needed.',
        '5 When & who: limit it to certain times, or to Everyone, New contacts or Tagged.',
        'Click Create rule. Check the preview on the right as you go.',
      ],
      tip: 'Fuzzy finds typos (prise finds price), and Intent understands meanings in English, Hinglish, Hindi or Gujarati.',
    },
    {
      title: 'Collect details with questions',
      steps: [
        'In a rule, go to 4 Ask questions and click Add a question.',
        'Type the question, pick the answer type (Name, Phone number, Email...) and the contact field to save it to.',
        'Write the message sent After the last answer.',
        'Click Save changes.',
      ],
      tip: 'Customers can reply EXIT to stop the questions. STOP or CANCEL unsubscribes them.',
    },
    {
      title: 'Tag customers who trigger a rule',
      steps: [
        'In a rule, go to 6 Actions.',
        'Type a tag in Add tag to contact, or a key and value in Set contact field.',
        'Tick Stop further rules after this one fires if no other rule should answer.',
        'Click Save changes.',
      ],
    },
    {
      title: 'Change the order, pause or delete rules',
      steps: [
        'Rules run top to bottom; the first match wins. Drag a rule or use the arrows to move it.',
        'Flip the switch on a rule to turn it off without deleting it.',
        'To delete, open the rule, click Delete, then Delete again to confirm.',
      ],
    },
    {
      title: 'Test your replies safely',
      steps: [
        'Open the Try it tab.',
        'Type a Message as a customer would, and set Sender name or First-time contact if needed.',
        'Run the test and see exactly what goes back. Nothing is sent and stats are not counted.',
        'Tap a button in the reply to test menus. Use the reset button to start the menu again.',
      ],
    },
    {
      title: 'See what customers ask and fix gaps',
      steps: [
        'Open the Reports tab and pick Last 7 days, 30 days or 90 days.',
        'Hot keywords shows what customers ask most.',
        'Under Asked, but nothing answered, click Add a reply to make a rule for that question.',
        'Where customers left shows the menu or question step people stop at.',
      ],
    },
    {
      title: 'Check what the bot did with each message',
      steps: [
        'Open the Activity tab.',
        'Filter by All, Replied, No reply, Skipped or Failed.',
        'Each row shows the message, the reply and why the bot stayed quiet when it did.',
      ],
      tip: 'Activity is kept for 30 days.',
    },
  ],
};
