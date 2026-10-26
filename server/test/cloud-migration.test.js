/**
 * The Meta Cloud API is gone: opening a database deletes its numbers, clears
 * what pointed at them and hands the tenant's default to a remaining number.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { after, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { Channels } from '../src/channels.js';
import { DEFAULTS, TRANSPORT_BAILEYS } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-cloud-migration-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NOW = '2026-01-01T00:00:00+00:00';

it('deletes cloud_api numbers, clears references, reassigns the default, and is idempotent', () => {
    const file = path.join(tmp, 'm.db');
    let db = new Database(file);
    const raw = db.db;
    raw.prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES (2, 'Only Cloud', 'only-cloud', ?)").run(NOW);
    const channel = (tenantId, provider, isDefault) => Number(raw.prepare(
        `INSERT INTO whatsapp_channels (tenant_id, provider, display_name, settings, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`).run(tenantId, provider, provider, JSON.stringify({ transport: provider, accessToken: 'tok' }), isDefault, NOW, NOW)
        .lastInsertRowid);
    const cloud = channel(1, 'cloud_api', 1);
    const qr = channel(1, TRANSPORT_BAILEYS, 0);
    const lonely = channel(2, 'cloud_api', 1);
    raw.prepare(`INSERT INTO messages (tenant_id, channel_id, message_id, recipient, message, status, created_at, updated_at)
                 VALUES (1, ?, 'm1', '919800000001', 'hi', 'DELIVERED', ?, ?)`).run(cloud, NOW, NOW);
    const campaign = (channelId, name, status, options = {}) => Number(raw.prepare(
        'INSERT INTO campaigns (tenant_id, channel_id, name, status, options, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)')
        .run(channelId, name, status, JSON.stringify(options), NOW, NOW).lastInsertRowid);
    campaign(cloud, 'Pinned', 'draft');
    const live = campaign(cloud, 'Live', 'running');
    const meta = campaign(null, 'Meta', 'scheduled', { templateMode: 'meta' });
    const repeat = campaign(cloud, 'Repeat', 'done', { recurrence: { every: 'week' } });
    const onQr = campaign(qr, 'On QR', 'running');
    const queued = (id, channelId, key) => raw.prepare(
        `INSERT INTO messages (tenant_id, channel_id, message_id, recipient, message, status, campaign_id, created_at, updated_at)
         VALUES (1, ?, ?, '919800000002', 'hi', 'QUEUED', ?, ?, ?)`).run(channelId, id, key, NOW, NOW);
    queued('q-live', cloud, `camp-${live}`);
    queued('q-meta', qr, `camp-${meta}`);
    queued('q-qr', qr, `camp-${onQr}`);
    const workflow = (channelId, name) => raw.prepare(
        `INSERT INTO workflows (tenant_id, channel_id, name, status, trigger, steps, created_at, updated_at)
         VALUES (1, ?, ?, 'active', '{"type":"message.received"}', '[]', ?, ?)`).run(channelId, name, NOW, NOW);
    workflow(cloud, 'Cloud flow');
    workflow(null, 'Any flow');
    raw.prepare("INSERT INTO templates (tenant_id, name, template_type, created_at, updated_at) VALUES (1, 'Meta tpl', 'provider_template', ?, ?)")
        .run(NOW, NOW);
    raw.prepare(`INSERT INTO conversations (tenant_id, channel_id, phone, created_at, updated_at)
                 VALUES (1, ?, '919800000001', ?, ?)`).run(cloud, NOW, NOW);
    raw.exec('CREATE TABLE IF NOT EXISTS channel_ops (channel_id INTEGER PRIMARY KEY, paused_reason TEXT)');
    raw.prepare("INSERT INTO channel_ops (channel_id, paused_reason) VALUES (?, 'old'), (?, 'keep')").run(cloud, qr);
    db.close();

    for (let open = 0; open < 2; open += 1) {
        db = new Database(file);
        const rows = db.db.prepare('SELECT id, tenant_id, provider, is_default FROM whatsapp_channels ORDER BY id').all();
        assert.deepEqual(rows.map((r) => ({ ...r })), [{ id: qr, tenant_id: 1, provider: TRANSPORT_BAILEYS, is_default: 1 }], `open ${open}`);
        assert.equal(db.db.prepare("SELECT channel_id FROM messages WHERE message_id = 'm1'").get().channel_id, null, 'history kept, unlinked');
        assert.equal(db.db.prepare("SELECT channel_id FROM campaigns WHERE name = 'Pinned'").get().channel_id, null, 'a draft, unlinked');
        // Nothing of the Cloud number's goes out on a QR one the tenant never chose for it.
        const campaignRow = (id) => db.db.prepare('SELECT status, options FROM campaigns WHERE id = ?').get(id);
        assert.equal(campaignRow(live).status, 'cancelled');
        assert.equal(JSON.parse(campaignRow(live).options).statusReason, 'The Meta Cloud API was removed.');
        assert.equal(campaignRow(meta).status, 'cancelled', 'a Meta-template campaign on the default number too');
        assert.equal(campaignRow(onQr).status, 'running', 'a QR campaign is untouched');
        assert.ok(JSON.parse(campaignRow(repeat).options).recurrenceNote, 'no further repeats are booked');
        const msg = (id) => db.db.prepare('SELECT status FROM messages WHERE message_id = ?').get(id).status;
        assert.deepEqual(['q-live', 'q-meta', 'q-qr'].map(msg), ['CANCELLED', 'CANCELLED', 'QUEUED']);
        const flows = db.db.prepare('SELECT name, status FROM workflows ORDER BY id').all().map((r) => `${r.name}:${r.status}`);
        assert.deepEqual(flows, ['Cloud flow:paused', 'Any flow:active'], 'NULL is "any number": a pinned workflow must not spread');
        assert.equal(db.db.prepare("SELECT template_type FROM templates WHERE name = 'Meta tpl'").get().template_type, 'text');
        assert.equal(db.db.prepare('SELECT channel_id FROM conversations').get().channel_id, cloud, 'a NOT NULL id is left; ids are never reused');
        assert.deepEqual(db.db.prepare('SELECT channel_id FROM channel_ops').all().map((r) => r.channel_id), [qr]);
        assert.equal(new Channels(db.forTenant(1)).getDefault().id, qr);
        db.close();
    }

    // A tenant left with no number gets a fresh QR one on boot, even from an old Cloud config.
    db = new Database(file);
    assert.equal(new Channels(db.forTenant(2)).list().length, 0);
    const seeded = new Channels(db.forTenant(2)).seed({ ...DEFAULTS, transport: 'cloud_api', accessToken: 'tok' });
    assert.equal(seeded.provider, TRANSPORT_BAILEYS);
    assert.equal(seeded.isDefault, true);
    assert.equal(seeded.settings.accessToken, undefined);
    assert.ok(seeded.id > lonely, 'a deleted id is never reused');
    db.close();
});

it('hands the default to an active number before an older disabled one', () => {
    const file = path.join(tmp, 'disabled.db');
    let db = new Database(file);
    const channel = (provider, status, isDefault) => Number(db.db.prepare(
        `INSERT INTO whatsapp_channels (tenant_id, provider, display_name, status, is_default, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)`).run(provider, provider, status, isDefault, NOW, NOW).lastInsertRowid);
    channel('cloud_api', 'active', 1);
    channel(TRANSPORT_BAILEYS, 'disabled', 0);
    const active = channel(TRANSPORT_BAILEYS, 'active', 0);
    db.close();
    db = new Database(file);
    assert.equal(new Channels(db.forTenant(1)).getDefault().id, active);
    db.close();
});

it('a QR number made the default keeps its own session folder', async () => {
    const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'));
    const dirs = [];
    const createSocket = async ({ authDir }) => {
        dirs.push(authDir);
        const sock = { ev: new EventEmitter(), user: { id: '15550000001:7@s.whatsapp.net' }, async end() {}, async logout() {} };
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
    };
    const db = new Database(path.join(tmp, 'session.db'));
    const config = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, safetyEnabled: false, humanTiming: false };
    const app = createTestApp({ db, config, dataDir, deps: { setTimeoutFn: (fn) => setTimeout(fn, 0), createSocket } });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const { channels } = app.locals.runtimeFor(1);
        const second = channels.create({ displayName: 'QR two', settings: { transport: TRANSPORT_BAILEYS } });
        const own = path.join(dataDir, 'channels', String(second.id), 'wwebjs_auth');
        fs.mkdirSync(path.join(own, 'baileys'), { recursive: true }); // it was linked as a second number
        channels.setDefault(second.id); // e.g. the Cloud default beside it was deleted
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/connection/connect`, {
            method: 'POST', headers: { 'x-channel-id': String(second.id) },
        });
        assert.equal((await res.json()).connected, true);
        assert.deepEqual(dirs, [path.join(own, 'baileys')]);
    } finally {
        await closeApp(app);
        await new Promise((resolve) => server.close(resolve));
        db.close();
    }
});
