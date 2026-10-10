/** Kept apart from index.js so db.js can load it without pulling in the billing store. */
export const POLICY_SCHEMA = `
CREATE TABLE IF NOT EXISTS platform_policy (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, key)
);
`;
