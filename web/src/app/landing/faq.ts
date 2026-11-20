/**
 * The landing page's questions and answers. Plain data in its own file because three readers share it: the page
 * (landing.ts), and the build's SEO step (web/scripts/seo.mjs), which writes them as FAQPage schema and as the
 * text a crawler without JavaScript reads. Every answer must match what the product does today.
 */
export const FAQS: readonly { readonly q: string; readonly a: string }[] = [
  {
    q: 'How many messages can I send a day?',
    a: 'It depends on your number. A new number starts with a small daily limit that grows as the number becomes established, up to 1,000 a day per number. Add more numbers to send more. Your plan sets the monthly total.',
  },
  {
    q: 'Will my number get banned?',
    a: 'No tool can promise that. Wuzie lowers the risk: it caps how much a number sends a day, leaves random gaps between messages, spreads a day’s sends over the whole day and pauses a campaign when too many messages fail.',
  },
  {
    q: 'Do I need the WhatsApp Business API?',
    a: 'No. You link the WhatsApp or WhatsApp Business number you already use by scanning a QR code, the same way WhatsApp Web works. There is no Meta approval to wait for.',
  },
  {
    q: 'Can I send images, PDFs and buttons?',
    a: 'Yes. Text, images, documents and video, plus WhatsApp reply buttons, list menus and carousels your customers tap to answer.',
  },
  {
    q: 'What happens when people reply?',
    a: 'Replies come straight to your WhatsApp number, so you answer them on your phone as usual. Automatic replies to common questions are coming soon.',
  },
  {
    q: 'How do I get an account?',
    a: 'Accounts are set up for you. Choose Free Access, tell us about your business, and we create your workspace and send the sign-in details. Your plan runs until the end date set for it.',
  },
];
