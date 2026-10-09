/** Campaign attachments reach the transport, and survive a restart via disk. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULTS } from '../src/config.js';
import { Database } from '../src/db.js';
import { MediaStore } from '../src/mediaStore.js';
import { Status } from '../src/protocol.js';

it('hands the same media to the transport for every recipient', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-media-'));
    const db = new Database(path.join(tmp, 'm.db'));
    const sent = [];
    const transport = {
        name: 'fake', realDelivery: true, supportsReceipts: false,
        isConnected: () => true,
        async sendMessage(to, text, opts) { sent.push([to, text, opts?.media]); return { providerId: `p${sent.length}`, status: Status.SENT }; },
        getStatus: () => null,
        async disconnect() {},
    };
    const manager = new CampaignManager(db, transport, { ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed' });
    const media = { mediaId: 'med_aaaaaaaaaaaa', filename: 'a.png', mimetype: 'image/png', size: 3, filePath: 'x', buffer: Buffer.from('abc') };
    manager.enqueueContacts(
        [{ name: 'A', phone: '919855550101' }, { name: 'B', phone: '919855550102' }], 'Hi {name}', { media });
    manager.start();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && sent.length < 2) await new Promise((r) => setTimeout(r, 25));
    await manager.shutdown();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.equal(sent.length, 2);
    assert.ok(sent.every(([, text, m]) => m?.mediaId === media.mediaId && m.mimetype === 'image/png' && text.startsWith('Hi ')));
});

it('rehydrates a mediaId missing from memory from the uploads directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-up-'));
    fs.writeFileSync(path.join(dir, 'med_0123456789ab_My Doc.pdf'), '%PDF-1.4');
    const store = new MediaStore(dir);
    const media = store.get('med_0123456789ab');
    assert.equal(media.filename, 'My Doc.pdf');
    assert.equal(media.mimetype, 'application/pdf');
    assert.equal(media.size, 8);
    assert.equal(media.buffer.toString(), '%PDF-1.4');
    assert.equal(store.get('med_ffffffffffff'), undefined);
    assert.equal(store.get('../etc'), undefined);
    fs.rmSync(dir, { recursive: true, force: true });
});
