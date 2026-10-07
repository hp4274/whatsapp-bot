/**
 * Tables for the knowledge base and FAQ engine.
 *
 * `faq_item_versions` has no `tenant_id`: a version is only ever reached
 * through its item, and the store resolves the item under the tenant first.
 * Same reasoning as `template_versions` - one owner for one fact.
 *
 * `faq_misses` is the table an operator actually reads. Every question that
 * matched nothing above the similarity threshold lands here with a count, so
 * "what should I write next" is a query rather than a guess.
 */

export const KNOWLEDGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS faq_categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  INTEGER NOT NULL,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- The slug is how an API caller or an import refers to a category, so it
    -- has to be unique per tenant rather than merely conventionally so.
    UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_faq_categories_tenant ON faq_categories(tenant_id, position, id);

CREATE TABLE IF NOT EXISTS faq_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL,
    -- NULL means "uncategorised"; deleting a category nulls this rather than
    -- taking the answers with it, because an answer outlives its filing.
    category_id INTEGER REFERENCES faq_categories(id) ON DELETE SET NULL,
    question    TEXT NOT NULL DEFAULT '',
    answer      TEXT NOT NULL DEFAULT '',
    keywords    TEXT NOT NULL DEFAULT '[]',
    match_type  TEXT NOT NULL DEFAULT 'CONTAINS',
    locale      TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    priority    INTEGER NOT NULL DEFAULT 0,
    -- Analytics live on the row: a counter answers "which answers earn their
    -- keep" without an events table that would need its own retention policy.
    hit_count   INTEGER NOT NULL DEFAULT 0,
    miss_count  INTEGER NOT NULL DEFAULT 0,
    -- Not in the phase's column list, but the business-hours task needs a
    -- flag somewhere and a column beats encoding it in the question text.
    -- Set on the one answer that should win outside the channel's window.
    out_of_hours INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_faq_items_tenant   ON faq_items(tenant_id, is_active, priority DESC, id);
CREATE INDEX IF NOT EXISTS idx_faq_items_category ON faq_items(tenant_id, category_id);

CREATE TABLE IF NOT EXISTS faq_item_versions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    INTEGER NOT NULL REFERENCES faq_items(id) ON DELETE CASCADE,
    version    INTEGER NOT NULL,
    question   TEXT NOT NULL DEFAULT '',
    answer     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    -- History is append-only; the constraint is what makes that enforceable
    -- rather than a convention someone breaks with an UPDATE.
    UNIQUE (item_id, version)
);

CREATE TABLE IF NOT EXISTS faq_misses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id    INTEGER NOT NULL,
    -- The normalised question, so "What are your HOURS?" and "what are your
    -- hours" are one row with count 2 instead of two rows with count 1.
    text         TEXT NOT NULL,
    count        INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT NOT NULL,
    UNIQUE (tenant_id, text)
);
CREATE INDEX IF NOT EXISTS idx_faq_misses_tenant ON faq_misses(tenant_id, count DESC, id);
`;
