/**
 * Phase 11 tables. Listed in `MODULE_SCHEMAS` by `src/schema.js`.
 *
 * One table for every business object, with a `type` discriminator and the
 * industry-specific fields in `data`. Eight near-identical tables would be
 * eight copies of the same CRUD; Rule 9 says a new industry adds
 * configuration, so the shape lives in `types.js` and the storage is shared.
 *
 * `occurs_at` is the one field promoted out of JSON: reminders and overdue
 * sweeps query it with a range, and a range over json_extract has no index.
 *
 * `object_events` is append-only. Nothing updates or deletes a row there; it
 * is the trail a support person reads when an order "did not get its message".
 */

export const OBJECTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS business_objects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    channel_id INTEGER,
    type TEXT NOT NULL,
    reference TEXT NOT NULL,
    contact_id INTEGER,
    status TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    occurs_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_objects_ref ON business_objects(tenant_id, type, reference);
CREATE INDEX IF NOT EXISTS idx_business_objects_type ON business_objects(tenant_id, type, status);
CREATE INDEX IF NOT EXISTS idx_business_objects_contact ON business_objects(tenant_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_business_objects_due ON business_objects(tenant_id, type, occurs_at);

CREATE TABLE IF NOT EXISTS object_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    object_id INTEGER NOT NULL,
    change TEXT NOT NULL,
    field TEXT,
    from_value TEXT,
    to_value TEXT,
    source TEXT NOT NULL DEFAULT 'api',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_object_events_object ON object_events(tenant_id, object_id, id);
`;
