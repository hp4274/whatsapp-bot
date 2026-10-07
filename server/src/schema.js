/**
 * Where feature modules hand their tables to the database.
 *
 * `db.js` owns the core schema - tenants, users, messages, channels. Anything
 * a feature adds lives beside that feature and is listed here, so building a
 * new feature never means editing one shared template literal, and two
 * features can be built at the same time without colliding.
 *
 * Order matters only where a foreign key does: list a table after what it
 * references.
 */

import { SCHEDULER_SCHEMA } from './scheduler/schema.js';
import { TEMPLATES_SCHEMA } from './templates/schema.js';
import { WORKFLOWS_SCHEMA } from './workflows/schema.js';

export const MODULE_SCHEMAS = [
    TEMPLATES_SCHEMA,
    WORKFLOWS_SCHEMA,
    SCHEDULER_SCHEMA,
];
