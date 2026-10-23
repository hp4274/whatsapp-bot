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
import { createTestApp } from './helpers.js';

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
    async onWhatsApp(jid) { return [{ jid, exists: true }]; }
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

describe('groups routes', () => {
    let app;
    let server;
    let base;
    let db;
    let sock;

    const call = async (method, url, body) => {
        const res = await fetch(base + url, {
            method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
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
        } finally {
            await closeApp(app);
            await new Promise((resolve) => server.close(resolve));
            db.close();
        }
    });
});
