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

import { INBOX_SCHEMA } from './inbox/schema.js';
import { KNOWLEDGE_SCHEMA } from './knowledge/schema.js';
import { OBJECTS_SCHEMA } from './objects/schema.js';
import { SCHEDULER_SCHEMA } from './scheduler/schema.js';
import { TEMPLATES_SCHEMA } from './templates/schema.js';
import { TICKETS_SCHEMA } from './tickets/schema.js';
import { WORKFLOWS_SCHEMA } from './workflows/schema.js';

export const MODULE_SCHEMAS = [
    TEMPLATES_SCHEMA,
    WORKFLOWS_SCHEMA,
    SCHEDULER_SCHEMA,
    INBOX_SCHEMA,
    TICKETS_SCHEMA,
    KNOWLEDGE_SCHEMA,
    OBJECTS_SCHEMA,
];
