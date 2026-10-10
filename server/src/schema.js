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

import { BILLING_SCHEMA } from './billing/schema.js';
import { CAMPAIGNS_SCHEMA } from './campaigns/schema.js';
import { INBOX_SCHEMA } from './inbox/schema.js';
import { INTERACTIVE_SCHEMA } from './messaging/replies.js';
import { KNOWLEDGE_SCHEMA } from './knowledge/schema.js';
import { OBJECTS_SCHEMA } from './objects/schema.js';
import { POLICY_SCHEMA } from './policy/schema.js';
import { PUBLIC_API_SCHEMA } from './publicapi/schema.js';
import { SCHEDULER_SCHEMA } from './scheduler/schema.js';
import { TEMPLATES_SCHEMA } from './templates/schema.js';
import { SCHOOL_SCHEMA } from './school/settings.js';
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
    BILLING_SCHEMA,
    PUBLIC_API_SCHEMA,
    CAMPAIGNS_SCHEMA,
    SCHOOL_SCHEMA,
    INTERACTIVE_SCHEMA,
    POLICY_SCHEMA,
];
