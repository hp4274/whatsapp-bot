/**
 * A new number on an existing channel starts over: its sending level and
 * inbox must not inherit the previous number's history.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { Channels } from '../src/channels.js';
import { DEFAULTS, TRANSPORT_BAILEYS } from '../src/config.js';
import { Database } from '../src/db.js';
import { ConversationStore } from '../src/inbox/store.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-number-'));

describe('changing a channel number', () => {
    it('hides the old inbox, but not for the same number reformatted', () => {
        const db = new Database(path.join(tmp, 'n.db'));
        const channels = new Channels(db.forTenant(1));
        const channel = channels.create({ displayName: 'Main', phoneNumber: '+91 98765 43210' });
        const scoped = db.forTenant(1).forChannel(channel.id);
        const inbox = new ConversationStore(scoped);

        scoped.insert({ messageId: 'old.1', recipient: '15550001', message: 'hi', status: 'SENT', createdAt: '2026-01-01T10:00:00Z' });
        const old = inbox.upsertForInbound({ phone: '15550001', at: '2026-01-01T10:05:00Z' });

        // The first scan of the same number (no country-code mismatch) is not a change.
        assert.equal(channels.update(channel.id, { providerAccountId: '919876543210' }).numberSince, null);
        assert.equal(channels.update(channel.id, { phoneNumber: '9876543210' }).numberSince, null);
        const sentJan1 = () => scoped.countSentBetween('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
        assert.equal(sentJan1(), 1);

        const moved = channels.update(channel.id, { providerAccountId: '917000000000' });
        assert.ok(moved.numberSince);
        assert.equal(sentJan1(), 0, 'the daily cap and levels drop the old number\'s sends');
        assert.equal(inbox.list().length, 0);
        assert.equal(inbox.stats().total, 0);

        // The old customer writing the new number shows up without the old thread.
        const back = inbox.upsertForInbound({ phone: '15550001' });
        assert.equal(back.id, old.id);
        assert.equal(inbox.list().length, 1);
        assert.deepEqual(inbox.thread(back.id), []);
        db.close();
    });

    it('stamps linkedAt on a QR scan or a new number, not on a reconnect', async () => {
        const db = new Database(path.join(tmp, 'w.db'));
        const sock = { ev: new EventEmitter(), user: { id: '919876543210:7@s.whatsapp.net' }, async end() {}, async logout() {} };
        const createSocket = async () => {
            setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
            return sock;
        };
        const config = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, safetyEnabled: false, humanTiming: false };
        delete config.misc;
        const dataDir = fs.mkdtempSync(path.join(tmp, 'app-'));
        const app = createTestApp({ db, config, dataDir, deps: { sessionDir: dataDir, setTimeoutFn: (fn) => setTimeout(fn, 0), createSocket } });
        try {
            const tenant = app.locals.runtimeFor(1);
            const channel = tenant.channels.getDefault();
            const { state } = tenant.runtimeFor(channel);
            assert.equal((await state.connect()).body.connected, true);
            const linkedAt = () => tenant.channels.get(channel.id).settings.linkedAt;
            assert.ok(!linkedAt(), 'a session that was already linked is not a new link');

            state.transport.events.emit('qr', 'QR-CODE');
            state.transport.events.emit('ready', { connected: true, account: '919876543210' });
            const first = linkedAt();
            assert.ok(first, 'a scan stamps the link');
            assert.equal(state.config.linkedAt, first, 'and the running sender sees it');

            await new Promise((resolve) => setTimeout(resolve, 1100));
            state.transport.events.emit('ready', { connected: true, account: '919876543210' });
            assert.equal(linkedAt(), first, 'a reconnect of the same number is not');

            state.transport.events.emit('ready', { connected: true, account: '917000000000' });
            assert.ok(linkedAt() > first, 'another number on the channel is');
        } finally {
            await closeApp(app);
            db.close();
        }
    });
});
