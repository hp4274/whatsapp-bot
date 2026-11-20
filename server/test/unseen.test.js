/** "Delivered" is not "shown" (messaging/unseen.js): a kind nobody reads, on a number whose ordinary messages are read. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, it } from 'node:test';

import { Database } from '../src/db.js';
import { INTERACTIVE_SCHEMA } from '../src/messaging/replies.js';
import { unseenKinds, unseenText } from '../src/messaging/unseen.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-unseen-'));
const db = new Database(path.join(tmp, 'u.db'));
db.db.exec(INTERACTIVE_SCHEMA);
after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-20T12:00:00Z');
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
let n = 0;

/** One outbound message on number 5; `kind` makes it a tappable one. */
function send({ status, kind = null, hoursAgo = 5, channel = 5 }) {
    const id = `m${++n}`;
    const recipient = `91980000${String(n).padStart(4, '0')}`;
    db.db.prepare(`INSERT INTO messages (tenant_id, channel_id, message_id, recipient, message, status, created_at, updated_at, sent_at)
                   VALUES (1, ?, ?, ?, '', ?, ?, ?, ?)`).run(channel, id, recipient, status, at(hoursAgo), at(hoursAgo), at(hoursAgo));
    if (kind) {
        db.db.prepare(`INSERT INTO interactive_sends (tenant_id, channel_id, recipient, campaign_id, message_id, interactive, sent_at)
                       VALUES (1, ?, ?, 'camp-1', ?, ?, ?)`).run(channel, recipient, id, JSON.stringify({ type: kind }), at(hoursAgo));
    }
    return { id, recipient };
}

beforeEach(() => {
    for (const table of ['messages', 'interactive_sends', 'button_clicks', 'inbound_messages']) db.db.exec(`DELETE FROM ${table}`);
});

it('flags a kind delivered to many and seen by nobody, on a number whose ordinary messages are read', () => {
    for (let i = 0; i < 12; i += 1) send({ status: 'DELIVERED', kind: 'buttons' });
    for (let i = 0; i < 3; i += 1) send({ status: 'READ' });
    const found = unseenKinds(db.db, { now: NOW });
    assert.deepEqual(found, [{ tenantId: 1, channelId: 5, kind: 'buttons', delivered: 12, seen: 0, ordinaryRead: 3 }]);
    assert.match(unseenText(found[0], 'Sales line'), /reply buttons sent from Sales line may not be showing on phones: 12 were delivered/);
});

it('stays quiet when anyone read, tapped or answered one', () => {
    const sends = Array.from({ length: 12 }, () => send({ status: 'DELIVERED', kind: 'list' }));
    for (let i = 0; i < 3; i += 1) send({ status: 'READ' });
    assert.equal(unseenKinds(db.db, { now: NOW }).length, 1);
    // a tap on one
    db.db.prepare(`INSERT INTO button_clicks (tenant_id, channel_id, recipient, message_id, inbound_message_id, at)
                   VALUES (1, 5, ?, ?, 'in-1', ?)`).run(sends[0].recipient, sends[0].id, at(4));
    assert.deepEqual(unseenKinds(db.db, { now: NOW }), []);
    db.db.exec('DELETE FROM button_clicks');
    // a typed answer after it
    db.db.prepare(`INSERT INTO inbound_messages (tenant_id, channel_id, message_id, sender, body, received_at)
                   VALUES (1, 5, 'in-2', ?, 'yes', ?)`).run(sends[1].recipient, at(4));
    assert.deepEqual(unseenKinds(db.db, { now: NOW }), []);
});

it('says nothing when read receipts do not come back at all, too few were sent, or they are too new', () => {
    for (let i = 0; i < 12; i += 1) send({ status: 'DELIVERED', kind: 'carousel' });
    for (let i = 0; i < 5; i += 1) send({ status: 'DELIVERED' }); // ordinary messages delivered, never read
    assert.deepEqual(unseenKinds(db.db, { now: NOW }), [], 'no read receipts anywhere: nothing to compare with');
    for (let i = 0; i < 3; i += 1) send({ status: 'READ' });
    assert.equal(unseenKinds(db.db, { now: NOW }).length, 1);
    db.db.exec('DELETE FROM messages');
    db.db.exec('DELETE FROM interactive_sends');
    for (let i = 0; i < 9; i += 1) send({ status: 'DELIVERED', kind: 'cta' });
    for (let i = 0; i < 12; i += 1) send({ status: 'DELIVERED', kind: 'buttons', hoursAgo: 1 });
    for (let i = 0; i < 3; i += 1) send({ status: 'READ' });
    assert.deepEqual(unseenKinds(db.db, { now: NOW }), [], '9 is too few, and an hour is too soon');
});
