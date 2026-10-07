/**
 * Phase 13 table. Listed in `MODULE_SCHEMAS` by `src/schema.js`.
 *
 * A campaign is a *record*, not an engine: the sending still happens in
 * `CampaignManager` (pacing, daily cap, opt-out, duplicate protection). This
 * row is what the operator edits, schedules and reports on, and the bridge
 * between the two is `messages.campaign_id = 'camp-<id>'`, which is already
 * indexed - so campaign analytics is a GROUP BY, not a second set of counters.
 *
 * `audience` is JSON: either an inline contact filter (the same shape a
 * segment stores) or an explicit list of `{ name, phone }`. `segment_id` wins
 * when both are set, because a saved segment is resolved at send time and so
 * is always the more current answer.
 */

export const CAMPAIGNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    channel_id INTEGER,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    template_id INTEGER,
    body TEXT NOT NULL DEFAULT '',
    segment_id INTEGER,
    audience TEXT NOT NULL DEFAULT 'null',
    media_id TEXT,
    scheduled_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    stats TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_campaigns_due ON campaigns(status, scheduled_at);
`;
