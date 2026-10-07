/**
 * Phase 16 tables. Listed in `MODULE_SCHEMAS` by `src/schema.js`.
 *
 * `api_keys` stores `key_hash`, never the key - a leaked database must not
 * hand the attacker working credentials, which is the same reason `sessions`
 * stores a hash in `db.js`. `prefix` is the readable half so an operator can
 * tell two keys apart in a list without either being reconstructable from it.
 *
 * `webhook_endpoints.secret` is the one plaintext secret here, and it has to
 * be: HMAC needs the same bytes on both sides, and the customer holds the
 * other copy. It signs, it does not authenticate anything inbound.
 *
 * `webhook_deliveries` is the attempt record, one row per (endpoint, event).
 * Retry scheduling lives in `scheduled_jobs` - this table says what happened,
 * the job queue says what happens next.  Two sources of truth for "when is the
 * next attempt" is how you get a webhook delivered twice.
 *
 * `api_idempotency` is keyed on (tenant, key) so a customer's integration can
 * retry a POST after a timeout without creating a second order. The whole
 * response is stored, status included, because "the original result" means the
 * original result, not a fresh one that happens to look similar.
 */

export const PUBLIC_API_SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id, id);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '[]',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_tenant ON webhook_endpoints(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    endpoint_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    attempt INTEGER NOT NULL DEFAULT 0,
    response_code INTEGER,
    error TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(tenant_id, endpoint_id, id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(tenant_id, status);

CREATE TABLE IF NOT EXISTS api_idempotency (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    route TEXT NOT NULL,
    status INTEGER NOT NULL,
    response TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_idempotency_key ON api_idempotency(tenant_id, key);
`;
