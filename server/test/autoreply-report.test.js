/** The auto-reply Reports tab: hot keywords, unanswered questions, where customers left part-way. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AutoReplyStore } from '../src/autoreply/store.js';
import { Database } from '../src/db.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-ar-report-'));
const NOW = new Date('2026-11-18T12:00:00Z');
const ago = (h) => new Date(NOW.getTime() - h * 3_600_000);

describe('auto-reply report', () => {
    it('counts what answered, what did not, and where people stopped', () => {
        const db = new Database(path.join(tmp, 'r.db'));
        const store = new AutoReplyStore(db);
        const price = store.save({ name: 'Price list', matchType: 'ANY_OF', keywords: ['price'], replyBody: 'Rs 99' });
        const book = store.save({
            name: 'Book', matchType: 'ANY_OF', keywords: ['book'], replyBody: 'Sure',
            collect: { questions: [{ key: 'name', question: 'Your name?', type: 'name' }, { key: 'day', question: 'Which day?', type: 'text' }] },
        });
        const inbound = (sender, body, rule, at) => {
            const saved = db.insertInbound({ messageId: `m.${Math.random()}`, sender, body, receivedAt: at.toISOString() });
            if (rule) db.markInboundReplied(saved.messageId, rule);
        };
        inbound('911', 'price', 'price', ago(2));
        inbound('912', 'price?', 'price', ago(3));
        inbound('911', 'hello', 'welcome', ago(30));
        inbound('913', 'do you deliver', null, ago(1));
        inbound('914', 'Do you deliver', null, ago(1));
        inbound('915', 'old', 'price', ago(24 * 20)); // outside the 7 days
        store.log({ phone: '913', inbound: 'do you deliver', outcome: 'none' }, ago(1));
        store.log({ phone: '914', inbound: 'Do you deliver ', outcome: 'none' }, ago(1));
        store.recordHit('handoff', '913', ago(1));
        // One customer stopped at question 2 of Book; one is still answering (not expired yet).
        store.setSession('916', { ruleId: book.id, flow: { step: 1, tries: 0, answers: { name: 'A' } } }, ago(3));
        store.setSession('917', { ruleId: book.id, flow: { step: 0, tries: 0, answers: {} } }, NOW);

        const since = new Date('2026-11-12T00:00:00Z');
        const r = store.report(since, NOW, 'Asia/Kolkata');
        assert.deepEqual(
            { ...r.totals },
            { messages: 5, answered: 3, unanswered: 2, answerRate: 60, customers: 4, handoffs: 1, leftPartWay: 1, failed: 0 },
        );
        assert.equal(r.hot[0].label, 'price');
        assert.equal(r.hot[0].rule, price.name);
        assert.equal(r.hot[0].uses, 2);
        assert.equal(r.hot[0].customers, 2);
        assert.equal(r.hot[1].label, 'Welcome message');
        assert.deepEqual(r.unanswered.map((u) => [u.text, u.count, u.customers]), [['do you deliver', 2, 2]]);
        assert.deepEqual(r.leftPartWay, [{ ruleId: book.id, rule: 'Book', where: 'Question 2: Which day?', count: 1 }]);
        assert.equal(r.byDay.length, 7, 'every day in the range, quiet ones too');
        assert.equal(r.byDay.at(-1).date, '2026-11-18');
        assert.equal(r.hours.reduce((a, b) => a + b, 0), 5);
        db.close();
    });
});
