/**
 * The blog's posts, written here rather than fetched: three short guides do not need a CMS.
 * shortcut: move these to the server (or Markdown files) once non-developers write posts.
 * A new post also needs a line in public/sitemap.xml, public/llms.txt and the <noscript> list in index.html.
 *
 * Every claim about Wuzie here must match what the product does today. Linked (QR) numbers send plain text, so
 * no post promises WhatsApp buttons or lists; there are no customer figures, so no post quotes any.
 */

/** One piece of a post's body, in reading order. `example` is a sample WhatsApp message, drawn as a chat bubble. */
export type Block =
  | { readonly kind: 'h2'; readonly text: string }
  | { readonly kind: 'p'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | { readonly kind: 'example'; readonly label: string; readonly text: string };

export interface Post {
  /** The URL segment: `/blog/<slug>`. Never change a published one; links to it would break. */
  readonly slug: string;
  readonly title: string;
  /** The search-result line and the card summary: one sentence, under ~160 characters. */
  readonly description: string;
  /** ISO date, YYYY-MM-DD. */
  readonly published: string;
  readonly topic: string;
  /** The card's tint, from the landing page's tones. */
  readonly tone: 'blue' | 'green' | 'violet';
  readonly body: readonly Block[];
}

export const POSTS: readonly Post[] = [
  {
    slug: 'bulk-whatsapp-messages-customers-want',
    title: 'Bulk WhatsApp messages your customers will want to read',
    description:
      'Permission, one clear point, the right name and a sensible rhythm: how a small business sends bulk WhatsApp messages people are glad to get.',
    published: '2026-11-13',
    topic: 'Bulk messaging',
    tone: 'blue',
    body: [
      {
        kind: 'p',
        text: 'WhatsApp is where your customers talk to friends and family. A message from a business lands in the same list, so it has to earn its place. The good news is that the habits that keep customers happy are the same ones that keep your number in good standing.',
      },
      { kind: 'h2', text: 'Message people who asked to hear from you' },
      {
        kind: 'p',
        text: 'Start with customers who gave you their number for this: they bought from you, booked with you or signed up for updates. Say so when you collect the number, for example at the till or on your order form: “We’ll send order updates and the occasional offer on WhatsApp.”',
      },
      {
        kind: 'p',
        text: 'Do not buy lists or copy numbers out of WhatsApp groups. People who never heard of you are the ones most likely to block or report the message, and that is what puts a number at risk.',
      },
      { kind: 'h2', text: 'Make each message about one thing' },
      {
        kind: 'p',
        text: 'One offer, one reminder or one piece of news. Put the point in the first line, because the notification and the chat list only show the start of a message. If it needs a second paragraph, it may be two messages on two different days.',
      },
      {
        kind: 'example',
        label: 'One point, said first',
        text: 'Hi Priya, our winter sale starts Friday: 20% off every kurta until Sunday. Reply STOP if you would rather not get offers from us.',
      },
      { kind: 'h2', text: 'Use their name, and only data you trust' },
      {
        kind: 'p',
        text: 'A message with the person’s name, their order number or their appointment time reads like it was written for them, because it was. Fill those fields from your own records. A wrong name is worse than no name, so check the column before you send.',
      },
      { kind: 'h2', text: 'Pick a rhythm and keep to it' },
      {
        kind: 'p',
        text: 'Decide how often you will write before you start, such as one offer a fortnight plus order and appointment updates, and stick to it. Customers learn what to expect from you. A sudden run of messages after months of silence feels like spam even when every message is genuine.',
      },
      {
        kind: 'p',
        text: 'Send in the daytime, when people can read and answer. Wuzie holds bulk messages until it is daytime for each person on the list, so a campaign you schedule at night does not wake anyone.',
      },
      { kind: 'h2', text: 'Make it easy to say no' },
      {
        kind: 'p',
        text: 'End offers with a simple way out, such as “Reply STOP”, and remove anyone who uses it before your next campaign. A customer who leaves your list politely is far better for you than one who presses Block.',
      },
      { kind: 'h2', text: 'Before you press send' },
      {
        kind: 'list',
        items: [
          'Everyone on the list gave you their number for messages like this one.',
          'The first line says what the message is about.',
          'Names and other fields come from a column you have checked.',
          'There is a clear way to stop getting messages.',
          'Someone on your team will be there to answer the replies.',
        ],
      },
    ],
  },
  {
    slug: 'keep-your-whatsapp-number-safe',
    title: 'How to keep your WhatsApp number safe when you send in bulk',
    description:
      'Why numbers get restricted, and the habits that lower the risk: starting slowly, a clean list, steady pacing and stopping when messages fail.',
    published: '2026-11-13',
    topic: 'Safety',
    tone: 'green',
    body: [
      {
        kind: 'p',
        text: 'If you send bulk messages from a WhatsApp number you have linked by QR code, that number is your business’s phone line. Losing it, even for a day, means missed orders and worried customers. No tool can promise a number will never be restricted, but you can make it much less likely.',
      },
      { kind: 'h2', text: 'What WhatsApp is watching for' },
      {
        kind: 'p',
        text: 'WhatsApp does not publish its rules, but the pattern is clear: it protects people from unwanted messages. Many people blocking or reporting you, a lot of messages to people who have never talked to you, and a sudden jump in how much a number sends all look like spam. Everything below is about not looking like that, because you are not.',
      },
      { kind: 'h2', text: 'Start slowly with a new number' },
      {
        kind: 'p',
        text: 'A number that was set up last week has no history, so a thousand messages on day one stands out. Begin with your most engaged customers and grow from there. Wuzie gives a new number a lower daily limit that rises gradually, so the pace builds up with the number’s history.',
      },
      { kind: 'h2', text: 'Keep the list clean' },
      {
        kind: 'list',
        items: [
          'Fix or remove mistyped numbers and duplicates; Wuzie catches both when you import a list.',
          'Take out numbers a campaign report marks as not on WhatsApp.',
          'Take out anyone who asked you to stop, every time, before the next send.',
          'Drop very old contacts you have not spoken to in years. They are the likeliest to report you.',
        ],
      },
      { kind: 'h2', text: 'Send at a human pace' },
      {
        kind: 'p',
        text: 'A person sending messages by hand leaves a few seconds between each one. A bulk send should too. Wuzie leaves a varying gap between messages, so a campaign goes out over hours rather than all at once. It takes longer, and that is the point.',
      },
      { kind: 'h2', text: 'Stop when messages start failing' },
      {
        kind: 'p',
        text: 'If a run of messages fails, something is wrong: a bad batch of numbers, or WhatsApp pushing back. Carrying on makes it worse. Wuzie pauses a campaign on its own when too many messages fail, so you can look at the report before anything else goes out.',
      },
      { kind: 'h2', text: 'Write messages people answer' },
      {
        kind: 'p',
        text: 'Replies are the best sign that people want to hear from you. Ask a simple question, offer something they can reply to, and answer quickly when they do. A number whose messages start conversations is a number customers value.',
      },
      {
        kind: 'example',
        label: 'An easy reply',
        text: 'Hi Rohan, your table for four is booked for Saturday at 8 pm. Reply 1 to confirm or 2 if you need to change the time.',
      },
      { kind: 'h2', text: 'If your number is restricted' },
      {
        kind: 'p',
        text: 'Stop all bulk sending from it at once and read WhatsApp’s notice on the phone; it usually says how long the restriction lasts. Use the time to go through your list and your recent messages with the points above in mind before you start again, more slowly than before.',
      },
    ],
  },
  {
    slug: 'whatsapp-auto-replies-numbered-menus',
    title: 'Auto-replies and numbered menus your customers will actually use',
    description:
      'Short numbered menus, welcome and away messages, and a quick route to a person: writing WhatsApp auto-replies that help instead of annoy.',
    published: '2026-11-13',
    topic: 'Auto-replies',
    tone: 'violet',
    body: [
      {
        kind: 'p',
        text: 'The same questions arrive every day: are you open, is this in stock, where is my order. Automatic replies answer them in seconds, at any hour. Done badly, they trap people in a loop. Done well, customers barely notice they were talking to an automatic reply.',
      },
      { kind: 'h2', text: 'Why a numbered menu works best' },
      {
        kind: 'p',
        text: 'A number linked by QR code, the way WhatsApp Web links, sends plain text. WhatsApp’s tappable buttons and pop-up lists are not reliable from it, and many phones would not show them. A numbered menu works everywhere: on old phones, on new ones and on WhatsApp Web. The customer replies with a digit, and the next answer follows.',
      },
      {
        kind: 'example',
        label: 'A short menu',
        text: 'Hi! Thanks for messaging Sunrise Traders. Reply with a number:\n1. Check stock\n2. Track my order\n3. Opening hours\n4. Talk to the team',
      },
      { kind: 'h2', text: 'Keep the menu short' },
      {
        kind: 'list',
        items: [
          'Three to five options. Anything longer, people stop reading.',
          'The most-asked question first.',
          'Always a way to reach a person, and say when they will reply.',
          'Short labels: “Track my order”, not “Order tracking and delivery information”.',
        ],
      },
      { kind: 'h2', text: 'Accept what people really type' },
      {
        kind: 'p',
        text: 'Customers will type “1.”, “one”, “price?” or a whole sentence instead of the digit. Add keywords for the words people use most, such as price, open or delivery, so a typed question still gets its answer. When nothing matches, send the menu again with a short note, never silence.',
      },
      { kind: 'h2', text: 'Welcome and away messages' },
      {
        kind: 'p',
        text: 'A welcome message tells a new customer who you are and what you can help with. An away message, sent outside your working hours, says when a person will be back. Both should be honest: if the team replies the next morning, say the next morning, not “shortly”.',
      },
      {
        kind: 'example',
        label: 'An honest away message',
        text: 'Thanks for your message! We are closed now and open again at 9 am tomorrow. Reply 1 to see our opening hours, or leave your question and we will answer it first thing.',
      },
      { kind: 'h2', text: 'Hand over to a person early' },
      {
        kind: 'p',
        text: 'An automatic reply is there to save your team time, not to keep customers away from them. If someone asks for a person, or the same customer has gone round the menu twice, stop answering automatically and let a person take over the chat.',
      },
      {
        kind: 'p',
        text: 'Automatic replies in Wuzie are on the way. Everything here works whatever you use, even when you answer by hand from saved replies.',
      },
    ],
  },
];

/** Reading time at about 200 words a minute, rounded up, never under a minute. */
export function readingMinutes(post: Post): number {
  const words = post.body
    .map((block) => (block.kind === 'list' ? block.items.join(' ') : block.text))
    .join(' ')
    .split(/\s+/).length;
  return Math.max(1, Math.ceil(words / 200));
}
