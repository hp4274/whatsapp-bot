/**
 * Per-tenant library of uploaded files. Listed in `MODULE_SCHEMAS` by `src/schema.js`.
 *
 * `sha256` is the identity: the same bytes uploaded again by the same tenant
 * are the same row (UNIQUE), never a second copy. `stored_name` is the file
 * under `server/uploads`; `media_id` is set for media only (sheets are not
 * addressable by id outside this table).
 */

export const STORAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS stored_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    name TEXT NOT NULL,
    mimetype TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    stored_name TEXT NOT NULL,
    media_id TEXT,
    rows INTEGER,
    uses INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    UNIQUE (tenant_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_stored_files_recent ON stored_files(tenant_id, last_used_at);
`;
