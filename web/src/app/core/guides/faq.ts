import type { Guide } from '../guides';

export const faq: Guide = {
  title: 'FAQ guide',
  intro: 'Teach the bot to answer common customer questions on its own. Keep this open while you work.',
  tasks: [
    {
      title: 'Add a question and answer',
      steps: [
        'Open FAQ and click Add question.',
        'Type the Question, for example What are your opening hours?',
        'Under Alternate phrasings / keywords, add other ways people ask it, separated by commas.',
        'Write the Answer the bot should send.',
        'Pick a Category if you like, keep Live ticked and click Add question.',
      ],
      tip: 'More keywords mean the bot catches more ways of asking the same thing.',
    },
    {
      title: 'Start from a ready-made pack',
      steps: [
        'Open the Add many tab.',
        'Under Start from a pack, click the one for your business, for example Shop / retail or Clinic / doctor.',
        'In Check before adding, untick any you do not want and edit the answers.',
        'Click Add ... questions.',
      ],
      tip: 'Answers with [details] to fill in are added paused. Fill them in, then switch them live.',
    },
    {
      title: 'Paste or upload many questions',
      steps: [
        'Open the Add many tab.',
        'Under Paste or upload, type one per line as Question | Answer | Category (category is optional).',
        'Or click Upload CSV or Excel - the sheet needs question and answer columns.',
        'Click Preview, check the list, then click Add ... questions.',
      ],
    },
    {
      title: 'Edit, pause or delete an answer',
      steps: [
        'On the Questions tab, find it with Search questions, answers, keywords or the category list.',
        'Use the switch on a card to pause it or make it live again.',
        'Click Edit to change it, then Save changes.',
        'Click the bin and confirm Delete to remove it.',
      ],
    },
    {
      title: 'Choose how a question is matched',
      steps: [
        'Open the question with Edit.',
        'Under Match, pick contains, exact, similarity, regex or fallback - the hint below explains each.',
        'Set a Priority to decide which answer wins when two match.',
        'Tick After-hours answer for a reply meant for when you are closed.',
        'Click Save changes.',
      ],
      tip: 'Use fallback for one catch-all answer at most.',
    },
    {
      title: 'Group answers into categories',
      steps: [
        'Open the Categories tab.',
        'Type a name, for example Pricing, and click Add.',
        'Use the arrows to change the order, the pencil to rename, or the bin to delete.',
        'Click a category to see its questions.',
      ],
      tip: 'Deleting a category keeps its questions.',
    },
    {
      title: 'Test what the bot would reply',
      steps: [
        'Open the Test tab.',
        'Type a Customer message, for example what time do you open on sunday?',
        'Tick Ignore business hours if needed, then click Run test.',
        'See which answer matched and how close it was, or click Create FAQ from this if nothing did.',
      ],
      tip: 'This is a dry run - nothing is sent.',
    },
    {
      title: 'Fill the gaps',
      steps: [
        'Open the Gaps tab.',
        'Questions nothing answered lists what customers asked that the bot could not answer, most-asked first.',
        'Click Create FAQ to answer one, or the x to dismiss it.',
        'Under Near misses, click Widen to add keywords to answers that almost fired.',
      ],
    },
    {
      title: 'Decide what happens when nothing answers',
      steps: [
        'Open the Gaps tab and find When nothing answers.',
        'Write a Reply to the customer, or leave it empty to stay silent.',
        'Tick Message the owner on WhatsApp with the question if you want to be told.',
        'Click Save.',
      ],
      tip: 'The reply goes at most once an hour to the same customer.',
    },
  ],
};
