/**
 * The knowledge base: FAQ items, their categories, their answer history, and
 * the questions nothing answered.
 *
 * Answers are versioned append-only, same as templates: an edit to the wording
 * writes a new row, a re-filing or a priority bump does not, and a revert
 * writes the old answer forward instead of deleting what came after it. A
 * customer who was told version 2 must stay able to see version 2.
 *
 * Nothing in here sends anything. `answer()` returns a match; the caller
 * decides whether to send it, and the send path's opt-out check is the one
 * authority on whether that is allowed. A FAQ answer must not become a way
 * around STOP.
 */

import { utcNow } from '../protocol.js';
import { MATCH_TYPES, matchFaq, nearestFaq, normalizeText } from './matcher.js';

export class KnowledgeError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export class KnowledgeStore {
    /** @param {import('../db.js').Database} database a tenant-scoped handle */
    constructor(database) {
        this.db = database.db;
        this.tenantId = database.tenantId;
    }

    // --------------------------------------------------------- categories --
    createCategory({ name, slug, position = 0 }) {
        const clean = String(name ?? '').trim();
        if (!clean) throw new KnowledgeError('a category needs a name');
        const key = slugify(slug || clean);
        if (this.getCategoryBySlug(key)) throw new KnowledgeError(`a category ${key} already exists`, 409);
        const now = utcNow();
        const info = this.db.prepare(
            `INSERT INTO faq_categories (tenant_id, name, slug, position, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`)
            .run(this.tenantId, clean, key, Number(position) || 0, now, now);
        return this.getCategory(Number(info.lastInsertRowid));
    }

    updateCategory(id, patch = {}) {
        const category = this.#requireCategory(id);
        let slug = category.slug;
        if (patch.slug !== undefined || patch.name !== undefined) {
            slug = slugify(patch.slug || patch.name || category.slug);
            const clash = this.getCategoryBySlug(slug);
            if (clash && clash.id !== category.id) {
                throw new KnowledgeError(`a category ${slug} already exists`, 409);
            }
        }
        this.db.prepare(
            `UPDATE faq_categories SET name = ?, slug = ?, position = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ?`)
            .run(
                patch.name === undefined ? category.name : String(patch.name).trim(),
                slug,
                patch.position === undefined ? category.position : Number(patch.position) || 0,
                utcNow(), category.id, this.tenantId,
            );
        return this.getCategory(category.id);
    }

    getCategory(id) {
        const row = this.db.prepare('SELECT * FROM faq_categories WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId);
        return row ? toCategory(row) : null;
    }

    getCategoryBySlug(slug) {
        const row = this.db.prepare('SELECT * FROM faq_categories WHERE tenant_id = ? AND slug = ?')
            .get(this.tenantId, slugify(slug));
        return row ? toCategory(row) : null;
    }

    /** With how many items each holds, which is the only thing a UI asks next. */
    categories() {
        return this.db.prepare(
            `SELECT c.*, (SELECT COUNT(*) FROM faq_items i
                          WHERE i.tenant_id = c.tenant_id AND i.category_id = c.id) AS n
             FROM faq_categories c WHERE c.tenant_id = ? ORDER BY c.position, c.id`)
            .all(this.tenantId).map((row) => ({ ...toCategory(row), itemCount: row.n }));
    }

    /** Items survive; they just lose their filing. ON DELETE SET NULL does it. */
    removeCategory(id) {
        const category = this.#requireCategory(id);
        this.db.prepare('UPDATE faq_items SET category_id = NULL WHERE tenant_id = ? AND category_id = ?')
            .run(this.tenantId, category.id);
        this.db.prepare('DELETE FROM faq_categories WHERE id = ? AND tenant_id = ?')
            .run(category.id, this.tenantId);
        return category;
    }

    // -------------------------------------------------------------- items --
    create({
        question, answer, keywords, categoryId = null, matchType = 'CONTAINS',
        locale = '', isActive = true, priority = 0, outOfHours = false,
    }) {
        const clean = String(question ?? '').trim();
        if (!clean) throw new KnowledgeError('a FAQ item needs a question');
        const type = String(matchType).toUpperCase();
        if (!MATCH_TYPES.includes(type)) {
            throw new KnowledgeError(`match type must be one of ${MATCH_TYPES.join(', ')}`);
        }
        const body = String(answer ?? '').trim();
        if (!body) throw new KnowledgeError('a FAQ item needs an answer');
        const category = categoryId == null ? null : this.#requireCategory(categoryId).id;
        const now = utcNow();
        const info = this.db.prepare(
            `INSERT INTO faq_items (tenant_id, category_id, question, answer, keywords, match_type,
                                    locale, is_active, priority, out_of_hours, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
                this.tenantId, category, clean, body, JSON.stringify(cleanKeywords(keywords)),
                type, String(locale ?? '').trim(), isActive ? 1 : 0, Number(priority) || 0,
                outOfHours ? 1 : 0, now, now,
            );
        const id = Number(info.lastInsertRowid);
        this.#writeVersion(id, 1, clean, body, now);
        return this.get(id);
    }

    /**
     * Patch an item. A change to the question or the answer writes a version;
     * a re-filing, a priority bump or a deactivation does not, because none of
     * them changes what a customer reads.
     */
    update(id, patch = {}) {
        const item = this.#require(id);
        const type = patch.matchType === undefined ? item.matchType : String(patch.matchType).toUpperCase();
        if (!MATCH_TYPES.includes(type)) {
            throw new KnowledgeError(`match type must be one of ${MATCH_TYPES.join(', ')}`);
        }
        const question = patch.question === undefined ? item.question : String(patch.question).trim();
        const answer = patch.answer === undefined ? item.answer : String(patch.answer).trim();
        if (!question) throw new KnowledgeError('a FAQ item needs a question');
        if (!answer) throw new KnowledgeError('a FAQ item needs an answer');
        const categoryId = patch.categoryId === undefined
            ? item.categoryId
            : (patch.categoryId == null ? null : this.#requireCategory(patch.categoryId).id);

        const now = utcNow();
        this.db.prepare(
            `UPDATE faq_items SET category_id = ?, question = ?, answer = ?, keywords = ?,
                                  match_type = ?, locale = ?, is_active = ?, priority = ?,
                                  out_of_hours = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ?`)
            .run(
                categoryId, question, answer,
                patch.keywords === undefined ? JSON.stringify(item.keywords) : JSON.stringify(cleanKeywords(patch.keywords)),
                type, patch.locale === undefined ? item.locale : String(patch.locale).trim(),
                patch.isActive === undefined ? (item.isActive ? 1 : 0) : (patch.isActive ? 1 : 0),
                patch.priority === undefined ? item.priority : Number(patch.priority) || 0,
                patch.outOfHours === undefined ? (item.outOfHours ? 1 : 0) : (patch.outOfHours ? 1 : 0),
                now, item.id, this.tenantId,
            );
        if (question !== item.question || answer !== item.answer) {
            this.#writeVersion(item.id, this.#nextVersion(item.id), question, answer, now);
        }
        return this.get(item.id);
    }

    remove(id) {
        const item = this.#require(id);
        this.db.prepare('DELETE FROM faq_item_versions WHERE item_id = ?').run(item.id);
        this.db.prepare('DELETE FROM faq_items WHERE id = ? AND tenant_id = ?').run(item.id, this.tenantId);
        return item;
    }

    get(id) {
        const row = this.db.prepare('SELECT * FROM faq_items WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId);
        return row ? toItem(row) : null;
    }

    list({ categoryId, locale, activeOnly = false } = {}) {
        const clauses = ['tenant_id = ?'];
        const args = [this.tenantId];
        if (categoryId !== undefined) {
            if (categoryId == null) clauses.push('category_id IS NULL');
            else {
                clauses.push('category_id = ?');
                args.push(Number(categoryId));
            }
        }
        if (locale) {
            // An item with no locale is the default answer, so it stays in a
            // locale-filtered read rather than disappearing from it.
            clauses.push("(locale = '' OR locale = ?)");
            args.push(String(locale));
        }
        if (activeOnly) clauses.push('is_active = 1');
        return this.db.prepare(
            `SELECT * FROM faq_items WHERE ${clauses.join(' AND ')}
             ORDER BY priority DESC, id`).all(...args).map(toItem);
    }

    // ------------------------------------------------------------ history --
    versions(id) {
        const item = this.#require(id);
        return this.db.prepare('SELECT * FROM faq_item_versions WHERE item_id = ? ORDER BY version DESC')
            .all(item.id).map(toVersion);
    }

    getVersion(id, version) {
        const item = this.#require(id);
        const row = this.db.prepare('SELECT * FROM faq_item_versions WHERE item_id = ? AND version = ?')
            .get(item.id, Number(version));
        return row ? toVersion(row) : null;
    }

    /** Roll an answer back by writing it forward. History is never rewritten. */
    revert(id, version) {
        const item = this.#require(id);
        const old = this.getVersion(item.id, version);
        if (!old) throw new KnowledgeError(`faq version ${version} not found`, 404);
        return this.update(item.id, { question: old.question, answer: old.answer });
    }

    // ---------------------------------------------------------- analytics --
    recordHit(id) {
        const item = this.#require(id);
        this.db.prepare('UPDATE faq_items SET hit_count = hit_count + 1 WHERE id = ? AND tenant_id = ?')
            .run(item.id, this.tenantId);
        return this.get(item.id);
    }

    /**
     * A question nothing answered. Stored normalised and counted, so the list
     * an operator reads is ranked by how many customers asked rather than by
     * how many spellings they used.
     */
    recordMiss(text) {
        const key = normalizeText(text);
        if (!key) return null;
        const now = utcNow();
        this.db.prepare(
            `INSERT INTO faq_misses (tenant_id, text, count, last_seen_at) VALUES (?, ?, 1, ?)
             ON CONFLICT (tenant_id, text) DO UPDATE SET count = count + 1, last_seen_at = excluded.last_seen_at`)
            .run(this.tenantId, key, now);
        const row = this.db.prepare('SELECT * FROM faq_misses WHERE tenant_id = ? AND text = ?')
            .get(this.tenantId, key);
        return toMiss(row);
    }

    /** What to write next, most-asked first. */
    misses({ limit = 50 } = {}) {
        return this.db.prepare(
            `SELECT * FROM faq_misses WHERE tenant_id = ?
             ORDER BY count DESC, last_seen_at DESC LIMIT ?`)
            .all(this.tenantId, Math.min(Number(limit) || 50, 500)).map(toMiss);
    }

    clearMiss(id) {
        const info = this.db.prepare('DELETE FROM faq_misses WHERE id = ? AND tenant_id = ?')
            .run(Number(id), this.tenantId);
        if (!info.changes) throw new KnowledgeError('miss not found', 404);
        return true;
    }

    stats() {
        const totals = this.db.prepare(
            `SELECT COUNT(*) AS items,
                    SUM(is_active) AS active,
                    COALESCE(SUM(hit_count), 0) AS hits,
                    COALESCE(SUM(miss_count), 0) AS itemMisses
             FROM faq_items WHERE tenant_id = ?`).get(this.tenantId);
        const misses = this.db.prepare(
            'SELECT COUNT(*) AS distinctText, COALESCE(SUM(count), 0) AS total FROM faq_misses WHERE tenant_id = ?')
            .get(this.tenantId);
        const answered = Number(totals.hits) || 0;
        const unanswered = Number(misses.total) || 0;
        return {
            items: Number(totals.items) || 0,
            activeItems: Number(totals.active) || 0,
            categories: this.db.prepare('SELECT COUNT(*) AS n FROM faq_categories WHERE tenant_id = ?')
                .get(this.tenantId).n,
            hits: answered,
            misses: unanswered,
            distinctMisses: Number(misses.distinctText) || 0,
            // The number an operator is actually judged on: of the questions
            // that reached the FAQ layer, how many got an answer.
            coverage: answered + unanswered ? Number((answered / (answered + unanswered)).toFixed(4)) : 0,
            topItems: this.db.prepare(
                `SELECT id, question, hit_count AS hits, miss_count AS misses FROM faq_items
                 WHERE tenant_id = ? AND hit_count > 0 ORDER BY hit_count DESC, id LIMIT 10`)
                .all(this.tenantId),
            topMisses: this.misses({ limit: 10 }),
        };
    }

    /** Operator-facing text search, not the matcher. LIKE is enough here. */
    search(text) {
        const like = `%${String(text ?? '').trim()}%`;
        return this.db.prepare(
            `SELECT * FROM faq_items WHERE tenant_id = ?
               AND (question LIKE ? OR answer LIKE ? OR keywords LIKE ?)
             ORDER BY priority DESC, id`)
            .all(this.tenantId, like, like, like).map(toItem);
    }

    // ------------------------------------------------------------ answering --
    /**
     * The one call the inbound path needs: match, then count the outcome.
     *
     * A hit bumps the item's counter. A miss lands in `faq_misses` and returns
     * null - escalation is the caller's decision, because only the caller knows
     * whether a human is available and whether this number may be messaged at
     * all. `record: false` makes it a dry run, which is what the operator's
     * test harness wants: trying out a question should not move the analytics.
     */
    answer(text, { channel = null, now = new Date(), locale = '', record = true, threshold } = {}) {
        const items = this.list({ activeOnly: true });
        const match = matchFaq(text, items, { channel, now, locale, threshold });
        if (!record) return match;
        if (match) {
            this.recordHit(match.item.id);
            return { ...match, item: this.get(match.item.id) };
        }
        this.recordMiss(text);
        // Charge the near-miss to the item that almost answered, so an item
        // whose keywords are too narrow shows up as such.
        const near = nearestFaq(text, items);
        if (near) {
            this.db.prepare('UPDATE faq_items SET miss_count = miss_count + 1 WHERE id = ? AND tenant_id = ?')
                .run(near.item.id, this.tenantId);
        }
        return null;
    }

    // ------------------------------------------------------------ private --
    #require(id) {
        const item = this.get(id);
        if (!item) throw new KnowledgeError('faq item not found', 404);
        return item;
    }

    #requireCategory(id) {
        const category = this.getCategory(id);
        if (!category) throw new KnowledgeError('faq category not found', 404);
        return category;
    }

    #nextVersion(itemId) {
        // Derived rather than stored: a `current_version` column is a second
        // owner of a fact MAX() already knows.
        const row = this.db.prepare('SELECT MAX(version) AS v FROM faq_item_versions WHERE item_id = ?')
            .get(itemId);
        return Number(row?.v ?? 0) + 1;
    }

    #writeVersion(itemId, version, question, answer, at) {
        this.db.prepare(
            `INSERT INTO faq_item_versions (item_id, version, question, answer, created_at)
             VALUES (?, ?, ?, ?, ?)`).run(itemId, version, question, answer, at);
    }
}

const slugify = (value) => String(value ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const cleanKeywords = (keywords) => (Array.isArray(keywords)
    ? [...new Set(keywords.map((k) => String(k).trim()).filter(Boolean))]
    : []);

function toCategory(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        name: row.name,
        slug: row.slug,
        position: row.position,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toItem(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        categoryId: row.category_id ?? null,
        question: row.question ?? '',
        answer: row.answer ?? '',
        keywords: parse(row.keywords, []),
        matchType: row.match_type,
        locale: row.locale ?? '',
        isActive: Boolean(row.is_active),
        priority: row.priority ?? 0,
        hitCount: row.hit_count ?? 0,
        missCount: row.miss_count ?? 0,
        outOfHours: Boolean(row.out_of_hours),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toVersion(row) {
    return {
        id: row.id,
        itemId: row.item_id,
        version: row.version,
        question: row.question ?? '',
        answer: row.answer ?? '',
        createdAt: row.created_at,
    };
}

function toMiss(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        text: row.text,
        count: row.count,
        lastSeenAt: row.last_seen_at,
    };
}

function parse(value, fallback) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}
