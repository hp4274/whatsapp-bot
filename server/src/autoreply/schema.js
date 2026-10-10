/**
 * Auto-replies v2 storage. Called from the Database constructor after the core
 * schema, so `auto_replies` already exists (with tenant_id) by the time the
 * columns below are added.
 *
 * Old rows keep working: `priority` is back-filled with the order the v1 engine
 * used (EXACT, CONTAINS, REGEX, FALLBACK, then id), and an empty `config` reads
 * as "one keyword, one reply, everyone, any time".
 */

const TABLES = `
CREATE TABLE IF NOT EXISTS autoreply_settings (
    tenant_id   INTEGER PRIMARY KEY,
    settings    TEXT NOT NULL DEFAULT '{}',
    updated_at  TEXT NOT NULL
);
-- Which menu a contact is answering. One row per contact per number; expires.
CREATE TABLE IF NOT EXISTS autoreply_sessions (
    tenant_id   INTEGER NOT NULL,
    channel_id  INTEGER NOT NULL DEFAULT 0,
    phone       TEXT NOT NULL,
    rule_id     INTEGER NOT NULL,
    path        TEXT NOT NULL DEFAULT '[]',
    expires_at  TEXT NOT NULL,
    PRIMARY KEY (tenant_id, channel_id, phone)
);
-- One row per reply actually sent. Analytics and the per-contact throttles read it.
CREATE TABLE IF NOT EXISTS autoreply_hits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL,
    channel_id  INTEGER NOT NULL DEFAULT 0,
    rule_key    TEXT NOT NULL,
    phone       TEXT NOT NULL,
    at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_autoreply_hits_key ON autoreply_hits(tenant_id, rule_key, at);
CREATE INDEX IF NOT EXISTS idx_autoreply_hits_phone ON autoreply_hits(tenant_id, channel_id, phone, rule_key, at);
`;

export function migrateAutoReplies(db) {
    const cols = db.prepare('PRAGMA table_info(auto_replies)').all().map((c) => c.name);
    if (!cols.includes('priority')) {
        db.exec('ALTER TABLE auto_replies ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
        db.exec(`UPDATE auto_replies SET priority = (
            SELECT n FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY CASE match_type
                    WHEN 'EXACT' THEN 1 WHEN 'CONTAINS' THEN 2 WHEN 'REGEX' THEN 3 WHEN 'FALLBACK' THEN 4 ELSE 5 END, id) AS n
                FROM auto_replies
            ) ranked WHERE ranked.id = auto_replies.id)`);
    }
    if (!cols.includes('name')) db.exec("ALTER TABLE auto_replies ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('config')) db.exec("ALTER TABLE auto_replies ADD COLUMN config TEXT NOT NULL DEFAULT '{}'");
    db.exec(TABLES);
}
