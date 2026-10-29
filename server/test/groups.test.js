/** WhatsApp groups and communities: reading members off Baileys, the CSV export and the contacts import. */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_BAILEYS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { BaileysTransport } from '../src/transports/baileys.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-groups-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const pn = (digits) => `${digits}@s.whatsapp.net`;
const lid = (n) => `${n}@lid`;

/** What groupFetchAllParticipating returns: metadata keyed by group jid (Baileys 7 shape). */
const GROUPS = {
    'c1@g.us': {
        id: 'c1@g.us', subject: 'Parents Community', size: 2, isCommunity: true,
        participants: [{ id: pn('919800000001'), lid: lid(1), admin: 'superadmin' }, { id: lid(9), admin: null }],
    },
    'g1@g.us': {
        id: 'g1@g.us', subject: 'Class 10A', size: 6, isCommunity: false, linkedParent: 'c1@g.us',
        participants: [
            { id: pn('919800000001'), lid: lid(1), admin: 'admin' }, // plain phone-number jid
            { id: lid(2), phoneNumber: pn('919800000002'), admin: null }, // LID with the number sent along
            { id: lid(3), admin: null }, // LID the mapping knows
            { id: lid(4), admin: null }, // LID nobody knows: hidden
            { id: pn('919800000002'), admin: null }, // the same number twice: listed once
            { id: '15550000001:7@s.whatsapp.net', admin: null }, // the linked number itself
        ],
    },
    'g2@g.us': {
        id: 'g2@g.us', subject: 'Cricket, "Sunday"', size: 1, isCommunity: false,
        participants: [{ id: pn('919800000003'), admin: null }],
    },
};

class FakeSock {
    ev = new EventEmitter();
    user = { id: '15550000001:7@s.whatsapp.net' };
    fetches = 0;
    /** What a forced contact snapshot sends back; a test sets it before the first fetch. */
    book = [];
    resyncs = 0;
    forgot = null;
    authState = { keys: { set: async (data) => { this.forgot = data; } } };
    async resyncAppState(collections, initial) {
        this.resyncs += 1;
        this.resyncArgs = { collections, initial };
        this.ev.emit('contacts.upsert', this.book);
    }
    signalRepository = {
        lidMapping: {
            getPNForLID: async (jid) => {
                if (jid === lid(3)) return pn('919800000004');
                if (jid === lid(9)) throw new Error('no session');
                return null;
            },
        },
    };
    async groupFetchAllParticipating() {
        this.fetches += 1;
        return structuredClone(GROUPS);
    }
    async sendMessage(jid) { return { key: { id: 'X', remoteJid: jid, fromMe: true } }; }
    async onWhatsApp(...jids) { return jids.map((jid) => ({ jid, exists: true })); }
    async logout() {}
    async end() {}
}

const socketFactory = (onSock = () => {}) => async () => {
    const sock = new FakeSock();
    onSock(sock);
    setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
    return sock;
};

describe('BaileysTransport.listGroups', () => {
    it('maps phone-number, LID-with-number and LID-mapped members; counts the rest as hidden', async () => {
        const transport = new BaileysTransport({ ...DEFAULTS }, {
            sessionDir: fs.mkdtempSync(path.join(tmp, 'bae-')),
            createSocket: socketFactory(),
            setTimeoutFn: (fn) => setTimeout(fn, 0),
        });
        assert.equal(transport.supportsGroups, true);
        await assert.rejects(transport.listGroups(), /not connected/);
        await transport.connect();
        const groups = await transport.listGroups();
        assert.deepEqual(groups.map((g) => g.name), ['Class 10A', 'Cricket, "Sunday"', 'Parents Community']);

        const cls = groups.find((g) => g.id === 'g1@g.us');
        assert.deepEqual(cls.members, [
            { phone: '919800000001', admin: 'admin' },
            { phone: '919800000002', admin: null },
            { phone: '919800000004', admin: null },
        ]);
        assert.equal(cls.hidden, 1);
        assert.equal(cls.size, 6);
        assert.equal(cls.community, 'c1@g.us');
        assert.equal(cls.isCommunity, false);

        const community = groups.find((g) => g.id === 'c1@g.us');
        assert.equal(community.isCommunity, true);
        assert.equal(community.community, null);
        assert.equal(community.hidden, 1, 'a LID whose lookup throws is hidden, not an error');
        await transport.disconnect();
    });
});

describe('BaileysTransport.listContacts', () => {
    it('reads the address book, resolving LIDs and counting only unresolved people as hidden', async () => {
        let sock;
        const transport = new BaileysTransport({ ...DEFAULTS }, {
            sessionDir: fs.mkdtempSync(path.join(tmp, 'book-')),
            createSocket: socketFactory((s) => { sock = s; }),
            setTimeoutFn: (fn) => setTimeout(fn, 0),
        });
        assert.equal(transport.supportsContacts, true);
        await assert.rejects(transport.listContacts(), /not connected/);
        await transport.connect();
        assert.deepEqual(await transport.listContacts(), { contacts: [], hidden: 0 });

        sock.ev.emit('contacts.upsert', [
            { id: pn('919800000001'), name: 'Asha' },
            { id: pn('919800000001'), notify: 'asha' }, // the same number twice: listed once, the saved name wins
            { id: lid(3), notify: 'Ravi' }, // a LID the mapping knows
            { id: lid(4), notify: 'Hidden Person' }, // a LID nobody knows: hidden
            { id: pn('15550000001'), name: 'Myself' }, // the linked number itself
            { id: '120363000000000000@g.us', name: 'A group' }, // not a person
        ]);
        sock.ev.emit('contacts.update', [{ id: pn('919800000001'), name: 'Asha Patel' }]);

        const { contacts, hidden } = await transport.listContacts();
        assert.deepEqual(contacts, [
            { phone: '919800000001', name: 'Asha Patel', saved: true },
            { phone: '919800000004', name: 'Ravi', saved: false },
        ]);
        assert.equal(hidden, 1);
        await transport.disconnect();

        // WhatsApp syncs the address book once: a restarted server reads the saved copy back.
        const restarted = new BaileysTransport({ ...DEFAULTS }, {
            sessionDir: transport.sessionDir,
            createSocket: socketFactory(),
            setTimeoutFn: (fn) => setTimeout(fn, 0),
        });
        await restarted.connect();
        assert.deepEqual((await restarted.listContacts()).contacts, contacts);
        await restarted.disconnect();
    });

    it('asks WhatsApp for a snapshot when the book is empty, once, and reads what it sends', async () => {
        let sock;
        const transport = new BaileysTransport({ ...DEFAULTS }, {
            sessionDir: fs.mkdtempSync(path.join(tmp, 'refresh-')),
            createSocket: socketFactory((s) => { sock = s; }),
            setTimeoutFn: (fn) => setTimeout(fn, 0),
        });
        await transport.connect();
        // A number linked before the address book was kept: only a profile name has come in, not the book.
        sock.ev.emit('contacts.update', [{ id: pn('919800000008'), notify: 'Someone' }]);
        sock.book = [{ id: pn('919800000007'), name: 'Saved On The Phone' }];
        const book = await transport.listContacts();
        assert.deepEqual(book.contacts, [
            { phone: '919800000007', name: 'Saved On The Phone', saved: true },
            { phone: '919800000008', name: 'Someone', saved: false },
        ]);
        assert.equal(sock.resyncs, 1);
        assert.deepEqual(sock.resyncArgs, { collections: ['critical_unblock_low'], initial: true });
        assert.deepEqual(sock.forgot, { 'app-state-sync-version': { critical_unblock_low: null } },
            'the synced version is forgotten so WhatsApp sends the whole book');

        // The map is no longer empty: a second fetch reads it instead of asking again.
        await transport.listContacts();
        assert.equal(sock.resyncs, 1);
        await transport.disconnect();
    });
});

describe('groups routes', () => {
    let app;
    let server;
    let base;
    let db;
    let sock;

    const call = async (method, url, body, token) => {
        const res = await fetch(base + url, {
            method,
            headers: {
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* CSV */ }
        return { status: res.status, body: json, text, headers: res.headers };
    };

    before(async () => {
        db = new Database(path.join(tmp, 'groups.db'));
        const config = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, safetyEnabled: false, humanTiming: false, defaultCountryCode: '91' };
        delete config.misc;
        app = createTestApp({
            db, config, dataDir: tmp,
            deps: { sessionDir: tmp, setTimeoutFn: (fn) => setTimeout(fn, 0), createSocket: socketFactory((s) => { sock = s; }) },
        });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        await closeApp(app);
        await new Promise((resolve) => server.close(resolve));
        db.close();
    });

    it('asks for a QR number while none is connected', async () => {
        const res = await call('GET', '/api/contacts/whatsapp-groups');
        assert.equal(res.status, 409);
        assert.deepEqual(res.body.errors, ['Connect a WhatsApp QR number first.']);
        assert.equal((await call('POST', '/api/contacts/whatsapp-groups/import', { all: true })).status, 409);
    });

    it('lists groups with counts, not numbers', async () => {
        assert.equal((await call('POST', '/api/connection/connect')).status, 200);
        const res = await call('GET', '/api/contacts/whatsapp-groups');
        assert.equal(res.status, 200, res.text);
        const cls = res.body.groups.find((g) => g.id === 'g1@g.us');
        assert.deepEqual(cls, {
            id: 'g1@g.us', name: 'Class 10A', size: 6, isCommunity: false,
            community: 'c1@g.us', communityName: 'Parents Community', members: 3, hidden: 1,
        });
        assert.ok(!res.text.includes('919800000001'), 'no phone numbers in the listing');
    });

    it('exports picked groups as CSV, one row per member per group', async () => {
        const res = await call('GET', '/api/contacts/whatsapp-groups/export?ids=g1@g.us,g2@g.us');
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/csv/);
        assert.match(res.headers.get('content-disposition'), /whatsapp-groups-/);
        const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
        assert.deepEqual(lines, [
            'phone,name,group,community,admin',
            '919800000001,,Class 10A,Parents Community,yes',
            '919800000002,,Class 10A,Parents Community,no',
            '919800000004,,Class 10A,Parents Community,no',
            '919800000003,,"Cricket, ""Sunday""",,no',
        ]);
        const all = await call('GET', '/api/contacts/whatsapp-groups/export?ids=all');
        assert.equal(all.text.trim().split('\r\n').length, 1 + 3 + 1 + 1);
        assert.equal((await call('GET', '/api/contacts/whatsapp-groups/export?ids=nope')).status, 400);
        assert.equal(sock.fetches, 1, 'listing then exporting asks WhatsApp once');
    });

    it('imports members as contacts tagged with each group they are in', async () => {
        const res = await call('POST', '/api/contacts/whatsapp-groups/import', { ids: ['g1@g.us', 'c1@g.us'] });
        assert.equal(res.status, 200, res.text);
        assert.deepEqual(res.body, { created: 3, updated: 0, failed: 0, hidden: 2 });
        const list = (await call('GET', '/api/contacts?limit=50')).body.contacts;
        const one = list.find((c) => c.phone.endsWith('919800000001'));
        assert.deepEqual([...one.tags].sort(), ['class 10a', 'parents community'], 'tags are stored lower-case');
        assert.equal(one.source, 'whatsapp_group');
        assert.ok(list.find((c) => c.phone.endsWith('919800000004')).tags.includes('class 10a'));

        const again = await call('POST', '/api/contacts/whatsapp-groups/import', { ids: ['g2@g.us'] });
        assert.deepEqual(again.body, { created: 1, updated: 0, failed: 0, hidden: 0 });
        assert.equal((await call('POST', '/api/contacts/whatsapp-groups/import', { ids: [] })).status, 400);
    });

    it('the admin fetch reads the account itself: address book plus group and community members', async () => {
        // A contact the platform knows but WhatsApp does not: it must not leak into the answer.
        await call('POST', '/api/contacts', { phone: '919999999999', name: 'Platform Only' });
        sock.ev.emit('contacts.upsert', [
            { id: pn('919800000009'), name: 'Meera' },
            { id: lid(3), notify: 'Classmate' }, // resolves to 919800000004, already a group member
            { id: lid(4), notify: 'Hidden Person' },
        ]);
        const sup = sessionFor(app, { role: 'super_admin' });
        const res = await call('GET', '/api/admin/tenants/1/contacts', null, sup);
        assert.equal(res.status, 200, res.text);
        assert.equal(res.body.source, 'whatsapp_account');
        assert.equal(res.body.account, '15550000001');
        assert.equal(res.body.saved, 2, 'two readable numbers in the address book');
        assert.equal(res.body.hidden, 3, 'one contact and two group members are LID-only');
        assert.deepEqual(res.body.numbers, [
            '919800000001', '919800000002', '919800000003', '919800000004', '919800000009',
        ]);
        assert.ok(!res.body.numbers.includes('919999999999'), 'the platform contact is not part of the account');
        const meera = res.body.contacts.find((c) => c.phone === '919800000009');
        assert.deepEqual(meera, { phone: '919800000009', name: 'Meera', saved: true, groups: [] });
        const classmate = res.body.contacts.find((c) => c.phone === '919800000004');
        assert.deepEqual(classmate, {
            phone: '919800000004', name: 'Classmate', saved: false, groups: ['Class 10A'],
        });
        const community = res.body.groups.find((g) => g.id === 'c1@g.us');
        assert.equal(community.isCommunity, true);
        assert.equal(community.communityName, '');
        assert.equal(res.body.groups.find((g) => g.id === 'g1@g.us').communityName, 'Parents Community');
    });

    it('saves the fetched numbers as one bulk collection, for the platform admin only', async () => {
        const sup = sessionFor(app, { role: 'super_admin' });
        const owner = sessionFor(app, { tenantId: 1, role: 'owner' });
        const body = { account: '15550000001', numbers: ['919800000001', '919800000002', '919800000009'] };

        assert.equal((await call('POST', '/api/admin/tenants/1/number-collections', body, owner)).status, 403);
        assert.equal((await call('POST', '/api/admin/tenants/1/number-collections', { numbers: [] }, sup)).status, 400);

        const saved = await call('POST', '/api/admin/tenants/1/number-collections', body, sup);
        assert.equal(saved.status, 201, saved.text);
        assert.deepEqual(saved.body.collection.numbers, body.numbers);
        assert.equal(saved.body.collection.count, 3);

        const list = await call('GET', '/api/admin/number-collections', null, sup);
        assert.equal(list.status, 200, list.text);
        assert.deepEqual(list.body.collections.map((c) => [c.tenantId, c.tenantName, c.count]),
            [[1, 'Default', 3]]);

        // Saving again replaces the business's list instead of piling up copies.
        await call('POST', '/api/admin/tenants/1/number-collections', { numbers: ['919800000001'] }, sup);
        const after = (await call('GET', '/api/admin/number-collections', null, sup)).body.collections;
        assert.equal(after.length, 1);
        assert.deepEqual(after[0].numbers, ['919800000001']);
    });
});

describe('groups on a transport without them', () => {
    it('the sandbox answers 409', async () => {
        const db = new Database(path.join(tmp, 'sandbox.db'));
        const app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX } });
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            await fetch(`${base}/api/connection/connect`, { method: 'POST' });
            assert.equal((await fetch(`${base}/api/contacts/whatsapp-groups`)).status, 409);
            const admin = await fetch(`${base}/api/admin/tenants/1/contacts`, {
                headers: { authorization: `Bearer ${sessionFor(app, { role: 'super_admin' })}` },
            });
            assert.equal(admin.status, 409, 'a sandbox number has no address book to read');
        } finally {
            await closeApp(app);
            await new Promise((resolve) => server.close(resolve));
            db.close();
        }
    });
});
