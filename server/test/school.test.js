/** School Assistant: roster, attendance, fees, results, leave, commands, staff gates. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-school-'));
let app;
let server;
let base;
let db;
let owner;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};
const upload = async (token, url, csv, fields = {}) => {
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'x.csv');
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetch(base + url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, body: await res.json() };
};
const sentTo = (phone) => db.db.prepare('SELECT message FROM messages WHERE recipient LIKE ?')
    .all(`%${String(phone).replace(/\D/g, '').slice(-10)}%`).map((r) => r.message);
const inbound = (from, body) => fetch(`${base}/api/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entry: [{ changes: [{ value: {
        contacts: [{ wa_id: from, profile: { name: 'Parent' } }],
        messages: [{ id: `wamid.${Math.random()}`, from, timestamp: '1790771400', type: 'text', text: { body } }],
    } }] }] }),
});
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

before(async () => {
    db = new Database(path.join(tmp, 's.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, defaultCountryCode: '91' } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const tenancy = app.locals.tenancy;
    tenancy.db.prepare('UPDATE tenants SET services = ? WHERE id = 1')
        .run(JSON.stringify([...tenancy.getTenant(1).services, 'school_whatsapp_bot']));
    owner = sessionFor(app, { tenantId: 1, role: 'owner' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const CSV = 'Roll No,Student Name,Class,Section,Father Name,Parent Phone,Bus Route,Hostel\n'
    + '4,Aarav Mehta,10,A,Rakesh,9876512001,4,No\n'
    + '12,Diya Sharma,10,A,Anil,9876512012,2,No\n'
    + '8,Bad Phone,10,B,X,12,1,No\n';
let students;

describe('school assistant', () => {
    it('imports the roster, tags parents, and rejects a bad phone row', async () => {
        const { status, body } = await upload(owner, '/api/school/students/import', CSV);
        assert.equal(status, 200, JSON.stringify(body));
        assert.equal(body.imported, 2);
        assert.equal(body.errors.length, 1);
        students = (await call(owner, 'GET', '/api/school/students')).body.students;
        assert.equal(students.length, 2);
        const contacts = (await call(owner, 'GET', '/api/contacts')).body.contacts;
        assert.ok(contacts.some((c) => c.tags.includes('class-10a') && c.tags.includes('route-4')));
    });

    it('marks attendance, notifies absent parents once, and reports the month', async () => {
        const [a, b] = students.sort((x, y) => x.rollNumber - y.rollNumber);
        const date = '2026-10-05';
        const marked = await call(owner, 'PUT', '/api/school/attendance', {
            date, classKey: '10A',
            marks: [{ studentId: a.id, status: 'present' }, { studentId: b.id, status: 'absent' }],
        });
        assert.equal(marked.status, 200, JSON.stringify(marked.body));
        const first = await call(owner, 'POST', '/api/school/attendance/notify', { date, kinds: ['absent'] });
        assert.equal(first.body.sent, 1);
        const second = await call(owner, 'POST', '/api/school/attendance/notify', { date, kinds: ['absent'] });
        assert.equal(second.body.sent, 0);
        assert.ok(sentTo(b.parentPhone).some((t) => /absent/i.test(t)));
        const report = await call(owner, 'GET', `/api/school/attendance/student/${b.id}?month=2026-10`);
        assert.equal(report.body.percentage, 0);
        assert.deepEqual(report.body.absentDates, [date]);
    });

    it('marks a fee paid with a receipt and builds a UPI link', async () => {
        await call(owner, 'PUT', '/api/school/settings', { upiId: 'school@upi', payeeName: 'DPS' });
        const { body } = await call(owner, 'POST', '/api/school/fees', {
            studentId: students[0].id, term: 'Term 1', amount: 5000, dueAt: '2026-10-20T00:00:00Z',
        });
        assert.match(body.fee.payLink, /^upi:\/\/pay\?pa=/);
        const paid = await call(owner, 'PUT', `/api/school/fees/${body.fee.id}/paid`, { method: 'cash' });
        assert.equal(paid.body.fee.status, 'paid');
        assert.match(paid.body.fee.receiptNo, /^RCPT-/);
        assert.equal(paid.body.receiptSent, true);
    });

    it('imports results and dispatches once per student', async () => {
        const csv = 'Roll No,English,Maths,Grade\n4,80,90/100,A\n';
        const imp = await upload(owner, '/api/school/results/import', csv, { examName: 'Mid Term', classKey: '10A' });
        assert.equal(imp.body.imported, 1, JSON.stringify(imp.body));
        const first = await call(owner, 'POST', '/api/school/results/dispatch', { examName: 'Mid Term', classKey: '10A' });
        assert.equal(first.body.sent, 1);
        const again = await call(owner, 'POST', '/api/school/results/dispatch', { examName: 'Mid Term', classKey: '10A' });
        assert.equal(again.body.sent, 0);
    });

    it('answers WhatsApp commands and turns LEAVE into a decidable ticket', async () => {
        const wa = `91${students.find((s) => s.rollNumber === '4').parentPhone.replace(/\D/g, '').slice(-10)}`;
        await call(owner, 'PUT', '/api/school/timetable', {
            classKey: '10A',
            entries: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => ({
                day, period: '1', startTime: '09:00', endTime: '09:45', subject: 'Maths', teacher: 'Mrs Rao', room: '12',
            })),
        });
        await inbound(wa, 'TIMETABLE');
        await wait();
        assert.ok(sentTo(wa).some((t) => /Mrs Rao/.test(t)), 'timetable reply');

        await inbound(wa, 'LEAVE Sick leave from 10/10 to 12/10');
        await wait();
        const { body } = await call(owner, 'GET', '/api/school/leave?status=pending');
        assert.equal(body.requests.length, 1);
        const id = body.requests[0].ticketId;
        const decided = await call(owner, 'POST', `/api/school/leave/${id}/decision`, { decision: 'approve' });
        assert.equal(decided.body.request.status, 'approved');
        assert.equal((await call(owner, 'POST', `/api/school/leave/${id}/decision`, { decision: 'reject' })).status, 409);
    });

    it('gates staff by title and class', async () => {
        const teacher = sessionFor(app, { tenantId: 1, role: 'agent' });
        const accounts = sessionFor(app, { tenantId: 1, role: 'agent' });
        const agents = (await call(owner, 'GET', '/api/school/staff')).body.users.filter((u) => u.role === 'agent');
        assert.ok(agents.length >= 2);
        await call(owner, 'PUT', `/api/school/staff/${agents[agents.length - 2].id}`, { title: 'class_teacher', classes: ['10A'] });
        await call(owner, 'PUT', `/api/school/staff/${agents[agents.length - 1].id}`, { title: 'accounts', classes: [] });
        assert.equal((await call(teacher, 'GET', '/api/school/attendance?class=10B&date=2026-10-05')).status, 403);
        assert.equal((await call(teacher, 'GET', '/api/school/attendance?class=10A&date=2026-10-05')).status, 200);
        assert.equal((await call(teacher, 'GET', '/api/school/fees')).status, 403);
        assert.equal((await call(accounts, 'GET', '/api/school/attendance?class=10A')).status, 403);
        assert.equal((await call(accounts, 'GET', '/api/school/fees')).status, 200);
    });
});
