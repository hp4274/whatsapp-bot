/**
 * Demo data for one tenant, for exactly the services it has enabled.
 *
 * Writes through the same stores the routes use, with two deliberate choices
 * so a demo never messages anyone:
 *   - business objects go through an ObjectStore with no `emit`, so no
 *     workflow (even an active one the tenant already has) hears about them;
 *   - inbound messages are inserted directly, not through `handleInbound`, so
 *     no auto-reply or FAQ answer fires. Recipes install as drafts.
 * School rows are shaped so `schoolSweep` leaves them alone: past-due fees are
 * already `overdue`, homework is marked sent, notices carry no `sendAt`.
 *
 * Idempotent per item: objects use fixed references (`demo-*`, or the school's
 * own `att-/tt-/fee-/res-` conventions), everything else is matched by
 * name / phone / keyword / question / message id. A second run creates
 * nothing; enabling another service and re-running seeds only that one.
 */

import { ObjectStore } from '../objects/store.js';
import { getRecipe, installRecipe } from '../recipes/index.js';
import { classKeyOf, listAll, localNow } from '../school/routes.js';
import { getSettings, saveSettings } from '../school/settings.js';

const DAY = 86_400_000;
const at = (days, hours = 0) => new Date(Date.now() + days * DAY + hours * 3_600_000).toISOString();
const phone = (block, n) => `+9198${block}${String(n).padStart(5, '0')}`;

// ----------------------------------------------------------------- data --

const CONTACTS = [
    ['Aarav Sharma', 'Pune', ['customer', 'vip'], { lastOrder: 'Kurta set', spend: '18400' }],
    ['Priya Nair', 'Kochi', ['customer'], { lastOrder: 'Silk saree', spend: '6200' }],
    ['Rohan Mehta', 'Mumbai', ['lead'], { interest: 'Wholesale pricing' }],
    ['Sneha Iyer', 'Chennai', ['customer', 'vip'], { lastOrder: 'Gift hamper', spend: '24750' }],
    ['Vikram Singh', 'Jaipur', ['lead'], { interest: 'Bulk order for wedding' }],
    ['Ananya Gupta', 'Delhi', ['customer'], { lastOrder: 'Cotton dupatta', spend: '1450' }],
    ['Karthik Reddy', 'Hyderabad', ['customer', 'wholesale'], { lastOrder: '40 x T-shirts', spend: '32000' }],
    ['Meera Joshi', 'Pune', ['lead'], { interest: 'Store visit' }],
    ['Arjun Patel', 'Ahmedabad', ['customer'], { lastOrder: 'Nehru jacket', spend: '3900' }],
    ['Divya Menon', 'Bengaluru', ['customer', 'vip'], { lastOrder: 'Lehenga', spend: '41200' }],
    ['Siddharth Rao', 'Bengaluru', ['lead'], { interest: 'Corporate gifting' }],
    ['Kavya Desai', 'Surat', ['customer', 'wholesale'], { lastOrder: 'Fabric rolls', spend: '56800' }],
    ['Aditya Kulkarni', 'Nagpur', ['customer'], { lastOrder: 'Formal shirt', spend: '2100' }],
    ['Ishita Bose', 'Kolkata', ['lead'], { interest: 'Festive collection' }],
    ['Nikhil Verma', 'Lucknow', ['customer'], { lastOrder: 'Sherwani', spend: '12600' }],
];
const contactPhone = (i) => phone('100', 101 + i);

const TEMPLATES = [
    ['welcome_message', 'Namaste {name}! Thanks for reaching out to us. Reply MENU to see what we can help you with.'],
    ['order_update', 'Hi {name}, your order {reference} is now {status}. Track it here: {trackingLink}'],
    ['payment_reminder', 'Hi {name}, a gentle reminder that INR {amount} is due on {dueDate}. Pay securely: {payLink}'],
    ['festive_offer', 'Hi {name}, our Diwali sale is live! Flat 20% off till {endDate}. Show this message in store or reply SHOP.'],
    ['feedback_request', 'Hi {name}, thank you for choosing us. How would you rate your experience from 1 to 5?'],
];

const AUTO_REPLIES = [
    ['hi', 'EXACT', 'Hello {name}! Welcome. Reply PRICE for our rate card, HOURS for timings or LOCATION for directions.'],
    ['price', 'CONTAINS', 'Our latest rate card is here: https://example.com/rates. Reply with the product name for a quote.'],
    ['hours', 'CONTAINS', 'We are open Monday to Saturday, 10:00 AM to 8:00 PM, and Sunday 11:00 AM to 5:00 PM.'],
    ['location', 'CONTAINS', 'Find us at Shop 12, MG Road, near the City Mall signal. Maps: https://maps.example.com/demo'],
];

const FAQ = [
    ['Orders & Delivery', 'orders-delivery', [
        ['How long does delivery take?', 'Metro cities get delivery in 2-3 working days; other locations take 4-6 days.', ['delivery', 'shipping', 'days']],
        ['How can I track my order?', 'Reply TRACK with your order number and we will send the live tracking link.', ['track', 'tracking', 'where is my order']],
        ['Do you deliver outside India?', 'Not yet - we currently ship only within India.', ['international', 'abroad', 'outside india']],
        ['Can I change my delivery address?', 'Yes, until the order is shipped. Send the new address with your order number.', ['address', 'change address']],
    ]],
    ['Payments & Refunds', 'payments-refunds', [
        ['Which payment methods do you accept?', 'UPI, all major debit/credit cards, net banking and cash on delivery up to INR 5,000.', ['payment', 'upi', 'card', 'cod']],
        ['How do I get a refund?', 'Refunds are processed to the original payment method within 5-7 working days of pickup.', ['refund', 'money back']],
        ['Is cash on delivery available?', 'Yes, COD is available for orders up to INR 5,000 at most pin codes.', ['cash on delivery', 'cod']],
        ['Do you provide GST invoices?', 'Yes. Share your GSTIN before checkout and the invoice will carry it.', ['gst', 'invoice', 'bill']],
    ]],
];

const TICKETS = [
    ['Order not delivered after 7 days', 'delivery', 'high', 'OPEN', 'Customer shared order number; courier shows "in transit".'],
    ['Wrong size received - exchange request', 'returns', 'normal', 'IN_PROGRESS', 'Pickup scheduled for tomorrow.'],
    ['Refund not credited yet', 'payments', 'urgent', 'WAITING_CUSTOMER', 'Asked customer for UPI transaction reference.'],
    ['Need GST invoice for bulk order', 'billing', 'low', 'RESOLVED', 'Invoice with GSTIN emailed.'],
    ['Damaged packaging on arrival', 'delivery', 'normal', 'CLOSED', 'Replacement shipped and delivered.'],
    ['Query about store opening hours on Sunday', 'general', 'low', 'OPEN', 'Shared Sunday timings.'],
];

const INBOX = [
    ['Rahul Khanna', ['Hi, is the blue kurta available in size L?', 'Also, do you have COD for 411001?']],
    ['Pooja Agarwal', ['My order has not arrived yet', 'Order number is ORD-2291', 'Please check urgently']],
    ['Manoj Pillai', ['What are your Sunday timings?', 'Thanks!']],
    ['Neha Kapoor', ['Can I get a bulk discount for 50 pieces?', 'Need them before the 25th', 'Please share the catalogue']],
];

const OBJECTS = {
    appointment: (i) => ({
        status: ['scheduled', 'confirmed', 'completed', 'rescheduled', 'cancelled', 'no_show'][i],
        data: {
            service: ['Consultation', 'Hair spa', 'Follow-up visit', 'Dental cleaning', 'Skin treatment', 'Physiotherapy'][i],
            scheduledAt: at([1, 2, -3, 4, -1, -2][i], 11 + i), durationMinutes: [30, 60, 20, 45, 40, 50][i],
            staffId: ['Dr. Kavita Rao', 'Sunita', 'Dr. Kavita Rao', 'Dr. Amit Shah', 'Sunita', 'Ramesh'][i], location: 'Main branch',
        },
    }),
    order: (i) => ({
        status: ['placed', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'][i],
        data: {
            amount: [1499, 3290, 899, 5600, 2450, 1200][i], currency: 'INR',
            items: ['Cotton kurta x1', 'Silk saree x1', 'Dupatta x2', 'Lehenga x1', 'Formal shirts x3', 'Kids ethnic set x1'][i],
            trackingId: i >= 3 ? `DTDC${7731200 + i}` : undefined, deliveryAt: at([5, 4, 3, 1, -2, 2][i]),
        },
    }),
    lead: (i) => ({
        status: ['new', 'contacted', 'qualified', 'converted', 'lost', 'new'][i],
        data: {
            name: ['Rohan Mehta', 'Vikram Singh', 'Meera Joshi', 'Siddharth Rao', 'Ishita Bose', 'Tanvi Shah'][i],
            source: ['WhatsApp', 'Instagram', 'Walk-in', 'Website', 'Referral', 'WhatsApp'][i],
            interest: ['Wholesale pricing', 'Wedding bulk order', 'Store visit', 'Corporate gifting', 'Festive collection', 'Franchise enquiry'][i],
            value: [25000, 120000, 8000, 60000, 15000, 500000][i], assignedTo: ['Anil', 'Fatima', 'Anil', 'Fatima', 'Anil', 'Fatima'][i],
        },
    }),
    subscription: (i) => ({
        status: ['active', 'active', 'trial', 'past_due', 'expired', 'cancelled'][i],
        data: {
            plan: ['Gold - Monthly', 'Silver - Quarterly', 'Trial', 'Gold - Monthly', 'Silver - Monthly', 'Platinum - Yearly'][i],
            amount: [999, 2499, 0, 999, 599, 9999][i], currency: 'INR', startsAt: at([-20, -60, -5, -35, -40, -200][i]),
            expiresAt: at([10, 30, 9, -5, -10, 165][i]), autoRenew: [true, true, false, true, false, false][i],
        },
    }),
    event: (i) => ({
        status: ['published', 'published', 'draft', 'full', 'completed', 'cancelled'][i],
        data: {
            title: ['Diwali Mela 2026', 'Yoga in the Park', 'Startup Networking Night', 'Kids Art Workshop', 'Navratri Garba Night', 'Food Walk - Old City'][i],
            startsAt: at([12, 4, 25, 7, -6, 3][i], 18), endsAt: at([12, 4, 25, 7, -6, 3][i], 21),
            venue: ['Community Hall, Koregaon Park', 'Cubbon Park', 'WeWork BKC', 'Studio 5, Indiranagar', 'Club Grounds', 'Chandni Chowk'][i],
            capacity: [300, 50, 120, 25, 500, 20][i],
        },
    }),
    payment: (i) => ({
        status: ['pending', 'pending', 'overdue', 'paid', 'paid', 'overdue'][i],
        data: {
            amount: [4500, 12000, 2800, 7500, 999, 15600][i], currency: 'INR', dueAt: at([5, 12, -4, -10, -2, -15][i]),
            paidAt: [3, 4].includes(i) ? at([-11, -2][i - 3]) : undefined, method: [3, 4].includes(i) ? 'UPI' : undefined,
            invoiceId: `INV-2026-${1040 + i}`,
        },
    }),
};
/** Object type -> the service that owns it. */
const OBJECT_SERVICES = { appointment: 'appointments', order: 'orders', lead: 'leads', subscription: 'subscriptions', event: 'events', payment: 'payment_reminders' };

/** Recipes worth showing per service, in the order they are offered. */
const SERVICE_RECIPES = {
    appointments: 'appointment_reminder', orders: 'order_confirmation', leads: 'lead_welcome', payment_reminders: 'payment_due_reminder',
    subscriptions: 'subscription_renewal', events: 'event_registration', school_whatsapp_bot: 'student_welcome', tickets: 'complaint_to_ticket',
};

const CLASSES = [['10', 'A', 8], ['10', 'B', 6], ['9', 'A', 6]];
const STUDENTS = [
    ['Aanya Sharma', 'Rajesh Sharma', 'Pooja Sharma'], ['Vihaan Patel', 'Suresh Patel', 'Nisha Patel'],
    ['Diya Nair', 'Manoj Nair', 'Lakshmi Nair'], ['Arnav Gupta', 'Amit Gupta', 'Ritu Gupta'],
    ['Saanvi Reddy', 'Srinivas Reddy', 'Padma Reddy'], ['Kabir Singh', 'Harpreet Singh', 'Simran Kaur'],
    ['Myra Iyer', 'Venkat Iyer', 'Gayatri Iyer'], ['Reyansh Joshi', 'Prakash Joshi', 'Meena Joshi'],
    ['Anika Das', 'Subhash Das', 'Rina Das'], ['Ayaan Khan', 'Imran Khan', 'Sana Khan'],
    ['Ira Menon', 'Ravi Menon', 'Asha Menon'], ['Shaurya Verma', 'Deepak Verma', 'Kavita Verma'],
    ['Kiara Desai', 'Hitesh Desai', 'Bhavna Desai'], ['Atharv Kulkarni', 'Sanjay Kulkarni', 'Swati Kulkarni'],
    ['Navya Pillai', 'Gopal Pillai', 'Sheela Pillai'], ['Rudra Chauhan', 'Vikas Chauhan', 'Anjali Chauhan'],
    ['Pari Agarwal', 'Mukesh Agarwal', 'Sunita Agarwal'], ['Dhruv Bansal', 'Naveen Bansal', 'Rekha Bansal'],
    ['Avni Mishra', 'Alok Mishra', 'Shalini Mishra'], ['Yash Tiwari', 'Rakesh Tiwari', 'Neelam Tiwari'],
];
const SUBJECTS = ['English', 'Hindi', 'Mathematics', 'Science', 'Social Science'];
const TEACHERS = { English: 'Mrs. D Fernandes', Hindi: 'Mr. R Tripathi', Mathematics: 'Mr. S Krishnan', Science: 'Mrs. P Banerjee', 'Social Science': 'Ms. A Qureshi', Computer: 'Mr. V Arora', 'Physical Education': 'Mr. K Gill' };
const PERIODS = [['1', '08:30', '09:15'], ['2', '09:15', '10:00'], ['3', '10:20', '11:05'], ['4', '11:05', '11:50'], ['5', '12:30', '13:15']];
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const gradeFor = (percent) => [[91, 'A1'], [81, 'A2'], [71, 'B1'], [61, 'B2'], [51, 'C1'], [41, 'C2'], [33, 'D']]
    .find(([min]) => percent >= min)?.[1] ?? 'E';

// --------------------------------------------------------------- seeder --

/**
 * @param {object} state a channel runtime's state (the stores the routes use)
 * @param {{ services: string[], tenantName?: string }} options
 * @returns {Promise<{ created: Record<string, number>, skipped: string[] }>}
 */
export async function seedTenant(state, { services = [], tenantName = '' } = {}) {
    const on = (service) => services.includes(service);
    const created = {};
    const existed = {};
    const skipped = [];
    const made = (key) => { created[key] = (created[key] ?? 0) + 1; };
    const had = (key) => { existed[key] = (existed[key] ?? 0) + 1; };
    const channelId = state.channel?.id ?? null;
    // No emit: seeded objects must never start a workflow.
    const objects = new ObjectStore(state.db);
    const { contacts } = state;

    const createObject = async (key, type, reference, body) => {
        if (objects.getByReference(type, reference)) return had(key);
        await objects.create(type, { reference, metadata: { seed: true }, source: 'seed', ...body });
        made(key);
    };
    const contactIdFor = (i) => contacts.getByPhone(contacts.normalize(contactPhone(i % CONTACTS.length)))?.id ?? null;

    if (on('contacts')) {
        CONTACTS.forEach(([name, city, tags, fields], i) => {
            const number = contacts.normalize(contactPhone(i));
            if (contacts.getByPhone(number)) return had('contacts');
            const [first] = name.split(' ');
            contacts.upsert({
                phone: number, normalized: true, name, email: `${first.toLowerCase()}${i + 1}@example.com`,
                tags: [...tags, city.toLowerCase()], customFields: { city, ...fields }, source: 'seed',
                optInStatus: i % 4 === 3 ? 'unknown' : 'opted_in',
            });
            made('contacts');
        });
        const segments = new Set(contacts.listSegments().map((s) => s.name));
        for (const [name, filter] of [['VIP customers', { tags: ['vip'] }], ['Open leads', { tags: ['lead'] }]]) {
            if (segments.has(name)) { had('segments'); continue; }
            contacts.saveSegment({ name, filter });
            made('segments');
        }
    }

    if (on('templates')) {
        for (const [name, body] of TEMPLATES) {
            if (state.templates.getByName(name)) { had('templates'); continue; }
            state.templates.create({ name, body, channelId });
            made('templates');
        }
    }

    if (on('auto_replies')) {
        const keywords = new Set(state.db.getAutoReplies().map((r) => String(r.keyword).toLowerCase()));
        for (const [keyword, matchType, replyBody] of AUTO_REPLIES) {
            if (keywords.has(keyword)) { had('autoReplies'); continue; }
            state.db.saveAutoReply({ keyword, matchType, replyBody, isActive: 1, cooldownSec: 300 });
            made('autoReplies');
        }
    }

    if (on('faq')) {
        const questions = new Set(state.knowledge.list().map((q) => q.question.toLowerCase()));
        for (const [name, slug, items] of FAQ) {
            let category = state.knowledge.getCategoryBySlug(slug);
            if (category) had('faqCategories');
            else { category = state.knowledge.createCategory({ name, slug }); made('faqCategories'); }
            for (const [question, answer, keywords] of items) {
                if (questions.has(question.toLowerCase())) { had('faqItems'); continue; }
                state.knowledge.create({ question, answer, keywords, categoryId: category.id });
                made('faqItems');
            }
        }
    }

    if (on('tickets')) {
        const subjects = new Set(state.tickets.list({ limit: 1000 }).filter((t) => t.metadata?.seed).map((t) => t.subject));
        for (const [i, [subject, category, priority, status, note]] of TICKETS.entries()) {
            if (subjects.has(subject)) { had('tickets'); continue; }
            const ticket = state.tickets.create({
                subject, category, priority, contactId: on('contacts') ? contactIdFor(i) : null, channelId,
                metadata: { seed: true },
            });
            if (status !== 'OPEN') state.tickets.setStatus(ticket.id, status);
            state.tickets.addNote(ticket.id, note);
            made('tickets');
        }
    }

    if (on('inbox')) {
        const exists = state.db.db.prepare('SELECT 1 FROM inbound_messages WHERE tenant_id = ? AND message_id = ?');
        for (const [c, [senderName, bodies]] of INBOX.entries()) {
            const sender = contacts.normalize(phone('300', 101 + c));
            if (!state.conversations.getByPhone(sender, channelId)) made('conversations');
            for (const [m, body] of bodies.entries()) {
                const messageId = `demo-inbox-${c + 1}-${m + 1}`;
                if (exists.get(state.db.tenantId, messageId)) { had('inboundMessages'); continue; }
                // Oldest first, a few minutes apart; each conversation an hour or so older than the last.
                const receivedAt = at(0, -(c * 3 + 1) + m * 0.1);
                const saved = state.db.insertInbound({ messageId, sender, senderName, body, receivedAt });
                state.conversations.upsertForInbound({ phone: saved.sender, channelId, at: saved.receivedAt });
                made('inboundMessages');
            }
        }
    }

    for (const [type, service] of Object.entries(OBJECT_SERVICES)) {
        if (!on(service)) continue;
        const key = `${type}s`;
        for (let i = 0; i < 6; i += 1) {
            const { status, data } = OBJECTS[type](i);
            const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
            await createObject(key, type, `demo-${type}-${i + 1}`, {
                status, data: clean, contactId: on('contacts') ? contactIdFor(i * 2) : null,
            });
        }
    }

    if (on('school_whatsapp_bot')) await seedSchool(state, { objects, createObject, made, had, tenantName });

    if (on('campaigns') || on('bulk_messages')) {
        if (!state.campaigns) skipped.push('campaigns: campaign store not available');
        else {
            const name = 'Diwali offer (demo)';
            if (state.campaigns.list({ limit: 1000 }).some((c) => c.name === name)) had('campaigns');
            else {
                const segment = contacts.listSegments().find((s) => s.name === 'VIP customers');
                state.campaigns.create({
                    name, status: 'draft', channelId, segmentId: segment?.id ?? null,
                    body: 'Hi {name}, our Diwali sale is live! Flat 20% off on the festive collection till Sunday. Reply SHOP to browse.',
                });
                made('campaigns');
            }
        }
    }

    if (on('workflows')) {
        const keys = [...new Set([
            ...Object.entries(SERVICE_RECIPES).filter(([service]) => on(service)).map(([, key]) => key),
            'complaint_to_ticket', 'lead_welcome', 'appointment_reminder',
        ])].slice(0, 3);
        const names = new Set(state.workflows.list().map((w) => w.name));
        for (const key of keys) {
            const recipe = getRecipe(key);
            if (names.has(recipe.build().name)) { had('workflows'); continue; }
            installRecipe(recipe, { workflows: state.workflows, templates: state.templates, channelId, status: 'draft' });
            made('workflows');
        }
    }

    for (const [key, n] of Object.entries(existed)) skipped.push(`${key}: ${n} already existed`);
    const nothing = ['whatsapp_channels', 'api', 'analytics', 'integrations', 'ai'].filter(on);
    if (nothing.length) skipped.push(`no demo data for: ${nothing.join(', ')}`);
    return { created, skipped };
}

async function seedSchool(state, { objects, createObject, made, had, tenantName }) {
    const { db, contacts } = state;
    if (!getSettings(db.db, db.tenantId).schoolName) {
        saveSettings(db.db, db.tenantId, {
            schoolName: /school|academy|vidyalaya|college/i.test(tenantName) ? tenantName : 'Green Valley Public School',
            upiId: 'greenvalley@okaxis', payeeName: 'Green Valley Public School',
        });
        made('schoolSettings');
    }

    // ---- students + parent contacts (same tags and fields as the school's saveStudent)
    const roster = listAll(objects, { type: 'student' });
    const students = [];
    let n = 0;
    for (const [className, section, size] of CLASSES) {
        const key = classKeyOf({ className, section });
        for (let roll = 1; roll <= size; roll += 1, n += 1) {
            const [name, fatherName, motherName] = STUDENTS[n];
            const reference = `demo-stu-${key.toLowerCase()}-${roll}`;
            const existing = objects.getByReference('student', reference)
                ?? roster.find((o) => classKeyOf(o.data) === key && String(o.data.rollNumber) === String(roll));
            // A real student holding this roll number is left alone, along with everything hung off it.
            if (existing) { had('students'); if (existing.metadata?.seed) students.push(existing); continue; }
            const busRoute = n % 3 === 0 ? `Route ${1 + (n % 4)}` : '';
            const tags = ['student', 'school', `class-${key.toLowerCase()}`];
            if (busRoute) tags.push(`route-${busRoute.toLowerCase().replace(/\s+/g, '-')}`);
            const contact = contacts.upsert({
                phone: contacts.normalize(phone('200', 101 + n)), normalized: true, name: fatherName, tags,
                customFields: { studentName: name, rollNumber: String(roll), classKey: key }, source: 'school',
            });
            const student = await objects.create('student', {
                reference, contactId: contact.id, status: 'active', metadata: { seed: true }, source: 'seed',
                data: {
                    name, rollNumber: String(roll), className, section, fatherName, motherName,
                    parentPhone: contact.phone, busRoute, hostel: n % 7 === 0,
                },
            });
            made('students');
            students.push(student);
        }
    }

    // ---- attendance: the last 5 school days (Mon-Sat), the school's own reference convention
    const tz = state.channel?.timezone;
    const days = [];
    for (let back = 0; days.length < 5 && back < 14; back += 1) {
        const local = localNow(tz, new Date(Date.now() - back * DAY));
        if (local.day !== 'Sun') days.push(local.date);
    }
    for (const [d, date] of days.entries()) {
        for (const [i, s] of students.entries()) {
            const roll = (i * 7 + d * 3) % 20;
            const status = roll === 0 ? 'absent' : roll === 1 ? 'late' : roll === 2 && d === 3 ? 'excused' : 'present';
            await createObject('attendance', 'attendance', `att-${s.id}-${date}`, {
                status, contactId: s.contactId,
                data: {
                    studentId: s.id, rollNumber: s.data.rollNumber, studentName: s.data.name, className: s.data.className,
                    section: s.data.section, date: `${date}T00:00:00.000Z`, arrivedAt: status === 'late' ? '08:41' : null, markedBy: 'demo',
                },
            });
        }
    }

    // ---- timetable for 10A, Mon-Sat
    for (const [d, day] of WEEK.entries()) {
        for (const [p, [period, startTime, endTime]] of PERIODS.entries()) {
            const subject = d === 5 && p >= 3 ? (p === 3 ? 'Computer' : 'Physical Education') : SUBJECTS[(d + p) % SUBJECTS.length];
            await createObject('timetable', 'timetable', `tt-10a-${day}-${period}`.toLowerCase(), {
                status: 'scheduled',
                data: { className: '10', section: 'A', day, period, startTime, endTime, subject, teacher: TEACHERS[subject], room: 'R-104' },
            });
        }
    }

    // ---- homework: marked as already sent so the sweep never sends it
    const homework = [
        ['10', 'A', 'Mathematics', 'Quadratic equations - Exercise 4.3', 'Solve Q1 to Q8 in the notebook. Show all steps.', 2],
        ['10', 'B', 'Science', 'Chemical reactions worksheet', 'Complete the worksheet shared in class and balance every equation.', 3],
    ];
    for (const [i, [className, section, subject, title, instructions, due]] of homework.entries()) {
        const key = classKeyOf({ className, section });
        await createObject('homework', 'homework', `demo-hw-${i + 1}`, {
            status: 'assigned',
            data: { className, section, subject, title, instructions, assignedAt: at(0, -3), dueAt: at(due), teacher: TEACHERS[subject] },
            metadata: { seed: true, classKey: key, sendAt: null, sentAt: at(0, -3) },
        });
    }

    // ---- fees: paid / pending (future due) / overdue (already overdue, so the sweep does not flip it)
    for (const [i, s] of students.entries()) {
        const kind = ['paid', 'paid', 'pending', 'overdue', 'paid'][i % 5];
        const fee = {
            studentId: s.id, studentName: s.data.name, className: s.data.className, section: s.data.section,
            term: 'Term 2', amount: s.data.className === '10' ? 18500 : 16500, currency: 'INR',
            dueAt: kind === 'pending' ? at(20) : at(-10),
        };
        if (kind === 'paid') Object.assign(fee, { paidAt: at(-12 - (i % 5)), method: i % 2 ? 'UPI' : 'Cash', receiptNo: `RCPT-DEMO-${1001 + i}` });
        await createObject('fees', 'fee', `fee-${s.id}-term-2`, { status: kind, contactId: s.contactId, data: fee });
    }

    // ---- notices
    const notices = [
        ['holiday', 'Diwali vacation', 'School remains closed for Diwali vacation. Classes resume on the Monday after.', 14, 19],
        ['exam', 'Half-yearly examination date sheet', 'Half-yearly exams begin next month. The date sheet is attached on the notice board and app.', 30, 40],
    ];
    for (const [kind, title, body, from, to] of notices) {
        await createObject('notices', 'notice', `demo-notice-${kind}`, {
            status: 'published', data: { kind, title, body, startsAt: at(from), endsAt: at(to), audience: JSON.stringify({ all: true }) },
            metadata: { seed: true, sendAt: null },
        });
    }

    // ---- exam results: Unit Test 2 for 10A
    for (const [i, s] of students.filter((o) => classKeyOf(o.data) === '10A').entries()) {
        const breakdown = SUBJECTS.map((subject, j) => ({ subject, marks: 28 + ((i * 7 + j * 5) % 23), total: 50 }));
        const marks = breakdown.reduce((sum, b) => sum + b.marks, 0);
        const totalMarks = breakdown.length * 50;
        await createObject('examResults', 'exam_result', `res-${s.id}-unit-test-2`, {
            status: 'published', contactId: s.contactId,
            data: {
                studentId: s.id, rollNumber: s.data.rollNumber, studentName: s.data.name, className: s.data.className,
                section: s.data.section, examName: 'Unit Test 2', marks, totalMarks, grade: gradeFor((marks / totalMarks) * 100),
                breakdown: JSON.stringify(breakdown), publishedAt: at(-2),
            },
        });
    }
}
