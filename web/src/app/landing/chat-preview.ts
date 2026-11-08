import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';

import { FeatureScene, type Said } from './feature-scene';

interface Feature {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly title: string;
  readonly text: string;
  /** What is in it today; a coming-soon feature promises nothing this specific. */
  readonly points?: readonly string[];
  readonly said: Said;
}

/** What a business can use today: the open services in `server/src/tenancy.js`. */
const AVAILABLE: readonly Feature[] = [
  {
    key: 'bulk',
    label: 'Bulk messages',
    icon: 'send',
    title: 'Message your whole list at once',
    text: 'Upload your contacts and send one campaign from your own number. Each person gets their own chat, with their name in it.',
    points: ['Send now or schedule it for later', 'Add images, PDFs and video', 'Watch sent, read and replied as it goes'],
    said: { name: 'Priya Shah', text: 'Hi Priya, our Diwali sale starts Friday! 20% off every kurta, this week only.', time: '10:00' },
  },
  {
    key: 'templates',
    label: 'Templates',
    icon: 'file-text',
    title: 'Write it once, reuse it every week',
    text: 'Save the messages you send most, with blanks for each person’s details, and start your next campaign from one.',
    points: ['Name, order or amount filled in for each person', 'Keep an image or file with the message', 'A preview before anything goes out'],
    said: { name: 'Rohan Mehta', text: 'Hi Rohan, your order #4822 has shipped and should reach you by Thursday.', time: '11:30' },
  },
  {
    key: 'contacts',
    label: 'Contacts',
    icon: 'address-book',
    title: 'Your customers, ready to message',
    text: 'Bring in your list from Excel or CSV, and group people so each campaign reaches the right ones.',
    points: ['Bad numbers and duplicates caught on import', 'Groups and tags, such as VIP or Recent buyers', 'Every message to a person kept in one place'],
    said: { name: 'Kavya Rao', text: 'Hi Kavya, as one of our VIP customers you get first look at the new collection.', time: '12:15' },
  },
  {
    key: 'inbox',
    label: 'Shared inbox',
    icon: 'inbox',
    title: 'Every reply in one place',
    text: 'When customers answer, their messages land in one list your whole team can see and reply to.',
    points: ['Answer from the dashboard, on your own number', 'Hand a chat to the right person', 'See which campaign a reply came from'],
    said: { name: 'Meghna Iyer', text: 'Yes, in 2 to 3 days. Shall I place the order for you?', time: '9:08' },
  },
  {
    key: 'numbers',
    label: 'WhatsApp numbers',
    icon: 'device-mobile',
    title: 'Use the number customers already know',
    text: 'Link your WhatsApp or WhatsApp Business number by scanning a QR code. There is no Meta approval to wait for.',
    points: ['Linked in a minute, like WhatsApp Web', 'A daily limit that protects your number', 'Send one campaign from several numbers at once, on bigger plans'],
    said: { name: 'Arjun Nair', text: 'Hi Arjun, this is Sunrise Traders. Your new price list is attached.', time: '15:02' },
  },
];

/**
 * On the way. Mirrors SOON_SERVICES in `admin/service-meta.ts`, with Integrations folded into API and Auto replies
 * added: a business can reach those today, but the landing page does not sell them yet. The chats are previews.
 */
const COMING_SOON: readonly Feature[] = [
  {
    key: 'auto-replies',
    label: 'Auto replies',
    icon: 'message-bolt',
    title: 'Answers that go out on their own',
    text: 'Keywords, numbered menus and after-hours messages reply to customers in your words, even when nobody is at the desk.',
    said: { name: 'Priya Shah', text: 'Hi Priya! Reply with a number: 1  Check stock 2  Track my order 3  Talk to the team', time: '9:41' },
  },
  {
    key: 'ai',
    label: 'AI replies',
    icon: 'sparkles',
    title: 'Replies written for each question',
    text: 'AI answers the questions a fixed reply cannot, using what you have told it about your business.',
    said: { name: 'Neel Desai', text: 'Yes, XL is in stock, and orders placed today reach Pune by Thursday.', time: '14:12' },
  },
  {
    key: 'faq',
    label: 'FAQ',
    icon: 'help-circle',
    title: 'Common questions, answered for you',
    text: 'Add your answers once, and customers get them the moment they ask.',
    said: { name: 'Sana Khan', text: 'We are open until 6 pm on Sundays.', time: '16:40' },
  },
  {
    key: 'school',
    label: 'School assistant',
    icon: 'school',
    title: 'Fees, notices and parent questions',
    text: 'Keep parents up to date on fees, homework and attendance, and answer their questions on WhatsApp.',
    said: { name: 'Aarav’s parent', text: 'Reminder: Term 2 fees of ₹12,500 for Aarav (Class 6B) are due on 10 November.', time: '8:00' },
  },
  {
    key: 'payments',
    label: 'Payment reminders',
    icon: 'cash',
    title: 'Get paid without chasing',
    text: 'Follow up on invoices until they are paid, without writing each reminder yourself.',
    said: { name: 'Vikram Joshi', text: 'Hi Vikram, invoice #1042 for ₹2,500 is due on Friday. Reply 1 for a payment link.', time: '10:30' },
  },
  {
    key: 'appointments',
    label: 'Appointments',
    icon: 'calendar-event',
    title: 'Bookings and reminders in the chat',
    text: 'Customers pick a time on WhatsApp and get a reminder before they are due.',
    said: { name: 'Rohan Mehta', text: 'Booked: Tuesday 12:00 with Dr. Iyer. We will remind you an hour before.', time: '18:21' },
  },
  {
    key: 'orders',
    label: 'Orders',
    icon: 'shopping-cart',
    title: 'Take orders over WhatsApp',
    text: 'Turn a customer’s message into an order you can track from the dashboard.',
    said: { name: 'Kavya Rao', text: 'Confirmed. We will message you when it ships.', time: '13:06' },
  },
  {
    key: 'leads',
    label: 'Leads',
    icon: 'user-search',
    title: 'Never lose an enquiry',
    text: 'Every new enquiry is saved, so your team can follow it up.',
    said: { name: 'Ishaan Verma', text: 'It is ₹9,000 for 3 months. Would you like a call? Reply 1 for yes.', time: '17:02' },
  },
  {
    key: 'subscriptions',
    label: 'Subscriptions',
    icon: 'refresh',
    title: 'Renewals that take one reply',
    text: 'Remind members before a plan ends and let them renew from the chat.',
    said: { name: 'Meera Nair', text: 'Hi Meera, your monthly plan ends on 12 November. Reply 1 to renew, 2 to pause.', time: '9:00' },
  },
  {
    key: 'events',
    label: 'Events',
    icon: 'confetti',
    title: 'Fill the room and know who is coming',
    text: 'Invite your list and collect bookings by reply.',
    said: { name: 'Tara Menon', text: 'Hi Tara, doors open at 7 pm on Saturday. Reply 1 to book your seat.', time: '11:00' },
  },
  {
    key: 'tickets',
    label: 'Tickets',
    icon: 'ticket',
    title: 'Support issues that do not get lost',
    text: 'Turn a complaint into a ticket with an owner, and keep the customer informed.',
    said: { name: 'Dev Patel', text: 'Sorry about that. Ticket #208 is open and Neha will reply today.', time: '12:49' },
  },
  {
    key: 'workflows',
    label: 'Workflows',
    icon: 'hierarchy-3',
    title: 'Follow-ups that run themselves',
    text: 'Set the steps once, such as a thank-you and then a review request, and they run for every customer.',
    said: { name: 'Arjun Nair', text: 'Thanks for your order, Arjun!', time: '10:00' },
  },
  {
    key: 'analytics',
    label: 'Analytics',
    icon: 'chart-bar',
    title: 'See which messages work',
    text: 'Compare your campaigns by who read them and who replied, so the next one does better.',
    said: { name: 'Priya Shah', text: 'Hi Priya, our Diwali sale starts Friday!', time: '10:00' },
  },
  {
    key: 'api',
    label: 'API & integrations',
    icon: 'api',
    title: 'Connect WhatsApp to your software',
    text: 'Send messages from the tools you already use and get replies back in them.',
    said: { name: 'Rohan Mehta', text: 'Hi Rohan, your payment of ₹1,850 was received. Thank you!', time: '19:44' },
  },
];

/**
 * The landing page's tour of the product: every feature down the side, and for the one picked, what it does and a
 * scene of it at work (FeatureScene). Messages use numbered replies because a QR-linked number cannot send native
 * WhatsApp buttons or lists, so they show what the product really sends. Names and figures are samples.
 */
@Component({
  selector: 'app-chat-preview',
  imports: [FeatureScene],
  templateUrl: './chat-preview.html',
  styleUrl: './chat-preview.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatPreview {
  protected readonly available = AVAILABLE;
  protected readonly comingSoon = COMING_SOON;
  protected readonly feature = signal(AVAILABLE[0]);
  protected readonly soon = computed(() => COMING_SOON.includes(this.feature()));
}
