/**
 * Audit entries as a sentence a person reads, next to the raw record.
 *
 * The audit table stores what the code knew at the time: an action code, a target id and a detail blob (JSON or
 * free text). That is the evidence and stays untouched; this module only reads it. `describeAudit` turns one row
 * into `{ summary, severity, category, verb }`, using names the caller resolved cheaply (tenant, user, number,
 * campaign) so the super admin reads "Paused number "Sales" (Acme)" rather than `channel.admin.pause 7`.
 *
 * Unknown actions never throw and never come back empty: a new `audit(req, 'x.y')` written next month still
 * reads as "x y" until someone adds a sentence for it here.
 */

import { POLICY_FIELDS } from '../policy/index.js';
import { DEFAULT_PLANS } from '../billing/plans.js';

const FIELD_LABEL = new Map(POLICY_FIELDS.map((f) => [f.key, f.label ?? f.key]));
const KILL_SWITCH = 'bulk.killSwitch';

/** Detail as an object when it is JSON, else the text as written (`{}` for empty). */
export function parseDetail(detail) {
    if (detail && typeof detail === 'object') return detail;
    const text = String(detail ?? '').trim();
    if (!text) return {};
    if (text.startsWith('{') || text.startsWith('[')) {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }
    return text;
}

const quote = (s) => `"${String(s).slice(0, 80)}"`;
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString('en-US')} ${Number(n) === 1 ? one : many}`;
const idOf = (target) => {
    const m = /(\d+)$/.exec(String(target ?? ''));
    return m ? Number(m[1]) : null;
};
const text = (detail) => (typeof detail === 'string' ? detail : '');
const field = (detail, key) => (detail && typeof detail === 'object' && !Array.isArray(detail) ? detail[key] : undefined);

/** A policy value the way the editor shows it. */
function showValue(value) {
    if (value === null || value === undefined) return 'the default';
    if (value === true) return 'on';
    if (value === false) return 'off';
    if (Array.isArray(value)) return 'a new table';
    if (typeof value === 'object') return 'custom values';
    return String(value).slice(0, 40);
}

// --------------------------------------------------------------- verbs --
// What the ops page's Create / Change / Remove / Other buttons filter on. By the action name first: a generic row
// "POST /connection/disconnect" is a change, not a create, whatever its HTTP method says.
const SYSTEM_ACTIONS = /^(auth\.|ops\.|campaign\.(done|day_done|auto_)|channel\.ban_guard\.)/;
const NAMED_CREATE = /(^|[._])(create|provision|seed|consent|move_in)($|[._])/;
const NAMED_REMOVE = /(^|[._])(delete|remove|revoke|archived)($|[._])/;
/** POST paths that add something: a collection itself, or an import/copy/note under it. */
const POST_CREATES = /^\/[a-z_-]+$|\/(import|bulk|notes|copy|merge)$/;

export function auditVerb(action) {
    const a = String(action ?? '');
    const http = /^(POST|PUT|PATCH|DELETE) (\S+)/.exec(a);
    if (http) {
        if (http[1] === 'DELETE') return 'remove';
        if (http[1] === 'POST' && POST_CREATES.test(http[2])) return 'create';
        return 'change';
    }
    if (SYSTEM_ACTIONS.test(a)) return 'other';
    if (NAMED_REMOVE.test(a)) return 'remove';
    if (NAMED_CREATE.test(a)) return 'create';
    return 'change';
}

// ---------------------------------------------- generic tenant writes --
/** Path segment -> [singular, plural] for the generic "${method} ${path}" rows. */
const NOUNS = {
    campaigns: ['campaign', 'campaigns'], campaign: ['campaign', 'campaigns'], contacts: ['contact', 'contacts'],
    templates: ['template', 'templates'], channels: ['number', 'numbers'], connection: ['connection', 'connection'],
    conversations: ['conversation', 'conversations'], inbox: ['inbox', 'inbox'], messages: ['message', 'messages'],
    media: ['media file', 'media'], 'auto-replies': ['auto-reply', 'auto-replies'], workflows: ['workflow', 'workflows'],
    'workflow-runs': ['workflow run', 'workflow runs'], faq: ['FAQ entry', 'FAQ'], tickets: ['ticket', 'tickets'],
    segments: ['segment', 'segments'], objects: ['record', 'records'], 'webhook-endpoints': ['webhook', 'webhooks'],
    'api-keys': ['API key', 'API keys'], 'payment-reminders': ['payment reminder', 'payment reminders'],
    optouts: ['opt-out', 'opt-outs'], storage: ['file', 'files'], school: ['school record', 'school records'],
    config: ['settings', 'settings'], bulk: ['bulk sending', 'bulk sending'], recipes: ['recipe', 'recipes'],
    jobs: ['job', 'jobs'], billing: ['billing', 'billing'], events: ['event', 'events'],
};
/** Last path segment of a POST -> past-tense verb. */
const ACTIONS = {
    start: 'Started', pause: 'Paused', resume: 'Resumed', cancel: 'Cancelled', stop: 'Stopped', 'stop-all': 'Stopped all',
    'retry-failed': 'Retried the failed messages of', duplicate: 'Duplicated', preview: 'Previewed', speed: 'Changed the speed of',
    connect: 'Connected', disconnect: 'Disconnected', logout: 'Logged out', read: 'Marked as read', status: 'Changed the status of',
    assign: 'Assigned', takeover: 'Took over', handback: 'Handed back', reply: 'Replied in', tags: 'Tagged', notes: 'Added a note to',
    default: 'Made default', revert: 'Reverted', consent: 'Recorded consent for', import: 'Imported', merge: 'Merged',
    copy: 'Copied', test: 'Tested', send: 'Sent', 'spam-score': 'Checked the spam score of', 'spread-check': 'Checked the spread of',
    'reply-rules': 'Changed the reply rules of',
};

export function describeHttp(action) {
    const m = /^(POST|PUT|PATCH|DELETE) (\S+)/.exec(String(action ?? ''));
    if (!m) return null;
    const [, method, path] = m;
    const parts = path.split('/').filter(Boolean);
    const [one, many] = NOUNS[parts[0]] ?? [parts[0]?.replace(/[-_]/g, ' ') ?? 'something', parts[0]?.replace(/[-_]/g, ' ') ?? 'something'];
    const id = parts.find((p, i) => i > 0 && /^\d+$/.test(p));
    const thing = id ? `${one} #${id}` : one;
    const last = parts[parts.length - 1];
    if (parts[0] === 'connection' && ACTIONS[last]) return `${ACTIONS[last]} the WhatsApp number`;
    if (method === 'DELETE') return `Deleted ${thing}`;
    if (method === 'PUT' || method === 'PATCH') {
        if (parts.length > 1 && !/^\d+$/.test(last) && ACTIONS[last]) return `${ACTIONS[last]} ${thing}`;
        return id ? `Updated ${thing}` : `Changed ${many}`;
    }
    if (parts.length === 1) return `Created a ${one}`;
    if (ACTIONS[last]) return `${ACTIONS[last]} ${id ? thing : many}`;
    return id ? `Changed ${thing}` : `Changed ${many}`;
}

// ------------------------------------------------------------ actions --
/**
 * @typedef {{ tenant: (id) => string|null, channel: (id) => string|null, campaign: (id) => string|null,
 *   user: (id) => { name: string, email: string }|null }} Names
 * Each rule: (ctx) => string | [summary, severity]. `ctx` has detail, target, names, and helpers.
 */
const RULES = {
    // sign-in
    'auth.login': (c) => `Signed in${c.ip ? ` from ${c.ip}` : ''}`,
    'auth.login_failed': (c) => [`Login failed for ${field(c.detail, 'email') || 'an unknown email'}${c.ip ? ` from ${c.ip}` : ''}`, 'warn'],
    'auth.login_refused': (c) => [`Sign-in refused: the business is ${field(c.detail, 'status') ?? 'not active'}${c.ip ? ` (from ${c.ip})` : ''}`, 'warn'],
    'auth.logout': () => 'Signed out',

    // a business's own numbers
    'channel.create': (c) => `Added number ${quote(text(c.detail) || c.number())}`,
    'channel.update': (c) => `Updated number ${c.number()}${text(c.detail) ? ` (now ${text(c.detail)})` : ''}`,
    'channel.default': (c) => `Made ${c.number()} the default number`,
    'channel.start': (c) => `Answered the new-number questions for ${c.number()} (${text(c.detail)})`,
    'channel.start_skip': (c) => [`Skipped the new-number questions for ${c.number()}: ${text(c.detail)}`, 'warn'],
    'channel.delete': (c) => [`Removed number ${quote(text(c.detail) || c.number())}`, 'warn'],
    'channel.ban_guard.pause': (c) => [`Ban guard paused ${c.number()}${c.at()}: ${text(c.detail).replace(/^Auto-paused: /, '')}`, 'danger'],

    // the platform admin on a number
    'channel.admin.pause': (c) => [`Super admin paused ${c.number()}${c.at()}${text(c.detail) ? `: ${text(c.detail)}` : ''}`, 'warn'],
    'channel.admin.resume': (c) => `Super admin resumed ${c.number()}${c.at()}`,
    'channel.admin.disconnect': (c) => [`Super admin disconnected ${c.number()}${c.at()}`, 'warn'],
    'channel.admin.level_pin': (c) => `Super admin pinned the sending level of ${c.number()}${c.at()} (${text(c.detail)})`,
    'channel.admin.level_unpin': (c) => `Super admin removed the level pin on ${c.number()}${c.at()}`,
    'channel.admin.brakes_off': (c) => [`Super admin turned the brakes off on ${c.number()}${c.at()} (${text(c.detail).replace(/^brakes off /, '')})`, 'warn'],
    'channel.admin.brakes_on': (c) => `Super admin turned the brakes back on for ${c.number()}${c.at()}`,
    'channel.admin.end_link_wait': (c) => `Super admin ended the after-link wait on ${c.number()}${c.at()}`,
    'channel.admin.move': (c) => {
        const to = /->\s*(\d+)/.exec(text(c.detail))?.[1];
        return `Super admin moved ${c.number()} to ${to ? c.biz(Number(to)) : 'another business'}`;
    },
    'channel.admin.move_in': (c) => {
        const from = /tenant (\d+)/.exec(text(c.detail))?.[1];
        return `${c.number()} moved in${from ? ` from ${c.biz(Number(from))}` : ''}`;
    },

    // campaigns: the business's own (campaign.*), the platform admin's (campaign.admin_*), and the sender itself
    'campaign.done': (c) => {
        const sent = Number(field(c.detail, 'sent') ?? 0);
        const failed = Number(field(c.detail, 'failed') ?? 0);
        const total = Number(field(c.detail, 'total') ?? 0);
        const rate = sent + failed ? failed / (sent + failed) : 0;
        return [`Campaign ${c.campaign()} finished: ${plural(sent, 'sent', 'sent')}, ${plural(failed, 'failed', 'failed')}${total > sent + failed ? ` of ${total.toLocaleString('en-US')}` : ''}`,
            rate >= 0.2 ? 'danger' : rate >= 0.05 ? 'warn' : 'info'];
    },
    'campaign.day_done': (c) => `Campaign ${c.campaign()} sent today's batch: ${plural(field(c.detail, 'sent') ?? 0, 'sent', 'sent')}, ${plural(field(c.detail, 'failed') ?? 0, 'failed', 'failed')}`,
    'campaign.create': (c) => `Created campaign ${c.campaign()}`,
    'campaign.update': (c) => `Edited campaign ${c.campaign()}`,
    'campaign.create': (c) => `Created campaign ${c.campaign()}${field(c.detail, 'status') === 'scheduled' ? ' (scheduled)' : ''}`,
    'campaign.start': (c) => `Started campaign ${c.campaign()}${field(c.detail, 'audience') ? ` to ${plural(field(c.detail, 'audience'), 'contact')}` : ''}`,
    'campaign.pause': (c) => `Paused campaign ${c.campaign()}`,
    'campaign.resume': (c) => `Resumed campaign ${c.campaign()}`,
    'campaign.cancel': (c) => [`Cancelled campaign ${c.campaign()}`, 'warn'],
    'campaign.retry': (c) => `Retried the failed messages of campaign ${c.campaign()}`,
    'campaign.delete': (c) => [`Deleted campaign ${c.campaign()}`, 'warn'],
    'campaign.auto_paused': (c) => [`Campaign ${c.campaign()} was paused automatically${c.reason()}`, 'warn'],
    'campaign.auto_cancelled': (c) => [`Campaign ${c.campaign()} was cancelled automatically${c.reason()}`, 'danger'],
    'campaign.admin_pause': (c) => [`Super admin paused campaign ${c.campaign()}${c.at()}`, 'warn'],
    'campaign.admin_resume': (c) => `Super admin resumed campaign ${c.campaign()}${c.at()}`,
    'campaign.admin_cancel': (c) => [`Super admin cancelled campaign ${c.campaign()}${c.at()}`, 'danger'],
    'bulk.stop_all': (c) => [`Super admin stopped all bulk sending on the platform: ${c.dropped()}`, 'danger'],
    'bulk.stop': (c) => [`Super admin stopped bulk sending for ${c.biz()}: ${c.dropped()}`, 'danger'],

    // plans and businesses
    'plan.save': (c) => `Saved plan ${quote(text(c.detail) || c.target)}`,
    // DELETE on a built-in plan resets it to its defaults; only a custom plan is really removed.
    'plan.remove': (c) => (Object.hasOwn(DEFAULT_PLANS, String(c.target))
        ? [`Reset plan ${quote(c.target)} to its defaults`, 'warn']
        : [`Removed plan ${quote(c.target)}`, 'warn']),
    'tenant.create': (c) => {
        const on = / on (\S+)$/.exec(text(c.detail))?.[1];
        return `Created business ${c.biz()}${on ? ` on plan ${on}` : ''}`;
    },
    'tenant.active': (c) => `Updated business ${c.biz()}`,
    'tenant.suspended': (c) => [`Suspended business ${c.biz()}`, 'warn'],
    'tenant.archived': (c) => [`Archived business ${c.biz()}`, 'danger'],
    'tenant.delete': (c) => [`Deleted business ${c.biz()}`, 'danger'],
    'tenant.subscription': (c) => `Put ${c.biz()} on plan ${field(c.detail, 'planKey') ?? '?'} (${field(c.detail, 'state') ?? 'active'})`,
    'tenant.subscription.cancel': (c) => [`Cancelled the subscription of ${c.biz()}${field(c.detail, 'immediate') ? ' immediately' : ' at the end of the period'}`, 'warn'],
    'tenant.school_provision': (c) => `Set up the school pack for ${c.biz()}: ${plural(field(c.detail, 'templates') ?? 0, 'template')}, ${plural(field(c.detail, 'workflows') ?? 0, 'workflow')}`,
    'tenant.seed': (c) => `Loaded demo data into ${c.biz()}`,
    'tenant.safety': (c) => `Changed the sending safety of ${c.biz()}`,
    'tenant.limits': (c) => `Changed the plan limits of ${c.biz()}`,
    'tenant.custom_safety.revoke': (c) => [`Revoked the custom safety of ${c.biz()}`, 'warn'],
    'tenant.sessions.revoke': (c) => [`Signed everyone out of ${c.biz()} (${plural(field(c.detail, 'count') ?? 0, 'session')})`, 'warn'],
    'tenant.api_keys.revoke': (c) => [`Revoked every API key of ${c.biz()} (${plural(field(c.detail, 'count') ?? 0, 'key')})`, 'warn'],
    'number_collection.save': (c) => `Saved ${plural(field(c.detail, 'count') ?? 0, 'number')} to the number collection of ${c.biz()}`,

    // users
    'user.create': (c) => `Added user ${text(c.detail) || c.user()}`,
    'user.enable': (c) => `Enabled user ${text(c.detail) || c.user()}`,
    'user.disable': (c) => [`Disabled user ${text(c.detail) || c.user()}`, 'warn'],
    'user.password_reset': (c) => [`Reset the password of ${text(c.detail) || c.user()}`, 'warn'],

    // a business's own safety choices
    'safety.consent': (c) => [`${field(c.detail, 'fullName') || 'Someone'} accepted the custom safety terms (v${field(c.detail, 'version') ?? '?'})`, 'warn'],
    'safety.custom': () => ['Changed their own sending safety limits', 'warn'],
    'safety.custom.reset': () => 'Reset their sending safety to the platform defaults',
    'safety.exit': (c) => [`${field(c.detail, 'fullName') || 'Someone'} turned the platform safety off (v${field(c.detail, 'version') ?? '?'})`, 'danger'],
    'safety.rejoin': () => 'Turned the platform safety back on',

    // templates
    'template.approve': (c) => `Approved template ${c.targetName()}`,
    'template.reject': (c) => [`Rejected template ${c.targetName()}${text(c.detail) ? `: ${text(c.detail)}` : ''}`, 'warn'],
    'template_library.create': (c) => `Added ${quote(text(c.detail) || c.target)} to the starter template library`,
    'template_library.update': (c) => `Edited starter template ${quote(text(c.detail) || c.target)}`,
    'template_library.delete': (c) => [`Removed starter template ${quote(text(c.detail) || c.target)}`, 'warn'],

    'policy.change': (c) => describePolicy(c),
    'ops.alert': (c) => describeAlert(c),
};

const ALERT_SEVERITY = { ban: 'danger', tenant_bans: 'danger', logout: 'danger', backup_failed: 'danger', reencrypt_failed: 'danger', encryption_key: 'danger' };
const ALERT_TITLE = {
    ban: 'WhatsApp banned', logout: 'Unexpected logout of', tenant_bans: 'Second ban in 30 days at', dead_man: 'Nothing sent for hours on',
    unstable: 'Unstable connection brake on', delivery: 'Delivery brake on', stuck: 'Stuck-messages brake on',
    backup_failed: 'Daily backup failed', reencrypt_failed: 'Re-encryption failed', encryption_key: 'Encryption key problem',
    held_back: 'Alerts held back',
};

function describeAlert(c) {
    const kind = String(field(c.detail, 'kind') ?? c.target.split(':')[0] ?? 'alert');
    const shadow = Boolean(field(c.detail, 'shadow'));
    const said = String(field(c.detail, 'text') ?? '').replace(/^Shadow \(not applied\): /, '');
    const channelId = field(c.detail, 'channelId') ?? idOf(/channel-(\d+)/.exec(c.target)?.[1]);
    const where = channelId != null ? ` ${c.number(channelId)}${c.at()}` : c.tenantId != null ? ` ${c.biz()}` : '';
    const title = ALERT_TITLE[kind] ?? `Alert (${kind.replace(/_/g, ' ')})`;
    const head = /(on|of|at)$/.test(title) || kind === 'ban' ? `${title}${where}` : `${title}${where ? ` —${where}` : ''}`;
    const summary = `${shadow ? 'Shadow (not applied): ' : ''}${head}${said ? `: ${said}` : ''}`;
    const held = field(c.detail, 'outcome') === 'held_back' ? ' (not re-sent: same alert within the hour)' : '';
    return [summary + held, shadow ? 'info' : ALERT_SEVERITY[kind] ?? 'warn'];
}

function describePolicy(c) {
    const scope = String(c.target ?? '');
    const where = scope === 'global' ? 'the whole platform'
        : scope.startsWith('plan:') ? `plan ${scope.slice(5)}`
            : scope.startsWith('tenant:') ? c.biz(Number(scope.slice(7))) : scope || 'the platform';
    const detail = c.detail;
    // Old rows: a comma list of keys, no values.
    if (typeof detail === 'string' || Array.isArray(detail)) {
        const keys = String(detail).split(/,\s*/).filter(Boolean);
        if (keys.length === 1 && keys[0] === KILL_SWITCH) return [`Changed the bulk kill switch for ${where}`, 'warn'];
        return keys.length === 1 ? `Changed rule "${FIELD_LABEL.get(keys[0]) ?? keys[0]}" for ${where}`
            : `Changed ${plural(keys.length, 'platform rule')} for ${where}`;
    }
    const entries = Object.entries(detail ?? {});
    const kill = detail?.[KILL_SWITCH];
    if (kill && entries.length === 1) {
        return kill.to === true ? [`Turned the bulk kill switch ON for ${where}: no bulk sending`, 'danger']
            : [`Turned the bulk kill switch off for ${where}`, 'warn'];
    }
    if (entries.length === 1) {
        const [key, change] = entries[0];
        const label = FIELD_LABEL.get(key) ?? key;
        if (change?.to === null || change?.to === undefined) return `Reset rule "${label}" to the default for ${where}`;
        const from = change?.from === null || change?.from === undefined ? '' : ` from ${showValue(change.from)}`;
        return `Set rule "${label}"${from} to ${showValue(change.to)} for ${where}`;
    }
    const resets = entries.filter(([, v]) => v?.to === null || v?.to === undefined).length;
    const labels = entries.slice(0, 3).map(([k]) => FIELD_LABEL.get(k) ?? k).join(', ');
    const more = entries.length > 3 ? ` and ${entries.length - 3} more` : '';
    return [`Changed ${plural(entries.length, 'platform rule')} for ${where}${resets ? ` (${resets} reset)` : ''}: ${labels}${more}`,
        kill?.to === true ? 'danger' : 'info'];
}

const CATEGORIES = [
    [/^auth\./, 'sign-in'], [/^(channel|ops\.alert)/, 'numbers'], [/^(campaign|bulk)/, 'campaigns'],
    [/^(plan|tenant\.subscription)/, 'billing'], [/^(tenant|number_collection)/, 'business'], [/^user\./, 'users'],
    [/^(policy|safety)/, 'policy'], [/^template/, 'templates'],
];
const HTTP_CATEGORY = { campaigns: 'campaigns', campaign: 'campaigns', bulk: 'campaigns', channels: 'numbers', connection: 'numbers', templates: 'templates', contacts: 'contacts', config: 'business' };

function categoryOf(action) {
    const http = /^(POST|PUT|PATCH|DELETE) \/([^/\s]+)/.exec(action);
    if (http) return HTTP_CATEGORY[http[2]] ?? 'activity';
    if (action === 'ops.alert') return 'alerts';
    return CATEGORIES.find(([re]) => re.test(action))?.[1] ?? 'other';
}

/**
 * @param {{ action: string, target?: string|number, detail?: string|object, tenantId?: number|null, ip?: string|null }} entry
 * @param {Partial<Names>} [names]
 * @returns {{ summary: string, severity: 'info'|'warn'|'danger', category: string, verb: string }}
 */
export function describeAudit(entry, names = {}) {
    const action = String(entry?.action ?? '');
    const detail = parseDetail(entry?.detail);
    const target = String(entry?.target ?? '');
    const tenantId = entry?.tenantId ?? null;
    const lookup = (fn, id) => (id == null || !fn ? null : fn(id) ?? null);
    const c = {
        detail, target, tenantId,
        ip: entry?.ip || field(detail, 'ip') || null,
        biz: (id = tenantId ?? idOf(target)) => lookup(names.tenant, id) ?? (id == null ? 'a business' : `business #${id}`),
        /** " (Acme)" after a number or campaign the platform admin acted on. */
        at: () => (tenantId == null ? '' : ` (${lookup(names.tenant, tenantId) ?? `business #${tenantId}`})`),
        number: (id = idOf(target)) => {
            const name = lookup(names.channel, id);
            return name ? `number ${quote(name)}` : id == null ? 'a number' : `number #${id}`;
        },
        campaign: () => {
            const name = field(detail, 'name') ?? lookup(names.campaign, idOf(target));
            return name ? quote(name) : `#${idOf(target) ?? target}`;
        },
        user: () => {
            const u = lookup(names.user, idOf(target));
            return u ? (u.name ? `${u.name} (${u.email})` : u.email) : `#${target}`;
        },
        targetName: () => (text(detail) ? quote(text(detail)) : target),
        reason: () => (field(detail, 'reason') ? `: ${field(detail, 'reason')}` : ''),
        dropped: () => `${plural(field(detail, 'cancelled') ?? 0, 'campaign')} cancelled, ${plural(field(detail, 'dropped') ?? 0, 'message')} dropped`,
    };
    let out;
    try {
        const rule = RULES[action] ?? (action.startsWith('tenant.') ? (x) => `Changed business ${x.biz()} (${action.slice(7).replace(/[._]/g, ' ')})` : null);
        out = rule ? rule(c) : describeHttp(action);
    } catch {
        out = null; // a malformed old row reads as its action code, never as an error page
    }
    if (!out) out = action.replace(/[._]/g, ' ').replace(/^./, (ch) => ch.toUpperCase()) || 'Unknown action';
    const [summary, severity = 'info'] = Array.isArray(out) ? out : [out];
    return { summary, severity, category: categoryOf(action), verb: auditVerb(action) };
}
