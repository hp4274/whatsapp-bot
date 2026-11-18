import { RuleDraft } from './rule-editor';

/**
 * Ready-made rules a business starts from. Picking one opens the editor filled in and unsaved, so the
 * [placeholders] get the business's own details before anything goes live. Plain data: no server side.
 */
export interface RuleTemplate {
  readonly key: string;
  readonly title: string;
  readonly blurb: string;
  readonly icon: string;
  /** The plan switch it needs (autoReplies.*); hidden when the plan leaves it out. */
  readonly needs?: readonly string[];
  readonly draft: Partial<RuleDraft>;
}

const reply = (text: string): Pick<RuleDraft, 'replyBody' | 'variants'> => ({
  replyBody: text,
  variants: [text],
});

const actions = (p: Partial<RuleDraft['actions']> = {}): RuleDraft['actions'] => ({
  addTag: '',
  setField: null,
  escalate: false,
  stop: true,
  ...p,
});

const INTENTS = ['autoReplies.allowIntents'];
const QUESTIONS = ['autoReplies.allowQuestions'];

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    key: 'help',
    title: 'Help menu',
    blurb: 'HELP, MENU or COMMANDS shows a menu of what customers can ask. Replaces the automatic keyword list.',
    icon: 'list-details',
    needs: ['autoReplies.allowMenus'],
    draft: {
      name: 'Help menu',
      matchType: 'EXACT',
      keywords: ['help', 'menu', 'commands'],
      ...reply('Hi {first_name|there}! How can {business_name|we} help you today?'),
      interactive: {
        type: 'list',
        list: {
          button: 'Options',
          sections: [
            {
              title: 'Help',
              rows: [
                { id: 'PRICES', title: 'Prices' },
                { id: 'ORDER', title: 'Order status' },
                { id: 'HOURS', title: 'Opening hours' },
                { id: 'PERSON', title: 'Talk to a person' },
              ],
            },
          ],
        },
      },
      menu: {
        PRICES: { replyBody: 'Our prices start at [₹ amount]. Reply with a product name for its price.' },
        ORDER: { replyBody: 'Please send your order ID and we will check it for you.' },
        HOURS: { replyBody: 'We are open [Mon–Sat, 10 am – 7 pm].' },
        PERSON: {
          replyBody: 'Connecting you to a team member. Someone will reply here shortly.',
          actions: { escalate: true },
        },
      },
    },
  },
  {
    key: 'greeting',
    title: 'Greeting',
    blurb: 'Hi, hello, namaste, kem cho: a friendly hello that points to HELP.',
    icon: 'hand-move',
    needs: INTENTS,
    draft: {
      name: 'Greeting',
      matchType: 'INTENT',
      keywords: ['greeting'],
      ...reply('{time_greeting} {first_name|there}! Welcome to {business_name|our store}. Reply HELP to see what we can do for you.'),
      translations: {
        hinglish: 'Namaste {first_name|ji}! {business_name|Hamare store} mein aapka swagat hai. Kya madad karein? HELP likhiye.',
        hi: 'नमस्ते {first_name|जी}! {business_name|हमारे स्टोर} में आपका स्वागत है। HELP लिखकर देखें हम क्या कर सकते हैं।',
      },
    },
  },
  {
    key: 'price',
    title: 'Price enquiry',
    blurb: '"Price?", "rate kya hai", "कितना है": one answer, in their language.',
    icon: 'currency-rupee',
    needs: INTENTS,
    draft: {
      name: 'Price enquiry',
      matchType: 'INTENT',
      keywords: ['price'],
      ...reply('Our prices start at [₹ amount]. Tell us the product you are looking for and we will send its price.'),
      translations: {
        hinglish: 'Hamare rates [₹ amount] se shuru hote hain. Kaunsa product chahiye, batayein, hum price bhej denge.',
        hi: 'हमारी कीमतें [₹ राशि] से शुरू होती हैं। कौन सा प्रोडक्ट चाहिए, बताइए, हम कीमत भेज देंगे।',
      },
      actions: actions({ addTag: 'price-enquiry' }),
    },
  },
  {
    key: 'order-status',
    title: 'Order status',
    blurb: '"Where is my order?": asks for the order ID and saves it to the contact.',
    icon: 'truck',
    needs: [...INTENTS, ...QUESTIONS],
    draft: {
      name: 'Order status',
      matchType: 'INTENT',
      keywords: ['order_status'],
      ...reply('Sure, let me check that for you.'),
      collect: {
        questions: [{ key: 'order_id', question: 'Please send your order ID.', type: 'text' }],
        doneReply: 'Thanks! We are checking order {order_id} and will update you here shortly.',
      },
      actions: actions({ addTag: 'order-enquiry' }),
    },
  },
  {
    key: 'new-order',
    title: 'Place an order',
    blurb: 'Takes an order on chat: name, item and delivery address.',
    icon: 'shopping-cart',
    needs: QUESTIONS,
    draft: {
      name: 'Place an order',
      matchType: 'ANY_OF',
      keywords: ['place an order', 'new order', 'i want to order', 'want to buy', 'buy'],
      ...reply('Happy to take your order!'),
      collect: {
        questions: [
          { key: 'name', question: 'May I have your name?', type: 'name' },
          { key: 'item', question: 'What would you like to order, and how many?', type: 'text' },
          { key: 'address', question: 'Your delivery address, please.', type: 'text' },
        ],
        doneReply: 'Thank you {name}! We have your order for {item}. We will confirm the total and delivery time shortly.',
      },
      actions: actions({ addTag: 'new-order' }),
    },
  },
  {
    key: 'hours',
    title: 'Opening hours',
    blurb: '"Timings?", "kab khulega": your opening hours.',
    icon: 'clock',
    needs: INTENTS,
    draft: {
      name: 'Opening hours',
      matchType: 'INTENT',
      keywords: ['hours'],
      ...reply('We are open [Mon–Sat, 10 am – 7 pm]. Closed on [Sundays].'),
    },
  },
  {
    key: 'location',
    title: 'Address & location',
    blurb: '"Where are you?", "address": your address and a map link.',
    icon: 'map-pin',
    needs: INTENTS,
    draft: {
      name: 'Address & location',
      matchType: 'INTENT',
      keywords: ['location'],
      ...reply('You can find us at [your address].\nMap: [Google Maps link]'),
    },
  },
  {
    key: 'payment',
    title: 'Payment details',
    blurb: 'UPI, bank or card questions: how to pay you.',
    icon: 'credit-card',
    needs: INTENTS,
    draft: {
      name: 'Payment details',
      matchType: 'INTENT',
      keywords: ['payment'],
      ...reply('You can pay by UPI to [your UPI ID] or by bank transfer:\n[Bank name, account number, IFSC]\nPlease send a screenshot once paid.'),
    },
  },
  {
    key: 'refund',
    title: 'Refund & return',
    blurb: 'Refund, return or exchange questions: your policy, and a tag to follow up.',
    icon: 'receipt-refund',
    needs: INTENTS,
    draft: {
      name: 'Refund & return',
      matchType: 'INTENT',
      keywords: ['refund'],
      ...reply('You can return items within [7 days] of delivery. Please send your order ID and a photo of the item, and we will arrange it.'),
      actions: actions({ addTag: 'refund' }),
    },
  },
  {
    key: 'complaint',
    title: 'Complaint',
    blurb: 'A problem or complaint: an apology, and a person takes over the chat.',
    icon: 'mood-sad',
    needs: INTENTS,
    draft: {
      name: 'Complaint',
      matchType: 'INTENT',
      keywords: ['complaint'],
      ...reply('We are sorry about this. A team member will look into it and reply here shortly.'),
      actions: actions({ addTag: 'complaint', escalate: true }),
    },
  },
  {
    key: 'callback',
    title: 'Callback request',
    blurb: '"Call me": takes a name and the best number to call.',
    icon: 'phone-call',
    needs: QUESTIONS,
    draft: {
      name: 'Callback request',
      matchType: 'ANY_OF',
      keywords: ['call me', 'callback', 'call back'],
      ...reply('Sure, we will call you.'),
      collect: {
        questions: [
          { key: 'name', question: 'May I have your name?', type: 'name' },
          { key: 'callback_phone', question: 'Which number should we call?', type: 'phone' },
        ],
        doneReply: 'Thanks {name}! We will call you on {callback_phone} soon.',
      },
      actions: actions({ addTag: 'callback' }),
    },
  },
  {
    key: 'file',
    title: 'Photo or file received',
    blurb: 'A photo or document: lets the customer know it arrived.',
    icon: 'photo',
    needs: ['autoReplies.allowMessageTypes'],
    draft: {
      name: 'Photo or file received',
      matchType: 'MESSAGE_TYPE',
      keywords: ['image', 'document'],
      ...reply('Thanks, we got your file. We will take a look and reply here.'),
    },
  },
  {
    key: 'thanks',
    title: 'Thanks',
    blurb: '"Thank you", "dhanyavad": a warm reply.',
    icon: 'heart-handshake',
    needs: INTENTS,
    draft: {
      name: 'Thanks',
      matchType: 'INTENT',
      keywords: ['thanks'],
      ...reply('You are welcome, {first_name|there}! Message us any time.'),
    },
  },
  {
    key: 'cancel-order',
    title: 'Cancel an order',
    blurb: '"Cancel my order": asks which order, tags it for you to act on.',
    icon: 'circle-x',
    needs: QUESTIONS,
    draft: {
      name: 'Cancel an order',
      // Not plain "cancel": that word unsubscribes the customer (opt-out).
      matchType: 'ANY_OF',
      keywords: ['cancel my order', 'cancel order', 'order cancel', 'cancel the order'],
      ...reply('Sorry to hear that.'),
      collect: {
        questions: [{ key: 'order_id', question: 'Which order should we cancel? Please send the order ID.', type: 'text' }],
        doneReply: 'Got it. We will cancel order {order_id} and confirm here shortly.',
      },
      actions: actions({ addTag: 'cancel-request' }),
    },
  },
  {
    key: 'order-confirmed',
    title: 'Order confirmation',
    blurb: '"Is my order confirmed?", "order accepted?": confirms and says what happens next.',
    icon: 'circle-check',
    draft: {
      name: 'Order confirmation',
      matchType: 'ANY_OF',
      keywords: ['order confirmed', 'order accepted', 'confirm my order', 'is my order confirmed', 'order received'],
      ...reply('Yes! Once we receive your order we confirm it here and send it out within [1–2 days]. Send your order ID to check a specific one.'),
    },
  },
  {
    key: 'delivery',
    title: 'Delivery charges & time',
    blurb: 'Delivery, shipping, courier: what it costs and how long it takes.',
    icon: 'truck-delivery',
    needs: INTENTS,
    draft: {
      name: 'Delivery charges & time',
      matchType: 'INTENT',
      keywords: ['delivery'],
      ...reply('We deliver in [2–4 days]. Delivery is [free above ₹ amount, else ₹ amount].'),
      translations: {
        hinglish: 'Delivery [2–4 din] mein ho jaati hai. [₹ amount] se upar free delivery hai.',
      },
    },
  },
  {
    key: 'book-appointment',
    title: 'Book an appointment',
    blurb: 'Takes a booking: name, day and time.',
    icon: 'calendar-plus',
    needs: QUESTIONS,
    draft: {
      name: 'Book an appointment',
      matchType: 'ANY_OF',
      keywords: ['appointment', 'book appointment', 'booking', 'book a slot', 'slot'],
      ...reply('Happy to book you in.'),
      collect: {
        questions: [
          { key: 'name', question: 'May I have your name?', type: 'name' },
          { key: 'booking_day', question: 'Which day suits you?', type: 'text' },
          { key: 'booking_time', question: 'And what time?', type: 'text' },
        ],
        doneReply: 'Thanks {name}! We have noted {booking_day} at {booking_time} and will confirm here shortly.',
      },
      actions: actions({ addTag: 'booking' }),
    },
  },
  {
    key: 'reschedule',
    title: 'Reschedule a booking',
    blurb: '"Reschedule", "change my appointment": asks for the new day and time.',
    icon: 'calendar-repeat',
    needs: QUESTIONS,
    draft: {
      name: 'Reschedule a booking',
      matchType: 'ANY_OF',
      keywords: ['reschedule', 'change appointment', 'change my appointment', 'change booking', 'postpone'],
      ...reply('No problem.'),
      collect: {
        questions: [{ key: 'new_slot', question: 'Which day and time would suit you instead?', type: 'text' }],
        doneReply: 'Noted: {new_slot}. We will confirm the new time here shortly.',
      },
      actions: actions({ addTag: 'reschedule' }),
    },
  },
];

/** A set of rules for one part of the business, added together. Its rules run in this order (specific first). */
export interface RulePack {
  readonly key: string;
  readonly title: string;
  readonly blurb: string;
  readonly icon: string;
  readonly rules: readonly string[];
}

/**
 * Sets that belong to the coming Orders and Appointments features (SOON_SERVICES in admin/service-meta.ts): kept
 * here for when those open, not offered in Auto replies, which stays about replies.
 */
const SOON_PACKS: ReadonlySet<string> = new Set(['orders', 'bookings']);

const ALL_PACKS: readonly RulePack[] = [
  {
    key: 'orders',
    title: 'Orders',
    blurb: 'Order status, cancel, confirmation, delivery, price, payment, returns and taking new orders.',
    icon: 'shopping-cart',
    // Cancel and confirmation before status: "cancel my order" also says "my order".
    rules: ['cancel-order', 'order-confirmed', 'order-status', 'delivery', 'refund', 'price', 'payment', 'new-order'],
  },
  {
    key: 'support',
    title: 'Customer support',
    blurb: 'Help menu, greeting, complaints, callbacks, files received and thanks.',
    icon: 'headset',
    rules: ['help', 'greeting', 'complaint', 'callback', 'file', 'thanks'],
  },
  {
    key: 'store',
    title: 'Store info',
    blurb: 'Opening hours, address, prices and how to pay.',
    icon: 'building-store',
    rules: ['hours', 'location', 'price', 'payment'],
  },
  {
    key: 'bookings',
    title: 'Appointments',
    blurb: 'Take bookings and reschedules, with your hours and address.',
    icon: 'calendar-event',
    rules: ['book-appointment', 'reschedule', 'hours', 'location'],
  },
];

export const RULE_PACKS: readonly RulePack[] = ALL_PACKS.filter((p) => !SOON_PACKS.has(p.key));

/** A pack's rules this plan includes, in the pack's order. */
export const packRules = (pack: RulePack, plan: Record<string, unknown>): readonly RuleTemplate[] => {
  const allowed = templatesFor(plan);
  return pack.rules.map((key) => allowed.find((t) => t.key === key)).filter((t): t is RuleTemplate => !!t);
};

/** True when a template's text still has a [placeholder] for the business to fill in. */
export const hasPlaceholder = (t: RuleTemplate): boolean => texts(t.draft).some((s) => /\[[^\]\n]+\]/.test(s));

/** Every string inside a value (the reply texts, questions, translations), not the JSON around them. */
function texts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (value && typeof value === 'object') return Object.values(value).flatMap(texts);
  return [];
}

/** The templates this plan includes. */
export const templatesFor = (plan: Record<string, unknown>): readonly RuleTemplate[] =>
  RULE_TEMPLATES.filter((t) => (t.needs ?? []).every((key) => plan[key] !== false));
