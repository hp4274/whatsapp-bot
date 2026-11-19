/** Shot plan for the School guide. See ../guide-shots.mjs for the plan shape. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tab = (name) => `/school?tab=${name}`;

/** Tag the first visible `sel` whose text contains `text` (or the first visible `within` inside it); returns its selector. */
const tag = (h, sel, text, name, within = null) => h.page.evaluate((sel, text, name, within) => {
    const el = [...document.querySelectorAll(sel)].find((n) => n.checkVisibility() && n.textContent.includes(text));
    const t = el && within ? [...el.querySelectorAll(within)].find((n) => n.checkVisibility()) : el;
    if (t) t.dataset.g = name;
    return `[data-g="${name}"]`;
}, sel, text, name, within);
let seq = 0;
/** Click the first visible `sel` whose text contains `text` (or `within` inside it). */
const press = async (h, sel, text = '', within = null) => h.click({ selector: await tag(h, sel, text, `p${++seq}`, within) });

/** Set a field the way typing would (input + change events), so Angular's ngModel sees it. A number picks a <select> option by index. */
const fill = async (h, sel, value) => {
    await h.page.evaluate((sel, value) => {
        const el = [...document.querySelectorAll(sel)].find((n) => n.checkVisibility()) ?? document.querySelector(sel);
        if (!el) return;
        if (el instanceof HTMLSelectElement && typeof value === 'number') el.selectedIndex = value;
        else {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
                : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, sel, value);
    await h.settle(300);
};
/** A plain DOM click, for buttons the mouse click misses. */
/** The shot ring sits under a native popover (top layer), so a control inside one gets the same ring as an outline. */
const outline = (h, sel) => h.page.evaluate((sel) => {
    document.querySelectorAll('[data-outlined]').forEach((n) => { n.style.outline = ''; n.style.boxShadow = ''; delete n.dataset.outlined; });
    const el = sel && document.querySelector(sel);
    if (!el) return;
    el.dataset.outlined = '';
    Object.assign(el.style, { outline: '3px solid #f97316', outlineOffset: '5px', boxShadow: '0 0 0 14px rgba(249,115,22,.22)' });
}, sel);
const domClick = async (h, sel) => {
    await h.page.evaluate((sel) => document.querySelector(sel)?.click(), sel);
    await h.settle(500);
};
const upload = async (h, sel, file) => {
    const el = await h.page.$(sel);
    if (el) await el.uploadFile(file);
    await h.settle(1500);
};

const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => {
    const d = new Date(Date.now() + offset * 86_400_000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-school-'));
const WORKSHEET = path.join(DIR, 'Quadratics-worksheet.pdf');
const CIRCULAR = path.join(DIR, 'Annual-Day-circular.pdf');
const STUDENTS_CSV = path.join(DIR, 'new-admissions.csv');
const MARKS_CSV = path.join(DIR, 'half-yearly-10A.csv');
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
    + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

export default {
    async setup(h) {
        fs.writeFileSync(WORKSHEET, PDF);
        fs.writeFileSync(CIRCULAR, PDF);
        fs.writeFileSync(STUDENTS_CSV, [
            'Roll No,Student Name,Class,Section,Father Name,Mother Name,Parent Phone,Bus Route,Hostel',
            '21,Ishaan Malhotra,9,B,Vikram Malhotra,Sonal Malhotra,9876512101,Route 2,No',
            '22,Myra Kapoor,9,B,Rohit Kapoor,Anjali Kapoor,9876512102,,No',
            '23,Reyansh Joshi,9,B,Deepak Joshi,Kiran Joshi,98765,,No',
            '24,,9,B,Sanjay Rao,Meena Rao,9876512104,Route 1,Yes',
            '25,Kiara Singh,9,B,Harpreet Singh,Simran Singh,9876512105,,No',
        ].join('\n') + '\n');
        fs.writeFileSync(MARKS_CSV, [
            'Roll,Maths,Science,English,Hindi,Social Science',
            ...Array.from({ length: 8 }, (_, i) => [i + 1, 62 + ((i * 7) % 35), 58 + ((i * 11) % 40), 70 + ((i * 5) % 28), 66 + ((i * 3) % 30), 60 + ((i * 9) % 36)].join(',')),
        ].join('\n') + '\n');

        // Staff to give titles to (the Team page is where people are added).
        const meera = (await h.api('POST', '/api/users', { name: 'Meera Iyer', email: 'meera.iyer@sunrise.demo', password: 'Sunrise#2026pass', role: 'agent' })).user;
        const rahul = (await h.api('POST', '/api/users', { name: 'Rahul Menon', email: 'rahul.menon@sunrise.demo', password: 'Sunrise#2026pass', role: 'agent' })).user;
        if (rahul) await h.api('PUT', `/api/school/staff/${rahul.id}`, { title: 'accounts', classes: [] });
        void meera;

        // Leave requests, as parents texting LEAVE would open them.
        const { students = [] } = await h.api('GET', '/api/school/students');
        const leave = [
            [students[1], 'Fever since last night, doctor advised rest', 1, 2],
            [students[9], 'Family wedding in Jaipur', 3, 5],
            [students[15], 'Dental appointment in the morning', 1, 1],
        ];
        for (const [s, reason, from, to] of leave) {
            if (!s) continue;
            await h.api('POST', '/api/tickets', {
                category: 'leave_request', source: 'keyword', contactId: s.contactId,
                subject: `Leave: ${s.name} (${s.classKey})`,
                metadata: { studentId: s.id, studentName: s.name, classKey: s.classKey, parentPhone: s.parentPhone, reason, fromDate: day(from), toDate: day(to) },
            });
        }

        // PTM: tomorrow's slots, two already booked by parents.
        const start = new Date(`${day(1)}T10:00:00`).toISOString();
        const { slots = [] } = await h.api('POST', '/api/school/ptm/slots', { startsAt: start, durationMinutes: 10, teacher: 'Mrs. Kapoor', classKey: '10A', count: 6 });
        for (const [i, slot] of [slots[0], slots[2]].entries()) {
            const s = students[i * 3];
            if (!slot || !s) continue;
            await h.api('PUT', `/api/objects/appointment/${slot.id}`, {
                contactId: s.contactId, notify: false,
                metadata: { kind: 'ptm_slot', classKey: '10A', studentName: s.name, parentPhone: s.parentPhone },
            });
        }
    },
    tasks: {
        // Set up your school
        1: {
            path: tab('overview'),
            steps: {
                1: { act: (h) => tag(h, '.sp-rail button[role=tab]', 'Settings', 'set'), ring: { selector: '[data-g="set"]' }, click: true },
                2: {
                    act: async (h) => {
                        await fill(h, '#st-name', 'Sunrise Public School');
                        await fill(h, '#st-gate', '08:10');
                        await fill(h, '#st-hw', '16:00');
                    },
                    ring: { selector: 'form.grid > section.s-card:nth-of-type(1)' },
                    click: false,
                },
                3: {
                    act: async (h) => {
                        await h.click({ selector: 'form.grid button[role=switch]' });
                        await fill(h, '#st-absent', '10:30');
                    },
                    ring: { selector: 'form.grid .auto .row:first-child' },
                    click: false,
                },
                4: {
                    act: async (h) => {
                        await fill(h, '#st-upi', 'sunriseschool@okhdfcbank');
                        await fill(h, '#st-payee', 'Sunrise Public School');
                    },
                    ring: { selector: '.savebar' },
                    click: false,
                    after: (h) => h.click({ selector: '.savebar button[type=submit]' }),
                },
            },
        },
        // Add your students
        2: {
            path: tab('overview'),
            steps: {
                1: { act: (h) => tag(h, '.sp-rail button[role=tab]', 'Students', 'stu'), ring: { selector: '[data-g="stu"]' }, click: true },
                2: {
                    act: async (h) => {
                        await press(h, '.head-actions button', 'Add student');
                        await fill(h, '#sf-name', 'Advait Kulkarni');
                        await fill(h, '#sf-roll', '9');
                        await fill(h, '#sf-class', '10');
                        await fill(h, '#sf-section', 'A');
                        await fill(h, '#sf-father', 'Nitin Kulkarni');
                        await fill(h, '#sf-phone', '9876512009');
                    },
                    ring: { selector: 'aside.s-drawer' },
                    click: false,
                    after: async (h) => {
                        await h.click({ selector: 'aside.s-drawer .drawer-actions .btn.primary' });
                        await h.settle(800);
                    },
                },
                3: {
                    act: (h) => tag(h, '.head-actions', 'Sample CSV', 'heads'),
                    ring: { selector: '[data-g="heads"]' },
                    click: false,
                    after: (h) => upload(h, 'input[type=file][accept=".csv,.xlsx,.xls"]', STUDENTS_CSV),
                },
                4: { act: (h) => h.settle(800), ring: { selector: '.s-card.errs' } },
            },
        },
        // Give staff the right access
        3: {
            path: '/team',
            steps: {
                1: { ring: { selector: 'form.invite' }, click: false, after: (h) => h.goto(tab('staff')) },
                2: {
                    act: async (h) => {
                        const sel = await tag(h, 'ul.people > li', 'Meera Iyer', 'meera-sel', 'select');
                        await fill(h, sel, 'class_teacher');
                    },
                    ring: { selector: '[data-g="meera-sel"]' },
                    click: false,
                },
                3: {
                    act: async (h) => {
                        await press(h, 'ul.people > li .picks label', '10A');
                        await press(h, 'ul.people > li .picks label', '10B');
                        await tag(h, 'ul.people > li', 'Meera Iyer', 'meera');
                    },
                    ring: { selector: '[data-g="meera"]' },
                    click: false,
                    after: (h) => press(h, 'ul.people > li', 'Meera Iyer', '.ctl button'),
                },
            },
        },
        // Take attendance
        4: {
            path: tab('attendance'),
            steps: {
                1: { ring: { selector: '.class-pick' }, click: false },
                2: {
                    act: (h) => h.click({ selector: '.sheet tbody tr:nth-child(3) .s-seg button[aria-label="Absent"]' }),
                    ring: { selector: '.sheet tbody tr:nth-child(3) .s-seg' },
                    click: false,
                },
                3: { act: (h) => tag(h, '.sheet-bar .bar-actions button', 'Save', 'save'), ring: { selector: '[data-g="save"]' }, click: true },
                4: { act: (h) => tag(h, '.sheet-bar .bar-actions button', 'Upload', 'up'), ring: { selector: '[data-g="up"]' }, click: false },
            },
        },
        // Tell parents their child is absent
        5: {
            path: tab('attendance'),
            steps: {
                1: {
                    act: async (h) => {
                        await h.click({ selector: '.sheet tbody tr:nth-child(5) .s-seg button[aria-label="Absent"]' });
                        await tag(h, '.sheet-bar .bar-actions button', 'Save', 'save5');
                    },
                    ring: { selector: '[data-g="save5"]' },
                    click: true,
                },
                2: {
                    act: (h) => h.click({ selector: 'section.notify label.check' }),
                    ring: { selector: 'section.notify label.check' },
                    click: false,
                },
                3: {
                    act: (h) => domClick(h, 'section.notify .notify-act .btn.primary'),
                    ring: { selector: 'section.notify .notify-act' },
                    click: false,
                    after: (h) => domClick(h, 'section.notify .notify-act .btn.primary'),
                },
            },
        },
        // A student's month
        6: {
            path: tab('attendance'),
            steps: {
                1: { ring: { selector: '.sheet tbody tr:nth-child(1) button[aria-label^="Monthly history"]' }, click: true },
                2: { act: (h) => h.settle(800), ring: { selector: 'aside.s-drawer' }, click: false },
            },
        },
        // Build the timetable
        7: {
            path: tab('timetable'),
            steps: {
                1: { act: (h) => tag(h, '.head-actions button', 'Edit', 'edit'), ring: { selector: '[data-g="edit"]' }, click: true },
                2: { act: (h) => tag(h, '.head-actions button', 'Add period', 'addp'), ring: { selector: '[data-g="addp"]' }, click: true },
                3: {
                    act: async (h) => {
                        await h.click({ selector: 'table.tt tbody tr:last-child td:first-of-type button.slot' });
                        await fill(h, '#tt-subject', 'Art & Craft');
                        await fill(h, '#tt-teacher', 'Ms. Fernandes');
                        await fill(h, '#tt-room', 'Art room');
                        await outline(h, '.pop form.pop-form');
                    },
                    ring: { selector: '.pop form.pop-form' },
                    click: false,
                    after: async (h) => {
                        await outline(h, null);
                        await h.click({ selector: '.pop .pop-form button[type=submit]' });
                    },
                },
                4: {
                    act: (h) => tag(h, '.head-actions button', 'Save', 'savett'),
                    ring: { selector: '[data-g="savett"]' },
                    click: true,
                },
            },
        },
        // Changed or cancelled period
        8: {
            path: tab('timetable'),
            before: (h) => fill(h, '.class-pick select', '10A'),
            steps: {
                1: { ring: { selector: 'table.tt tbody tr:nth-child(2) td:first-of-type button.slot' }, click: true },
                2: {
                    act: async (h) => {
                        await press(h, '.pop .s-seg[aria-label="Change type"] button', 'ancel');
                        await fill(h, '#tt-note', 'Hindi teacher on leave today - students go to the library.');
                        await outline(h, '.pop form.pop-form');
                    },
                    ring: { selector: '.pop form.pop-form' },
                    click: false,
                },
                3: {
                    act: async (h) => {
                        await h.page.evaluate(() => {
                            const box = document.querySelector('.pop label.check input');
                            if (box && !box.checked) box.click();
                        });
                        await outline(h, '.pop form.pop-form button[type=submit]');
                    },
                    ring: { selector: '.pop form.pop-form button[type=submit]' },
                    click: true,
                    after: (h) => outline(h, null),
                },
            },
        },
        // Send homework
        9: {
            path: tab('homework'),
            steps: {
                1: {
                    act: async (h) => {
                        await fill(h, '#hw-class', '10A');
                        await fill(h, '#hw-subject', 'Mathematics');
                        await fill(h, '#hw-title', 'Quadratic equations - Exercise 4.4');
                        await fill(h, '#hw-desc', 'Solve Q1 to Q6 from Exercise 4.4 in your notebook. Show every step.');
                        await fill(h, '#hw-due', day(2));
                    },
                    ring: { selector: '.split > form.s-card' },
                    click: false,
                },
                2: {
                    act: async (h) => {
                        await upload(h, '.split > form.s-card label.drop input[type=file]', WORKSHEET);
                        await tag(h, '.split > form.s-card .field', 'Worksheet', 'ws');
                    },
                    ring: { selector: '[data-g="ws"]' },
                    click: false,
                },
                3: {
                    act: async (h) => {
                        await press(h, '.s-seg[aria-label="Send mode"] button', 'Schedule');
                        await fill(h, '.when input[type=time]', '16:30');
                    },
                    ring: { selector: '.split > form.s-card .when' },
                    click: false,
                },
                4: { ring: { selector: '.split' }, click: false, after: (h) => h.click({ selector: '.split > form.s-card .actions .btn.primary' }) },
            },
        },
        // Notices
        10: {
            path: tab('notices'),
            steps: {
                1: { act: (h) => press(h, '.kinds button', 'Event'), ring: { selector: '.split > form .kinds' }, click: false },
                2: {
                    act: async (h) => {
                        await fill(h, '#n-title', 'Annual Day celebrations');
                        await fill(h, '#n-body', 'Our Annual Day is on Saturday at 5 pm in the school auditorium. Parents are warmly invited.');
                        await fill(h, '#n-start', day(9));
                        await fill(h, '#n-end', day(9));
                        await upload(h, '.split > form label.drop input[type=file]', CIRCULAR);
                    },
                    ring: { selector: '.split > form .form' },
                    click: false,
                },
                3: {
                    act: async (h) => {
                        await press(h, '.split > form .s-seg[aria-label="Audience"] button', 'Classes');
                        await press(h, '.split > form .picks label', '10A');
                        await press(h, '.split > form .picks label', '10B');
                        await tag(h, '.split > form .field', 'Audience', 'aud');
                    },
                    ring: { selector: '[data-g="aud"]' },
                    click: false,
                },
                4: { ring: { selector: '.split > form .field.toggles' }, click: false },
                5: { ring: { selector: '.split > form .actions .btn.primary' }, click: true },
            },
        },
        // Urgent broadcast
        11: {
            path: tab('broadcast'),
            steps: {
                1: { act: (h) => press(h, '.kinds button', 'Emergency closure'), ring: { selector: '.kinds' }, click: false },
                2: { act: (h) => press(h, '.tpls button', 'Heavy rain'), ring: { selector: '.split > section:nth-child(1)' }, click: false },
                3: {
                    act: async (h) => {
                        await press(h, '.split .s-seg[aria-label="Audience"] button', 'Classes');
                        await press(h, '.split .picks label', '10A');
                        await press(h, '.split .picks label', '10B');
                    },
                    ring: { selector: '.split > section:nth-child(2)' },
                    click: false,
                },
                4: { act: (h) => h.click({ selector: '.fire .btn.launch' }), ring: { selector: '.fire .btn.launch' }, click: true },
            },
        },
        // Add and collect fees
        12: {
            path: tab('fees'),
            steps: {
                1: { ring: { selector: '.s-head .actions' }, click: false, after: (h) => press(h, '.s-head .actions button', 'Fee for a student') },
                2: {
                    act: async (h) => {
                        await fill(h, '#fc-class', '10A');
                        await h.settle(800);
                        await fill(h, '#fc-student', 2);
                        await fill(h, '#fc-term', 'Annual Day costume');
                        await fill(h, '#fc-amt', '850');
                        await fill(h, '#fc-due', day(10));
                        await fill(h, '#fc-link', 'https://pay.sunriseschool.in/annual-day');
                    },
                    ring: { selector: 'form.create' },
                    click: false,
                    after: (h) => h.click({ selector: 'form.create .actions .btn.primary' }),
                },
                3: {
                    act: async (h) => {
                        await press(h, '.ledger tbody tr', 'Overdue', '.row-actions button');
                        await fill(h, '.ledger .pay select', 'UPI');
                    },
                    ring: { selector: '.ledger .pay' },
                    click: false,
                    after: (h) => h.click({ selector: '.ledger .pay .btn.primary' }),
                },
            },
        },
        // Remind parents about fees
        13: {
            path: tab('fees'),
            steps: {
                1: {
                    act: async (h) => {
                        await fill(h, '#ff-class', '10A');
                        await press(h, '.ledger .filters .s-seg button', 'overdue');
                    },
                    ring: { selector: '.ledger .filters' },
                    click: false,
                },
                2: {
                    act: async (h) => {
                        await press(h, '.ledger .filters .s-seg button', 'All');
                        await h.click({ selector: '.ledger tbody tr:nth-child(1) input[type=checkbox]' });
                        await h.click({ selector: '.ledger tbody tr:nth-child(2) input[type=checkbox]' });
                    },
                    ring: { selector: '.ledger .bar .actions button:nth-child(1)' },
                    click: false,
                },
                3: { ring: { selector: '.ledger .bar .actions button:nth-child(2)' }, click: false },
            },
        },
        // Leave
        14: {
            path: tab('leave'),
            steps: {
                1: { ring: { selector: '.grid .req' }, click: false },
                2: {
                    act: async (h) => {
                        await h.click({ selector: '.grid .req .actions.btns .btn.primary' });
                        await fill(h, '.grid .req .decide input', 'Get well soon. Homework will be shared on WhatsApp.');
                    },
                    ring: { selector: '.grid .req .decide' },
                    click: false,
                },
            },
        },
        // Results
        15: {
            path: tab('results'),
            steps: {
                1: {
                    act: async (h) => {
                        await fill(h, '#r-exam', 'Half-yearly');
                        await fill(h, '#r-class', '10A');
                    },
                    ring: { selector: '.split > form .form' },
                    click: false,
                },
                2: {
                    act: (h) => upload(h, '.split > form label.drop input[type=file]', MARKS_CSV),
                    ring: { selector: '.split > form' },
                    click: false,
                    after: async (h) => {
                        await h.click({ selector: '.split > form .actions .btn.primary' });
                        await h.settle(1200);
                    },
                },
                3: {
                    act: async (h) => {
                        await fill(h, '#rv-class', '10A');
                        await fill(h, '#rv-exam', 'Half-yearly');
                        await h.settle(800);
                    },
                    ring: { selector: '.split > aside' },
                    click: false,
                },
                4: { act: (h) => h.click({ selector: 'section.s-card .bar > button.btn' }), ring: { selector: 'section.s-card .bar > button.btn' }, click: true },
            },
        },
        // PTM
        16: {
            path: tab('ptm'),
            steps: {
                1: {
                    act: async (h) => {
                        await fill(h, '#ptm-start', `${day(2)}T15:00`);
                        await fill(h, '#ptm-dur', '15');
                        await fill(h, '#ptm-count', '8');
                    },
                    ring: { selector: 'form.create' },
                    click: false,
                },
                2: {
                    act: async (h) => {
                        await fill(h, '#ptm-teacher', 'Mr. Sharma');
                        await fill(h, '#ptm-class', '10B');
                    },
                    ring: { selector: 'form.create > button[type=submit]' },
                    click: true,
                },
                3: { act: (h) => h.settle(800), ring: { selector: '.board article.day' }, click: false },
            },
        },
        // Overview
        17: {
            path: tab('overview'),
            steps: {
                1: { ring: { selector: '.sp-body .grid' }, click: false },
                2: { ring: { selector: 'section.actions' }, click: false },
                3: { act: (h) => h.goto(tab('students')), ring: { selector: '.class-pick' }, click: false },
            },
        },
    },
};
