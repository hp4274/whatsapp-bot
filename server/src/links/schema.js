/**
 * Link click tracking. Listed in `MODULE_SCHEMAS` by `src/schema.js`.
 *
 * One row per (message, link): the campaign's text had `url`, the recipient
 * got `${PUBLIC_BASE_URL}/l/<code>` instead, and `GET /l/:code` counts the tap
 * and redirects. The code is random and the only key: the public route never
 * needs a tenant, and a code says nothing about whose it is.
 */

export const LINKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS link_codes (
    code        TEXT PRIMARY KEY,
    tenant_id   INTEGER NOT NULL,
    campaign_id TEXT NOT NULL DEFAULT '',
    message_id  TEXT NOT NULL DEFAULT '',
    recipient   TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL,
    clicks      INTEGER NOT NULL DEFAULT 0,
    first_at    TEXT,
    last_at     TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_codes_campaign ON link_codes(tenant_id, campaign_id);
`;
