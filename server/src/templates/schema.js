/**
 * Tables for the template library.
 *
 * `template_versions` has no `tenant_id` of its own: a version is only ever
 * reached through its template, and the store resolves the template under the
 * tenant first. One owner for one fact beats two columns that can disagree.
 */

export const TEMPLATES_SCHEMA = `
CREATE TABLE IF NOT EXISTS templates (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id              INTEGER NOT NULL,
    name                   TEXT NOT NULL,
    template_type          TEXT NOT NULL DEFAULT 'text',
    body                   TEXT NOT NULL DEFAULT '',
    variables              TEXT NOT NULL DEFAULT '[]',
    -- NULL means "any channel"; a value pins the template to one number.
    channel_id             INTEGER,
    provider_template_name TEXT NOT NULL DEFAULT '',
    approval_status        TEXT NOT NULL DEFAULT 'draft',
    current_version        INTEGER NOT NULL DEFAULT 1,
    use_count              INTEGER NOT NULL DEFAULT 0,
    last_used_at           TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    -- The name is how a workflow or an API caller refers to a template, so it
    -- has to be unique per tenant rather than merely conventionally so.
    UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_templates_tenant ON templates(tenant_id, id);
CREATE INDEX IF NOT EXISTS idx_templates_type   ON templates(tenant_id, template_type);

CREATE TABLE IF NOT EXISTS template_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    variables   TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL,
    -- History is append-only; the constraint is what makes that enforceable
    -- rather than a convention someone breaks with an UPDATE.
    UNIQUE (template_id, version)
);
`;
