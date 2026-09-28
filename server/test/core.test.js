/** Protocol, database, queue and limits - the rules the whole app rests on. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Database } from '../src/db.js';
import { MessageQueue, queueItem } from '../src/campaign/queue.js';
import { RateLimiter, RetryPolicy } from '../src/campaign/limits.js';
import { importCsv, parseCsv, rowsToContacts } from '../src/contacts.js';
import {
    PhoneError,
    Status,
    dedupeKey,
    isValidPhone,
    normalizePhone,
    personalize,
} from '../src/protocol.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('phone numbers', () => {
    it('normalises the shapes people actually paste', () => {
        assert.equal(normalizePhone('+91 98765-43210'), '919876543210');
        assert.equal(normalizePhone('0091 9876543210'), '919876543210');
        assert.equal(normalizePhone('(987) 654-3210', '91'), '919876543210');
        assert.equal(normalizePhone('09876543210', '91'), '919876543210');
    });

    it('rejects what is not a number', () => {
        assert.throws(() => normalizePhone(''), PhoneError);
        assert.throws(() => normalizePhone('abc'), PhoneError);
        assert.throws(() => normalizePhone('123'), PhoneError);   // too short
        assert.equal(isValidPhone('+1 555 019 2345'), true);
    });
});

describe('personalisation', () => {
    it('substitutes known variables and keeps unknown ones verbatim', () => {
        assert.equal(personalize('Hi {name}', { name: 'Rahul' }), 'Hi Rahul');
        assert.equal(personalize('Hi {name}, order {id}', { name: 'A' }), 'Hi A, order {id}');
        assert.equal(personalize('', { name: 'A' }), '');
        assert.equal(personalize('no vars', {}), 'no vars');
    });

    it('keys duplicates on number plus body', () => {
        assert.equal(dedupeKey('91', 'hi'), '91|hi');
        assert.notEqual(dedupeKey('91', 'hi'), dedupeKey('91', 'ho'));
    });
});

describe('database', () => {
    const db = new Database(path.join(tmp, 'core.db'));
    after(() => db.close());

    it('stores a message and reads it back', () => {
        db.insert({ messageId: 'm1', recipient: '919876543210', message: 'hi',
            status: Status.QUEUED, name: 'Rahul', campaignId: 'c1' });
        const record = db.get('m1');
        assert.equal(record.recipient, '919876543210');
        assert.equal(record.status, Status.QUEUED);
        assert.equal(record.name, 'Rahul');
    });

    it('never lets a late receipt downgrade a message', () => {
        db.updateStatus('m1', Status.SENT, { attempt: 1, providerId: 'wamid.1' });
        assert.equal(db.applyReceipt('wamid.1', Status.READ), true);
        assert.equal(db.applyReceipt('wamid.1', Status.DELIVERED), false, 'delivered after read');
        assert.equal(db.get('m1').status, Status.READ);
    });

    it('counts only real sends as "already messaged"', () => {
        db.insert({ messageId: 'm2', recipient: '919812345678', message: 'hi',
            status: Status.SANDBOX });
        const sent = db.sentRecipients();
        assert.ok(sent.has('919876543210'));
        assert.ok(!sent.has('919812345678'), 'SANDBOX must not count as sent');
    });

    it('answers the cheap change question without shipping rows', () => {
        const before = db.historySignature();
        db.insert({ messageId: 'm3', recipient: '919999888777', message: 'hi',
            status: Status.QUEUED });
        const after_ = db.historySignature();
        assert.notDeepEqual(before, after_);
        assert.equal(after_.count, 3);
    });
});

describe('queue', () => {
    it('is FIFO and rejects duplicates', () => {
        const queue = new MessageQueue();
        assert.equal(queue.put(queueItem({ recipient: '91', message: 'a' })), true);
        assert.equal(queue.put(queueItem({ recipient: '91', message: 'b' })), true);
        assert.equal(queue.put(queueItem({ recipient: '91', message: 'a' })), false);
        assert.equal(queue.duplicatesRejected, 1);
        assert.equal(queue.get().message, 'a');
        assert.equal(queue.get().message, 'b');
        assert.equal(queue.get(), null);
    });

    it('collapses a number to one message when asked', () => {
        const queue = new MessageQueue({ onePerRecipient: true });
        assert.equal(queue.put(queueItem({ recipient: '91', message: 'a', name: 'Rahul' })), true);
        assert.equal(queue.put(queueItem({ recipient: '91', message: 'b', name: 'Rahul S' })), false,
            'same number, different name, must not send twice');
    });

    it('pauses, resumes and drops everything on stop', () => {
        const queue = new MessageQueue();
        queue.put(queueItem({ recipient: '91', message: 'a' }));
        queue.pause();
        assert.equal(queue.get(), null, 'paused queue hands out nothing');
        queue.resume();
        assert.ok(queue.get());
        queue.put(queueItem({ recipient: '91', message: 'b' }));
        assert.equal(queue.stop().length, 1);
        assert.equal(queue.put(queueItem({ recipient: '91', message: 'c' })), false);
        queue.reset();
        assert.equal(queue.put(queueItem({ recipient: '91', message: 'c' })), true);
    });
});

describe('rate limiter', () => {
    it('spaces sends at the configured rate', () => {
        let now = 0;
        const limiter = new RateLimiter(2, 1, () => now); // 2/s
        assert.equal(limiter.delay(), 0);
        limiter.consume();
        assert.ok(Math.abs(limiter.delay() - 0.5) < 1e-6, 'must wait half a second');
        now += 0.5;
        assert.equal(limiter.delay(), 0);
    });

    it('lets a burst through after an idle period', () => {
        let now = 0;
        const limiter = new RateLimiter(1, 3, () => now);
        for (let i = 0; i < 3; i += 1) {
            assert.equal(limiter.delay(), 0);
            limiter.consume();
        }
        assert.ok(limiter.delay() > 0);
    });
});

describe('retry policy', () => {
    const policy = new RetryPolicy({ maxRetries: 2, delay: 1, backoff: 2, jitter: 0 });

    it('retries only retryable failures, and only while attempts remain', () => {
        assert.equal(policy.shouldRetry(1, true), true);
        assert.equal(policy.shouldRetry(1, false), false, 'permanent failures are not retried');
        assert.equal(policy.shouldRetry(3, true), false, 'attempts exhausted');
    });

    it('backs off exponentially and respects the ceiling', () => {
        assert.equal(policy.delayFor(1), 1);
        assert.equal(policy.delayFor(2), 2);
        assert.equal(policy.delayFor(3), 4);
        const capped = new RetryPolicy({ delay: 10, backoff: 10, maxDelay: 30, jitter: 0 });
        assert.equal(capped.delayFor(5), 30);
    });
});

describe('contacts', () => {
    it('parses quoted CSV fields', () => {
        const rows = parseCsv('name,phone\n"Sharma, Rahul",+919876543210\n');
        assert.deepEqual(rows[1], ['Sharma, Rahul', '+919876543210']);
    });

    it('imports, validates and de-duplicates', () => {
        const result = importCsv([
            'name,phone,city',
            'Rahul,+919876543210,Pune',
            'Rahul again,919876543210,Pune',   // duplicate number
            'Broken,not-a-number,X',
            ',,,',
        ].join('\n'));
        assert.equal(result.contacts.length, 1);
        assert.equal(result.duplicates, 1);
        assert.equal(result.errors.length, 1);
        assert.equal(result.contacts[0].extra.city, 'Pune');
    });

    it('accepts the alternative header names', () => {
        const result = rowsToContacts([{ 'Full Name': 'Priya', Mobile: '+91 98123 45678' }]);
        assert.equal(result.contacts[0].name, 'Priya');
        assert.equal(result.contacts[0].phone, '919812345678');
    });
});
