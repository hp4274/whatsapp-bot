/**
 * Phase 10: the knowledge base and FAQ engine.
 *
 * The claims worth testing are that the matcher is a strict superset of the
 * keyword engine it replaces (same four levels, same results), that a
 * similarity score below the threshold is a miss rather than a confident wrong
 * answer, that a question nothing answered is recorded so an operator can see
 * it, that answer history is append-only, and that a FAQ id is useless to
 * another tenant.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { after, before, describe, it } from 'node:test';

import { AutoReplyEngine } from '../src/autoreply/engine.js';
import { Database } from '../src/db.js';
import { KNOWLEDGE_SCHEMA } from '../src/knowledge/schema.js';
import { KnowledgeError, KnowledgeStore } from '../src/knowledge/store.js';
import { createKnowledgeRouter } from '../src/knowledge/routes.js';
import { SIMILARITY_THRESHOLD, dice, matchFaq, normalizeText } from '../src/knowledge/matcher.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-knowledge-'));
let db;
let tenantB;

before(() => {
    db = new Database(path.join(tmp, 'k.db'));
    // The main thread wires this into MODULE_SCHEMAS; standalone we apply it.
    db.db.exec(KNOWLEDGE_SCHEMA);
    db.db.prepare("INSERT INTO tenants (name, slug, status, created_at) VALUES ('B', 'faq-b', 'active', '2026-01-01T00:00:00+00:00')").run();
    tenantB = db.db.prepare("SELECT id FROM tenants WHERE slug = 'faq-b'").get().id;
});

after(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const store = (tenantId = 1) => new KnowledgeStore(db.forTenant(tenantId));
let n = 0;
const uniq = (prefix) => `${prefix}-${(n += 1)}`;

/** A matcher-shaped item without touching the database. */
const item = (over = {}) => ({
    id: 1, question: '', answer: 'a', keywords: [], matchType: 'CONTAINS',
    locale: '', isActive: true, priority: 0, outOfHours: false, ...over,
});

// ------------------------------------------------------------------ matcher --
describe('matchFaq levels', () => {
    it('normalises away case, punctuation and runs of whitespace', () => {
        assert.equal(normalizeText('  What ARE your  HOURS?! '), 'what are your hours');
        assert.equal(normalizeText(null), '');
    });

    it('tries exact before contains before regex before similarity', () => {
        const items = [
            item({ id: 1, matchType: 'CONTAINS', keywords: ['hours'] }),
            item({ id: 2, matchType: 'EXACT', keywords: ['what are your hours'] }),
            item({ id: 3, matchType: 'REGEX', keywords: ['^hours?$'] }),
            item({ id: 4, matchType: 'SIMILARITY', question: 'what are your opening hours' }),
        ];
        // The EXACT item is listed second; level order still puts it first,
        // which the old engine's single pass over the list did not do.
        const exact = matchFaq('What are your hours?', items);
        assert.equal(exact.level, 'exact');
        assert.equal(exact.item.id, 2);
        assert.equal(exact.score, 1);

        assert.equal(matchFaq('tell me the hours please', items).level, 'contains');
        assert.equal(matchFaq('hour', [items[2], items[3]]).level, 'regex');
    });

    it('matches a regex against the raw text, so a pattern with punctuation still works', () => {
        const items = [item({ id: 7, matchType: 'REGEX', keywords: ['\\$\\d+'] })];
        assert.equal(matchFaq('is it $40?', items).level, 'regex');
    });

    it('survives a broken regex instead of throwing', () => {
        const items = [
            item({ id: 1, matchType: 'REGEX', keywords: ['([unclosed'] }),
            item({ id: 2, matchType: 'REGEX', keywords: ['refund'] }),
        ];
        assert.equal(matchFaq('refund please', items).item.id, 2);
    });

    it('falls back to a FALLBACK item and skips inactive ones', () => {
        const items = [
            item({ id: 1, matchType: 'CONTAINS', keywords: ['refund'], isActive: false }),
            item({ id: 2, matchType: 'FALLBACK' }),
        ];
        const hit = matchFaq('refund please', items);
        assert.equal(hit.level, 'fallback');
        assert.equal(hit.item.id, 2);
        assert.equal(matchFaq('', items), null, 'an empty message matches nothing at all');
    });

    it('settles a tie inside a level by priority, then by id', () => {
        const items = [
            item({ id: 5, matchType: 'CONTAINS', keywords: ['price'], priority: 0 }),
            item({ id: 6, matchType: 'CONTAINS', keywords: ['price'], priority: 9 }),
        ];
        assert.equal(matchFaq('what price', items).item.id, 6);
    });

    it('honours locale and keeps locale-less items as the default answer', () => {
        const items = [
            item({ id: 1, matchType: 'CONTAINS', keywords: ['price'], locale: 'hi' }),
            item({ id: 2, matchType: 'CONTAINS', keywords: ['price'], locale: '' }),
        ];
        assert.equal(matchFaq('price?', items, { locale: 'hi' }).item.id, 1);
        assert.equal(matchFaq('price?', items, { locale: 'en' }).item.id, 2);
    });
});

describe('similarity', () => {
    it('scores token overlap and refuses anything under the threshold', () => {
        const items = [item({ id: 1, matchType: 'SIMILARITY', question: 'do you deliver on sundays' })];
        const hit = matchFaq('do you deliver sundays', items);
        assert.equal(hit.level, 'similarity');
        assert.ok(hit.score >= SIMILARITY_THRESHOLD, `scored ${hit.score}`);

        // Shares one word out of several: a wrong answer here is worse than
        // none, so it is a miss.
        assert.equal(matchFaq('do i need an umbrella in chennai today', items), null);
    });

    it('picks the best candidate, not the first above the threshold', () => {
        const items = [
            item({ id: 1, matchType: 'SIMILARITY', question: 'how do i cancel my order' }),
            item({ id: 2, matchType: 'SIMILARITY', question: 'how do i cancel my subscription' }),
        ];
        assert.equal(matchFaq('how do i cancel my subscription please', items).item.id, 2);
    });

    it('takes a caller-supplied threshold', () => {
        const items = [item({ id: 1, matchType: 'SIMILARITY', question: 'where is my order' })];
        assert.equal(matchFaq('order', items), null);
        assert.equal(matchFaq('order', items, { threshold: 0.3 }).level, 'similarity');
    });

    it('dice is 1 for identical sets and 0 for disjoint ones', () => {
        assert.equal(dice(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
        assert.equal(dice(new Set(['a']), new Set(['b'])), 0);
        assert.equal(dice(new Set(), new Set(['b'])), 0);
    });

    it('consults the AI seam only after similarity has missed, and never otherwise', () => {
        let called = 0;
        const aiFallback = () => {
            called += 1;
            return null;
        };
        const items = [item({ id: 1, matchType: 'CONTAINS', keywords: ['refund'] })];
        matchFaq('refund', items, { aiFallback });
        assert.equal(called, 0, 'a deterministic hit must not reach for AI');
        matchFaq('something else entirely', items, { aiFallback });
        assert.equal(called, 1);
        // And with no handler the engine is still complete.
        assert.equal(matchFaq('something else entirely', items), null);
    });
});

describe('matchFaq is a superset of the keyword engine it replaces', () => {
    const engine = new AutoReplyEngine({ getActiveAutoReplies: () => [] }, null);
    const rules = [
        { id: 1, keyword: 'hi', matchType: 'EXACT', replyBody: 'hello' },
        { id: 2, keyword: 'refund', matchType: 'CONTAINS', replyBody: 'refunds take 5 days' },
        { id: 3, keyword: 'order\\s+\\d+', matchType: 'REGEX', replyBody: 'checking' },
        { id: 4, keyword: '', matchType: 'FALLBACK', replyBody: 'a human will reply' },
    ];
    // The same rules expressed as FAQ items: keyword -> keywords, reply -> answer.
    const asItems = rules.map((rule) => item({
        id: rule.id, matchType: rule.matchType, question: `rule ${rule.id}`,
        answer: rule.replyBody, keywords: rule.keyword ? [rule.keyword] : [],
    }));

    for (const text of ['hi', 'HI!', 'i want a refund', 'order 4412', 'something unrelated']) {
        it(`agrees with matchRule on ${JSON.stringify(text)}`, () => {
            const expected = engine.matchRule(text.trim().toLowerCase().replace(/[.!?]+$/, ''), rules);
            const got = matchFaq(text, asItems);
            assert.equal(got?.item.id ?? null, expected?.id ?? null);
        });
    }
});

describe('business-hours fallback', () => {
    // 09:00-17:00 UTC weekdays; the same window the send path uses.
    const channel = { timezone: 'UTC', businessHours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' } };
    const items = [
        item({ id: 1, matchType: 'CONTAINS', keywords: ['price'], answer: 'it is 40' }),
        item({ id: 2, matchType: 'FALLBACK', outOfHours: true, answer: 'we are closed, back at 9' }),
    ];

    it('answers normally inside the window', () => {
        const hit = matchFaq('price?', items, { channel, now: new Date('2026-10-07T10:00:00Z') });
        assert.equal(hit.item.id, 1);
    });

    it('lets the out-of-hours answer win outside it', () => {
        const hit = matchFaq('price?', items, { channel, now: new Date('2026-10-07T22:00:00Z') });
        assert.equal(hit.item.id, 2);
        assert.equal(hit.level, 'fallback');
        // Sunday is outside the configured days, not just the hours.
        assert.equal(matchFaq('price?', items, { channel, now: new Date('2026-10-11T10:00:00Z') }).item.id, 2);
    });

    it('answers normally outside the window when nothing is flagged out-of-hours', () => {
        const hit = matchFaq('price?', [items[0]], { channel, now: new Date('2026-10-07T22:00:00Z') });
        assert.equal(hit.item.id, 1);
    });

    it('ignores business hours when no channel is given', () => {
        assert.equal(matchFaq('price?', items, { now: new Date('2026-10-07T22:00:00Z') }).item.id, 1);
    });
});

// -------------------------------------------------------------------- store --
describe('categories', () => {
    it('slugifies, refuses a duplicate and counts its items', () => {
        const faq = store();
        const name = uniq('Billing');
        const category = faq.createCategory({ name });
        assert.equal(category.slug, name.toLowerCase());
        assert.throws(() => faq.createCategory({ name }), (err) => err instanceof KnowledgeError && err.status === 409);
        assert.throws(() => faq.createCategory({ name: '  ' }), KnowledgeError);

        faq.create({ question: uniq('q'), answer: 'yes', categoryId: category.id });
        const listed = faq.categories().find((c) => c.id === category.id);
        assert.equal(listed.itemCount, 1);
    });

    it('keeps the answers when a category is deleted', () => {
        const faq = store();
        const category = faq.createCategory({ name: uniq('Shipping') });
        const created = faq.create({ question: uniq('ship'), answer: 'two days', categoryId: category.id });
        faq.removeCategory(category.id);
        assert.equal(faq.getCategory(category.id), null);
        assert.equal(faq.get(created.id).categoryId, null, 'an answer outlives its filing');
    });

    it('refuses an unknown category on create', () => {
        assert.throws(
            () => store().create({ question: uniq('q'), answer: 'a', categoryId: 999999 }),
            (err) => err instanceof KnowledgeError && err.status === 404,
        );
    });
});

describe('FAQ items and history', () => {
    it('validates the question, the answer and the match type', () => {
        const faq = store();
        assert.throws(() => faq.create({ question: '', answer: 'a' }), KnowledgeError);
        assert.throws(() => faq.create({ question: 'q', answer: '' }), KnowledgeError);
        assert.throws(() => faq.create({ question: 'q', answer: 'a', matchType: 'VIBES' }), KnowledgeError);
    });

    it('versions a reworded answer and nothing else', () => {
        const faq = store();
        const created = faq.create({ question: uniq('refund policy'), answer: 'within 7 days', keywords: ['refund', 'refund'] });
        assert.deepEqual(created.keywords, ['refund'], 'duplicates collapse');
        assert.equal(faq.versions(created.id).length, 1);

        faq.update(created.id, { priority: 5, isActive: false });
        assert.equal(faq.versions(created.id).length, 1, 'a priority bump is not a new answer');

        const reworded = faq.update(created.id, { answer: 'within 14 days' });
        const versions = faq.versions(created.id);
        assert.equal(versions.length, 2);
        assert.equal(versions[0].version, 2);
        assert.equal(reworded.answer, 'within 14 days');
    });

    it('reverts by writing the old answer forward', () => {
        const faq = store();
        const created = faq.create({ question: uniq('hours'), answer: '9 to 5' });
        faq.update(created.id, { answer: '10 to 6' });
        const reverted = faq.revert(created.id, 1);
        assert.equal(reverted.answer, '9 to 5');
        const versions = faq.versions(created.id);
        assert.equal(versions.length, 3, 'history is append-only; nothing was deleted');
        assert.equal(versions.at(-1).answer, '9 to 5');
        assert.throws(() => faq.revert(created.id, 99), (err) => err.status === 404);
    });

    it('searches question, answer and keywords', () => {
        const faq = store();
        const created = faq.create({ question: uniq('do you ship to nepal'), answer: 'yes, by air', keywords: ['nepal'] });
        assert.ok(faq.search('nepal').some((row) => row.id === created.id));
        assert.ok(faq.search('by air').some((row) => row.id === created.id));
        assert.equal(faq.search('zzz-nothing-here').length, 0);
    });

    it('deletes an item and its history', () => {
        const faq = store();
        const created = faq.create({ question: uniq('gone'), answer: 'bye' });
        faq.remove(created.id);
        assert.equal(faq.get(created.id), null);
        assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM faq_item_versions WHERE item_id = ?').get(created.id).n, 0);
        assert.throws(() => faq.remove(created.id), (err) => err.status === 404);
    });
});

describe('analytics', () => {
    it('counts a hit, records a miss and ranks the misses by how many asked', () => {
        const faq = store();
        const created = faq.create({ question: uniq('what are your hours'), answer: '9 to 5', keywords: ['hours'], matchType: 'CONTAINS' });

        const hit = faq.answer('what are your hours?');
        assert.equal(hit.item.id, created.id);
        assert.equal(hit.item.hitCount, 1);

        faq.recordMiss('Do you take AMEX?');
        faq.recordMiss('do you take amex');
        const misses = faq.misses({ limit: 5 });
        const amex = misses.find((row) => row.text === 'do you take amex');
        assert.equal(amex.count, 2, 'one row per normalised question, not one per spelling');
        assert.equal(faq.recordMiss('   '), null);

        faq.clearMiss(amex.id);
        assert.equal(faq.misses().some((row) => row.id === amex.id), false);
        assert.throws(() => faq.clearMiss(amex.id), (err) => err.status === 404);
    });

    it('charges an unanswered question to faq_misses and the near-miss to the item', () => {
        const faq = store(tenantB);
        const created = faq.create({
            question: 'how do i change my delivery address', answer: 'reply with the new one',
            matchType: 'SIMILARITY',
        });
        assert.equal(faq.answer('delivery charges to kerala'), null, 'below threshold is a miss');
        assert.equal(faq.get(created.id).missCount, 1, 'the item that nearly answered wears the near-miss');
        assert.equal(faq.misses().some((row) => row.text === 'delivery charges to kerala'), true);
    });

    it('a dry run moves nothing', () => {
        const faq = store();
        const created = faq.create({ question: uniq('dry'), answer: 'a', keywords: ['dryrun'], matchType: 'CONTAINS' });
        const before = faq.misses().length;
        assert.equal(faq.answer('dryrun now', { record: false }).item.id, created.id);
        assert.equal(faq.answer('nothing matches this at all', { record: false }), null);
        assert.equal(faq.get(created.id).hitCount, 0);
        assert.equal(faq.misses().length, before);
    });

    it('reports coverage over everything that reached the layer', () => {
        const faq = store(tenantB);
        const stats = faq.stats();
        assert.ok(stats.items >= 1);
        assert.ok(stats.coverage >= 0 && stats.coverage <= 1);
        assert.ok(Array.isArray(stats.topMisses));
    });
});

describe('tenant isolation', () => {
    it('does not let one tenant read, patch or delete another tenant\'s FAQ', () => {
        const a = store();
        const b = store(tenantB);
        const mine = a.create({ question: uniq('secret pricing'), answer: 'internal', keywords: ['secret'] });
        const category = a.createCategory({ name: uniq('Internal') });

        assert.equal(b.get(mine.id), null);
        assert.equal(b.getCategory(category.id), null);
        assert.equal(b.list().some((row) => row.id === mine.id), false);
        assert.equal(b.search('secret').length, 0);
        assert.throws(() => b.update(mine.id, { answer: 'tampered' }), (err) => err.status === 404);
        assert.throws(() => b.remove(mine.id), (err) => err.status === 404);
        assert.throws(() => b.versions(mine.id), (err) => err.status === 404);
        assert.throws(() => b.removeCategory(category.id), (err) => err.status === 404);
        assert.equal(a.get(mine.id).answer, 'internal');

        // Misses are per tenant too, or one business's gaps leak into another's.
        b.recordMiss('tenant b only question');
        assert.equal(a.misses().some((row) => row.text === 'tenant b only question'), false);
    });
});

// ------------------------------------------------------------------- routes --
describe('routes', () => {
    let server;
    let base;
    const events = [];

    before(async () => {
        const app = express();
        app.use(express.json());
        app.use(createKnowledgeRouter({
            db: db.forTenant(1),
            state: { channel: null, broadcast: (event) => events.push(event) },
        }));
        server = app.listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => server?.close());

    const call = async (method, url, body) => {
        const res = await fetch(`${base}${url}`, {
            method,
            headers: body ? { 'content-type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
    };

    it('serves CRUD, keeps /faq/categories off the /faq/:id path and reports a 404 as a 404', async () => {
        const category = await call('POST', '/faq/categories', { name: uniq('Payments') });
        assert.equal(category.status, 201);

        const listed = await call('GET', '/faq/categories');
        assert.ok(listed.body.categories.some((c) => c.id === category.body.category.id));

        const created = await call('POST', '/faq', {
            question: uniq('do you accept upi'), answer: 'yes', keywords: ['upi'],
            matchType: 'CONTAINS', categoryId: category.body.category.id,
        });
        assert.equal(created.status, 201);
        const id = created.body.item.id;

        const read = await call('GET', `/faq/${id}`);
        assert.equal(read.body.versions.length, 1);

        const patched = await call('PUT', `/faq/${id}`, { answer: 'yes, UPI and cards' });
        assert.equal(patched.body.item.answer, 'yes, UPI and cards');

        const reverted = await call('POST', `/faq/${id}/revert`, { version: 1 });
        assert.equal(reverted.body.item.answer, 'yes');

        assert.equal((await call('GET', '/faq/999999')).status, 404);
        assert.equal((await call('POST', '/faq', { question: 'q', answer: '' })).status, 400);

        const renamed = await call('PUT', `/faq/categories/${category.body.category.id}`, { name: uniq('Billing') });
        assert.equal(renamed.status, 200);
        assert.equal((await call('DELETE', `/faq/categories/${category.body.category.id}`)).body.deleted, true);
        assert.equal((await call('DELETE', `/faq/${id}`)).body.deleted, true);
        assert.ok(events.some((event) => event.type === 'faq_item' && event.action === 'deleted'));
    });

    it('dry-runs a question and says to escalate when nothing matches', async () => {
        const created = await call('POST', '/faq', {
            question: uniq('where is my parcel'), answer: 'tracking link below', keywords: ['parcel'], matchType: 'CONTAINS',
        });
        const matched = await call('POST', '/faq/match', { text: 'where is my parcel?' });
        assert.equal(matched.body.level, 'contains');
        assert.equal(matched.body.escalate, false);
        assert.equal(matched.body.threshold, SIMILARITY_THRESHOLD);

        const missed = await call('POST', '/faq/match', { text: 'can i speak to a lawyer about my goldfish' });
        assert.equal(missed.body.match, null);
        assert.equal(missed.body.escalate, true, 'escalation is a result, not an answer');

        // The dry run must not have moved the counters or logged a miss.
        assert.equal((await call('GET', `/faq/${created.body.item.id}`)).body.item.hitCount, 0);
        const misses = await call('GET', '/faq/misses?limit=100');
        assert.equal(misses.body.misses.some((row) => row.text.includes('goldfish')), false);
    });

    it('serves stats, misses and the knowledge overview', async () => {
        assert.ok((await call('GET', '/faq/stats')).body.stats.items >= 1);
        assert.ok(Array.isArray((await call('GET', '/faq/misses')).body.misses));
        const overview = await call('GET', '/knowledge');
        assert.equal(overview.body.similarityThreshold, SIMILARITY_THRESHOLD);
        assert.ok(Array.isArray(overview.body.items));
        assert.ok(Array.isArray(overview.body.categories));
    });
});
