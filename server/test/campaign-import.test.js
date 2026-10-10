/**
 * Campaign import wizard: sheet parsing with arbitrary headers, phone
 * classification, the row audit, fallbacks, and the preview/audit endpoints.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as XLSX from 'xlsx';

import { closeApp } from '../src/app.js';
import {
    auditRows,
    classifyPhone,
    guessMapping,
    missingFor,
    parseSheet,
    renderMessage,
    uniqueColumns,
    withFallbacks,
} from '../src/campaign/importer.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp } from './helpers.js';

const SCHOOL_CSV = '﻿Roll No,Student Name,Parent Phone,Fee Due\r\n'
    + '1,"Shah, Aarav",+91 98765 43210,1200\r\n'
    + '2,Diya,9876543211,0\r\n'
    + ',,,\r\n';

describe('parseSheet / columns / guessMapping', () => {
    it('parses a CSV with arbitrary headers, a quoted comma and a BOM', async () => {
        const sheet = await parseSheet('students.csv', Buffer.from(SCHOOL_CSV));
        assert.deepEqual(sheet.headers, ['Roll No', 'Student Name', 'Parent Phone', 'Fee Due']);
        assert.deepEqual(sheet.columns.map((c) => c.slug), ['roll_no', 'student_name', 'parent_phone', 'fee_due']);
        assert.equal(sheet.rows.length, 2, 'the blank row is dropped');
        assert.equal(sheet.rows[0][1], 'Shah, Aarav');
        assert.equal(sheet.total, 2);
        assert.equal(sheet.truncated, false);
    });

    it('gives colliding headers unique slugs', () => {
        assert.deepEqual(uniqueColumns(['Phone', 'phone ']).map((c) => c.slug), ['phone', 'phone_2']);
    });

    it('guesses phone and name from header words', async () => {
        const sheet = await parseSheet('students.csv', Buffer.from(SCHOOL_CSV));
        assert.deepEqual(guessMapping(sheet.columns, sheet.rows), { phone: 'parent_phone', name: 'student_name' });
    });

    it('sniffs the phone column from data when headers say nothing', () => {
        const columns = uniqueColumns(['who', 'digits']);
        const rows = [['Asha', '+91 98765 43210'], ['Ravi', '9876543211'], ['Mo', '(987) 654-3212']];
        assert.equal(guessMapping(columns, rows).phone, 'digits');
    });

    it('parses an xlsx workbook', async () => {
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
            ['Customer', 'Mobile', 'City'],
            ['Asha', '919876543210', 'Pune'],
        ]), 'Sheet1');
        const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
        const sheet = await parseSheet('list.xlsx', buffer);
        assert.deepEqual(sheet.headers, ['Customer', 'Mobile', 'City']);
        assert.deepEqual(sheet.rows, [['Asha', '919876543210', 'Pune']]);
        assert.deepEqual(guessMapping(sheet.columns, sheet.rows), { phone: 'mobile', name: 'customer' });
    });
});

describe('classifyPhone', () => {
    const cases = [
        [' +91 98765-43210 ', {}, '919876543210', null],
        ['09876543210', { countryCode: '91' }, '919876543210', null],
        ['9876543210', {}, null, 'bad_country_code'],
        ['abc123', {}, null, 'letters'],
        ['98765 43210x', { autoClean: true, countryCode: '91' }, '919876543210', null],
        ['+12345', {}, null, 'too_short'],
        [`+${'1'.repeat(17)}`, {}, null, 'too_long'],
    ];
    for (const [raw, options, phone, reason] of cases) {
        it(`${JSON.stringify(raw)} ${JSON.stringify(options)} -> ${phone ?? reason}`, () => {
            const result = classifyPhone(raw, options);
            assert.equal(result.phone, phone);
            assert.equal(result.reason, reason);
        });
    }
});

describe('auditRows', () => {
    const columns = uniqueColumns(['Name', 'Phone', 'Fee Due']);
    const rows = [
        ['A', '9876543210', '100'],
        ['B', '+91 98765 43210', '200'], // same number as row 0
        ['C', '9876543211', '300'],
        ['D', '9876543212', '400'],
        ['E', 'nope', '500'],
        ['F', '9876543213', '600'],
    ];
    const audit = auditRows(rows, columns, { phone: 'phone', name: 'name' }, {
        countryCode: '91',
        optOuts: new Set(['919876543211']),
        recent: new Set(['919876543212']),
    });

    it('classifies every row', () => {
        assert.deepEqual(audit.counts, { total: 6, valid: 2, invalid: 1, duplicate: 1, optedOut: 1, recent: 1 });
        assert.deepEqual(audit.contacts.map((c) => c.phone), ['919876543210', '919876543213']);
    });

    it('puts extra columns under their slugs', () => {
        assert.deepEqual(audit.contacts[0], { row: 0, name: 'A', phone: '919876543210', extra: { fee_due: '100' } });
    });

    it('issues carry the row index and raw value', () => {
        const byReason = Object.fromEntries(audit.issues.map((i) => [i.reason, i]));
        assert.equal(byReason.duplicate.row, 1);
        assert.equal(byReason.duplicate.raw, '+91 98765 43210');
        assert.equal(byReason.opted_out.row, 2);
        assert.equal(byReason.recent.row, 3);
        assert.equal(byReason.letters.row, 4);
        assert.equal(byReason.letters.raw, 'nope');
    });

    it('refuses an unknown phone column', () => {
        assert.throws(() => auditRows(rows, columns, { phone: 'nope' }), RangeError);
    });
});

describe('fallbacks', () => {
    const contact = { name: '', phone: '919876543210', extra: {} };

    it('fills blanks and never leaves a literal placeholder', () => {
        const text = renderMessage('Hi {name}, code {coupon}', contact, { name: 'Valued Customer' });
        assert.equal(text, 'Hi Valued Customer, code');
        assert.doesNotMatch(text, /[{}]/);
    });

    it('still resolves spintax and inline fallbacks', () => {
        assert.match(renderMessage('{Hi|Hello} there', contact), /^(Hi|Hello) there$/);
        assert.equal(renderMessage('Dear {name|Friend}', contact), 'Dear Friend');
    });

    it('withFallbacks only fills empty values', () => {
        assert.deepEqual(withFallbacks({ name: 'Asha', city: '' }, { name: 'X', city: 'Pune' }), { name: 'Asha', city: 'Pune' });
    });

    it('missingFor reports what nothing fills', () => {
        assert.deepEqual(missingFor('Hi {name}, code {coupon}', contact, { name: 'Valued Customer' }), ['coupon']);
    });
});

describe('import endpoints', () => {
    let app;
    let server;
    let base;
    let dataDir;
    let db;

    before(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-import-'));
        db = new Database(path.join(dataDir, 'app.db'));
        app = createTestApp({ db, dataDir, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX } });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}/api`;
    });

    after(async () => {
        await closeApp(app);
        server?.close();
        db?.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const preview = async (csv, fields = {}) => {
        const form = new FormData();
        form.append('file', new Blob([csv], { type: 'text/csv' }), 'students.csv');
        for (const [k, v] of Object.entries(fields)) form.append(k, v);
        return fetch(`${base}/campaign/import/preview`, { method: 'POST', body: form });
    };
    const audit = (body) => fetch(`${base}/campaign/import/audit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const mapping = { phone: 'parent_phone', name: 'student_name' };

    it('previews a sheet and audits it', async () => {
        const res = await preview(SCHOOL_CSV);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.match(body.importId, /^imp_[0-9a-f]{12}$/);
        assert.deepEqual(body.headers, ['Roll No', 'Student Name', 'Parent Phone', 'Fee Due']);
        assert.deepEqual(body.guess, mapping);
        assert.equal(body.total, 2);

        const result = await (await audit({ importId: body.importId, mapping, countryCode: '91', autoClean: true })).json();
        assert.equal(result.counts.valid, 2);
        assert.deepEqual(result.valid, [
            { row: 0, phone: '919876543210', name: 'Shah, Aarav' },
            { row: 1, phone: '919876543211', name: 'Diya' },
        ]);
    });

    it('marks numbers messaged in the last dedupeDays as recent', async () => {
        const rt = app.locals.runtimeFor(1);
        const { db } = rt.runtimeFor(rt.channels.getDefault()).state;
        db.insert({
            messageId: 'm-recent-1', recipient: '919876543211', message: 'hi',
            status: 'SENT', campaignId: 'camp-1', messageType: 'campaign',
        });
        const { importId } = await (await preview(SCHOOL_CSV)).json();
        const off = await (await audit({ importId, mapping, countryCode: '91' })).json();
        assert.equal(off.counts.recent, 0, 'dedupe is off by default');
        const on = await (await audit({ importId, mapping, countryCode: '91', dedupeDays: 7 })).json();
        assert.equal(on.counts.recent, 1);
        assert.equal(on.issues.find((i) => i.reason === 'recent').phone, '919876543211');
    });

    it('404s an unknown import and 400s bad input', async () => {
        assert.equal((await audit({ importId: 'imp_nope', mapping })).status, 404);
        const { importId } = await (await preview(SCHOOL_CSV)).json();
        assert.equal((await audit({ importId, mapping, countryCode: '12345' })).status, 400);
        assert.equal((await audit({ importId, mapping: { phone: 'missing' } })).status, 400);
        assert.equal((await preview(SCHOOL_CSV, { countryCode: 'abc' })).status, 400);
    });
});
