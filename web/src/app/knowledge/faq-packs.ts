import type { FaqImportRow } from './knowledge-api';

/**
 * Ready-made FAQ sets, one per kind of business. Picking one opens an editable preview; nothing is saved until the
 * business imports it, and a question whose answer still has a [placeholder] is imported paused, so a half-filled
 * answer never reaches a customer. Keywords carry the Hinglish a customer actually types. Plain data: no server side.
 */
export interface FaqPack {
  readonly key: string;
  readonly title: string;
  readonly blurb: string;
  readonly icon: string;
  readonly items: readonly FaqImportRow[];
}

const q = (category: string, question: string, answer: string, keywords: string[] = []): FaqImportRow => ({
  question,
  answer,
  category,
  keywords,
});

/** The questions every business gets; each pack adds its own. */
const BASICS = (category: string): FaqImportRow[] => [
  q(category, 'What are your timings?', 'We are open [your days], [opening time] to [closing time].', [
    'timing',
    'timings',
    'kab khulta',
    'open today',
  ]),
  q(category, 'Where are you located?', 'You can find us at [your address].\nMap: [Google Maps link]', [
    'address',
    'location',
    'kahan hai',
  ]),
  q(category, 'How can I pay?', 'You can pay by UPI ([your UPI ID]), cash or card.', [
    'payment',
    'upi',
    'gpay',
    'paytm',
  ]),
];

export const FAQ_PACKS: readonly FaqPack[] = [
  {
    key: 'shop',
    title: 'Shop / retail',
    blurb: 'Timings, address, prices, home delivery, returns and stock.',
    icon: 'building-store',
    items: [
      ...BASICS('Store'),
      q('Store', 'What are your prices?', 'Prices are on our catalogue: [catalogue link]. Send the item name and we will tell you the rate.', [
        'price',
        'rate',
        'kitne ka',
      ]),
      q('Delivery', 'Do you do home delivery?', 'Yes, we deliver within [area / km]. Delivery is free above ₹[amount].', [
        'delivery',
        'home delivery',
        'ghar pe',
      ]),
      q('Delivery', 'How long does delivery take?', 'Orders reach you in [number] days. You get a message when it leaves.', [
        'kab milega',
        'delivery time',
      ]),
      q('Orders', 'Can I return or exchange an item?', 'Yes, within [number] days with the bill. The item must be unused.', [
        'return',
        'exchange',
        'replace',
        'wapas',
      ]),
      q('Orders', 'Is this item in stock?', 'Send a photo or the name of the item and we will check stock for you.', [
        'stock',
        'available',
        'milega',
      ]),
      q('Orders', 'Do you give a discount on bulk orders?', 'Yes, for orders above [quantity] pieces. Tell us what you need and we will send a quote.', [
        'discount',
        'wholesale',
        'bulk',
      ]),
    ],
  },
  {
    key: 'clinic',
    title: 'Clinic / doctor',
    blurb: 'OPD timings, booking, fees, reports and emergencies.',
    icon: 'stethoscope',
    items: [
      ...BASICS('Clinic'),
      q('Appointments', 'How do I book an appointment?', 'Reply with your name, age and a preferred time, and we will confirm your slot.', [
        'appointment',
        'booking',
        'book',
      ]),
      q('Appointments', 'What is the consultation fee?', 'The consultation fee is ₹[amount]. A follow-up within [days] days is ₹[amount].', [
        'fees',
        'fee',
        'charges',
        'kitni fees',
      ]),
      q('Appointments', 'Is the doctor available today?', 'The doctor sees patients [OPD days and timings]. Reply BOOK to take a slot.', [
        'doctor',
        'available today',
        'aaj',
      ]),
      q('Reports', 'When will my report be ready?', 'Most reports are ready in [hours] hours. We send them here on WhatsApp.', [
        'report',
        'test result',
      ]),
      q('Clinic', 'What should I do in an emergency?', 'For an emergency please call [emergency number] or go to the nearest hospital at once.', [
        'emergency',
        'urgent',
      ]),
      q('Clinic', 'Do you accept health insurance?', 'We accept [insurance names]. Please bring your card and ID.', [
        'insurance',
        'cashless',
        'mediclaim',
      ]),
    ],
  },
  {
    key: 'coaching',
    title: 'Coaching / school',
    blurb: 'Admissions, fees, batches, demo class and study material.',
    icon: 'school',
    items: [
      ...BASICS('Institute'),
      q('Admissions', 'How do I take admission?', 'Admission is open for [classes / courses]. Visit us with [documents] or reply with the student name and class.', [
        'admission',
        'admission kaise',
        'join',
      ]),
      q('Fees', 'What is the fee?', 'The fee for [course] is ₹[amount] for [duration]. It can be paid in [number] instalments.', [
        'fees',
        'fee',
        'kitni fees',
      ]),
      q('Batches', 'What are the batch timings?', 'Batches run [batch timings]. Tell us the class and we will suggest one.', [
        'batch',
        'batch timing',
      ]),
      q('Admissions', 'Is there a free demo class?', 'Yes, the first class is a free demo. Reply DEMO with the student name to book it.', [
        'demo',
        'trial class',
      ]),
      q('Batches', 'Do you have online classes?', 'Yes, [online class details]. Recordings are shared after each class.', [
        'online',
        'online class',
      ]),
      q('Batches', 'Do you give study material?', 'Yes, notes and test papers are included in the fee.', [
        'notes',
        'study material',
        'books',
      ]),
    ],
  },
  {
    key: 'restaurant',
    title: 'Restaurant / café',
    blurb: 'Menu, home delivery, table booking, veg/Jain options and parties.',
    icon: 'tools-kitchen-2',
    items: [
      ...BASICS('Restaurant'),
      q('Menu', 'Can I see the menu?', 'Here is our menu: [menu link]. Reply with the dish names to order.', [
        'menu',
        'card',
        'kya milega',
      ]),
      q('Delivery', 'Do you deliver?', 'Yes, we deliver within [area / km]. You can also order on [Swiggy / Zomato].', [
        'delivery',
        'home delivery',
        'parcel',
      ]),
      q('Booking', 'Can I book a table?', 'Yes. Reply with the date, time and number of people and we will confirm.', [
        'table',
        'reservation',
        'book table',
      ]),
      q('Menu', 'Do you have Jain or pure veg food?', 'Our kitchen is [pure veg / veg and non-veg]. Jain dishes are marked on the menu.', [
        'jain',
        'veg',
        'pure veg',
      ]),
      q('Booking', 'Do you take party or bulk orders?', 'Yes, for [minimum people] people or more. Tell us the date and count for a quote.', [
        'party',
        'bulk order',
        'catering',
      ]),
    ],
  },
  {
    key: 'salon',
    title: 'Salon / beauty',
    blurb: 'Services and rates, appointments, bridal packages and products.',
    icon: 'scissors',
    items: [
      ...BASICS('Salon'),
      q('Services', 'What are your rates?', 'Our rate list: [rate list link]. Haircut from ₹[amount], facial from ₹[amount].', [
        'rate',
        'price',
        'rate list',
      ]),
      q('Appointments', 'How do I book an appointment?', 'Reply with the service, date and a time you like, and we will confirm your slot.', [
        'appointment',
        'booking',
      ]),
      q('Services', 'Do you have bridal packages?', 'Yes, bridal packages start at ₹[amount]. Reply BRIDAL for the full list.', [
        'bridal',
        'wedding',
        'makeup',
      ]),
      q('Services', 'Do you offer home service?', 'Yes, within [area], for ₹[amount] extra.', [
        'home service',
        'ghar pe',
      ]),
      q('Appointments', 'Can I walk in without an appointment?', 'Walk-ins are welcome, but booking ahead saves you the wait.', [
        'walk in',
        'without appointment',
      ]),
    ],
  },
  {
    key: 'services',
    title: 'Services / repair',
    blurb: 'Service areas, visit charges, booking a visit, warranty and quotes.',
    icon: 'tool',
    items: [
      ...BASICS('Business'),
      q('Service', 'Which areas do you cover?', 'We cover [areas / city]. Send your pincode and we will confirm.', [
        'area',
        'service area',
        'pincode',
      ]),
      q('Service', 'What is the visit charge?', 'The visit charge is ₹[amount], adjusted in the bill if you go ahead with the work.', [
        'visit charge',
        'charges',
        'rate',
      ]),
      q('Service', 'How do I book a visit?', 'Reply with your address, the problem and a convenient time. We will confirm the visit.', [
        'book',
        'visit',
        'technician',
      ]),
      q('Service', 'Is there a warranty on the work?', 'Yes, [number] days of warranty on the work and on parts we fit.', [
        'warranty',
        'guarantee',
      ]),
      q('Service', 'Can I get a quote?', 'Sure. Send a photo of the work needed and we will share a quote.', [
        'quote',
        'estimate',
        'quotation',
      ]),
    ],
  },
];

/** True when a text still has a [placeholder] for the business to fill in. */
export const hasPlaceholder = (text: string): boolean => /\[[^\]\n]+\]/.test(text);
