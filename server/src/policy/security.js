/**
 * Per-tenant security settings. See `index.js` for the field shape. Tenants
 * never see these (GET /api/policy strips `security.*`): an allow-list or a
 * rate limit is not something to advertise to the account it constrains.
 *
 * Rate limits are token buckets (security/signature.js): the dashboard API per
 * business, the public API per key. Changes reach a live bucket within the
 * 5s cache in app.js.
 */

import { ipEntryError } from '../security/ip.js';

const S = 'account';
const G = 'Security';

export const SECURITY_POLICY = Object.freeze([
    { key: 'security.apiRatePerSecond', service: S, group: G, type: 'int', default: 20, min: 1, max: 1000,
      label: 'Dashboard API requests per second', hint: 'Shared by everyone signed in to the business.' },
    { key: 'security.apiBurst', service: S, group: G, type: 'int', default: 40, min: 1, max: 10000,
      label: 'Dashboard API burst', hint: 'Requests allowed at once after a quiet spell.' },
    { key: 'security.publicApiRatePerSecond', service: S, group: G, type: 'int', default: 10, min: 1, max: 1000,
      label: 'Public API requests per second', hint: 'Per API key.' },
    { key: 'security.publicApiBurst', service: S, group: G, type: 'int', default: 20, min: 1, max: 10000,
      label: 'Public API burst', hint: 'Per API key.' },
    { key: 'security.sessionIdleMinutes', service: S, group: G, type: 'int', default: 720, min: 5, max: 43200,
      label: 'Sign out after idle (minutes)', hint: 'A session unused this long ends. Super admins keep the platform default.' },
    { key: 'security.ipAllowList', service: S, group: G, type: 'list', default: [],
      label: 'Public API IP allow-list', hint: 'One address or IPv4 CIDR (10.0.0.0/24) per line. Empty = any address.',
      check: (values) => (values['security.ipAllowList'] ?? []).map(ipEntryError).find(Boolean) ?? null },
    { key: 'security.apiKeyMaxAgeDays', service: S, group: G, type: 'int', default: 0, min: 0, max: 3650, unlimitedAt: 0,
      label: 'API key maximum age (days)', hint: 'New keys expire within this many days, and older keys stop working past it. 0 = no limit.' },
]);
