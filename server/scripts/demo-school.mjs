/**
 * Isolated demo server for looking at the school portal: temp data dir, a
 * sandbox transport, seeded roster/attendance/fees/results. Never touches
 * ~/.whatsapp_sender_web.   node scripts/demo-school.mjs  ->  http://127.0.0.1:3100
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-demo-'));
const db = new Database(path.join(tmp, 'demo.db'));
const app = createApp({
    db, dataDir: tmp, scheduler: false,
    config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, defaultCountryCode: '91' },
});
const tenancy = app.locals.tenancy;
tenancy.db.prepare('UPDATE tenants SET services = ? WHERE id = 1')
    .run(JSON.stringify([...tenancy.getTenant(1).services, 'school_whatsapp_bot']));

const mint = (role, tenantId) => {
    const info = tenancy.db.prepare(
        `INSERT INTO users (tenant_id, email, name, password_hash, role, created_at)
         VALUES (?, ?, ?, 'x', ?, '2026-01-01T00:00:00Z')`)
        .run(role === 'super_admin' ? null : tenantId, `${role}@demo.dev`, role, role);
    return tenancy.createSession(Number(info.lastInsertRowid));
};
const owner = mint('owner', 1);
const superAdmin = mint('super_admin', 1);

const webDist = path.join(HERE, '..', '..', 'web', 'dist', 'web', 'browser');
app.use(express.static(webDist));
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
const server = app.listen(3100, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const base = 'http://127.0.0.1:3100';
const call = async (method, url, body, token = owner) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    return res.json().catch(() => ({}));
};
const names = ['Aarav Mehta', 'Diya Sharma', 'Kabir Rao', 'Meera Iyer', 'Vihaan Shah', 'Anaya Gupta', 'Ishaan Nair', 'Saanvi Patel'];
const csv = ['Roll No,Student Name,Class,Section,Father Name,Mother Name,Parent Phone,Bus Route,Hostel']
    .concat(names.map((n, i) => `${i + 1},${n},10,${i < 5 ? 'A' : 'B'},Rakesh ${n.split(' ')[1]},Neha ${n.split(' ')[1]},98765${12001 + i},${(i % 3) + 2},${i === 7 ? 'Yes' : 'No'}`)).join('\n');
const form = new FormData();
form.append('file', new Blob([csv], { type: 'text/csv' }), 'roster.csv');
await fetch(`${base}/api/school/students/import`, { method: 'POST', headers: { authorization: `Bearer ${owner}` }, body: form });
await call('PUT', '/api/school/settings', { schoolName: 'Greenfield Public School', upiId: 'greenfield@upi', payeeName: 'Greenfield School' });
const { students } = await call('GET', '/api/school/students');
const date = new Date().toISOString().slice(0, 10);
const A = students.filter((s) => s.classKey === '10A');
const status = ['present', 'absent', 'late', 'present', 'present'];
await call('PUT', '/api/school/attendance', {
    date, classKey: '10A', marks: A.map((s, i) => ({ studentId: s.id, status: status[i % 5], arrivedAt: status[i % 5] === 'late' ? '08:42' : undefined })),
});
await call('POST', '/api/school/fees', { studentId: students[0].id, term: 'Term 1', amount: 12500, dueAt: new Date(Date.now() + 5 * 864e5).toISOString() });
const overdue = await call('POST', '/api/school/fees', { studentId: students[1].id, term: 'Term 1', amount: 12500, dueAt: new Date(Date.now() - 6 * 864e5).toISOString() });
const paid = await call('POST', '/api/school/fees', { studentId: students[2].id, term: 'Tuition', amount: 8000, dueAt: new Date(Date.now() - 2 * 864e5).toISOString() });
if (paid.fee) await call('PUT', `/api/school/fees/${paid.fee.id}/paid`, { method: 'UPI' });
void overdue;
await call('PUT', '/api/school/timetable', {
    classKey: '10A',
    entries: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].flatMap((day, d) => [
        ['Mathematics', 'Mrs Rao', '12'], ['English', 'Mr Fernandes', '12'], ['Physics', 'Dr Kulkarni', 'Lab 2'], ['History', 'Ms Das', '12'],
    ].map(([subject, teacher, room], p) => ({
        day, period: String(p + 1), startTime: `${9 + p}:00`.padStart(5, '0'), endTime: `${9 + p}:45`.padStart(5, '0'),
        subject: d === 2 && p === 1 ? 'Chemistry' : subject, teacher, room,
    }))),
});
await call('POST', '/api/school/homework', { classKey: '10A', subject: 'Mathematics', title: 'Exercise 7.2', instructions: 'Complete all questions and bring graph sheets.', dueAt: new Date(Date.now() + 864e5).toISOString() });
await call('POST', '/api/school/notices', {
    kind: 'holiday', title: 'Diwali break', body: 'School closed 20-24 Oct.', startsAt: new Date(Date.now() + 12 * 864e5).toISOString(), audience: { all: true }, broadcast: false,
});

console.log(JSON.stringify({ url: base, owner, superAdmin }));
