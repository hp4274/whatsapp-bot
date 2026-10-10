/**
 * The template library: reusable message bodies with declared variables.
 *
 * The variable language is not new. `personalize()` in protocol.js already
 * substitutes `{name}` and `{name|fallback}`, and the campaign engine has sent
 * millions of messages through it. What was missing is a place to keep a body,
 * say which variables it expects, and know which edit produced which wording -
 * so this module declares, validates and versions. It does not interpolate.
 *
 * Versions are append-only. An edit that changes the wording writes a new row
 * and bumps `current_version`; a rename or an approval flip does not, because
 * neither changes what a recipient reads. A revert writes the old body forward
 * as a new version rather than deleting what came after it: a message that
 * went out at version 3 must stay readable at version 3 forever.
 */

import { TRANSPORT_CLOUD_API, QR_TRANSPORTS } from '../config.js';
import { InteractiveError, normalizeInteractive } from '../messaging/interactive.js';
import { personalize, utcNow } from '../protocol.js';
import { spamScore } from './policy.js';

export const TEMPLATE_TYPES = Object.freeze([
    'text', 'media', 'provider_template', 'interactive', 'notification',
]);

/** Only meaningful for `provider_template`: the others need nobody's blessing. */
export const APPROVAL_STATUSES = Object.freeze(['draft', 'pending', 'approved', 'rejected']);

/**
 * Meta's template categories. New templates default to 'marketing': it is
 * Meta's catch-all, and Meta re-files a mislabelled "utility" template as
 * marketing anyway - defaulting the other way invites a rejection.
 */
export const TEMPLATE_CATEGORIES = Object.freeze(['marketing', 'utility', 'authentication']);

/** Matches what `personalize` substitutes - `{key}` and `{key|fallback}`. */
const PLACEHOLDER = /\{(\w+)(?:\|[^{}]*)?\}/g;
const BRACED = /\{([^{}]*)\}/g;

export class TemplateError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export class TemplateStore {
    /** @param {import('../db.js').Database} database a tenant-scoped handle */
    constructor(database) {
        this.db = database.db;
        this.tenantId = database.tenantId;
    }

    // ------------------------------------------------------------- writes --
    create({
        name, templateType = 'text', body = '', variables, channelId = null,
        providerTemplateName = '', approvalStatus = 'draft',
        category = 'marketing', sampleValues, headerMediaId, interactive,
        language, paramMapping,
    }) {
        const clean = String(name ?? '').trim();
        if (!clean) throw new TemplateError('a template needs a name');
        if (!TEMPLATE_TYPES.includes(templateType)) {
            throw new TemplateError(`template type must be one of ${TEMPLATE_TYPES.join(', ')}`);
        }
        if (!APPROVAL_STATUSES.includes(approvalStatus)) {
            throw new TemplateError(`approval status must be one of ${APPROVAL_STATUSES.join(', ')}`);
        }
        const extras = cleanExtras({ category, sampleValues, headerMediaId, interactive });
        const meta = cleanMeta({ language, paramMapping });
        if (this.getByName(clean)) throw new TemplateError(`a template named ${clean} already exists`, 409);

        // Nobody wants to list variables by hand when the body already says
        // which ones it uses. Declaring explicitly stays possible, and is what
        // makes `validate` able to catch a typo'd placeholder.
        const declared = variables === undefined ? usedIn(body) : cleanList(variables);
        const now = utcNow();
        const info = this.db.prepare(
            `INSERT INTO templates (tenant_id, name, template_type, body, variables, channel_id,
                                    provider_template_name, approval_status, current_version,
                                    category, sample_values, header_media_id, interactive,
                                    created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
            .run(
                this.tenantId, clean, templateType, String(body ?? ''), JSON.stringify(declared),
                channelId == null ? null : Number(channelId),
                String(providerTemplateName ?? '').trim(), approvalStatus,
                extras.category, extras.sampleValues, extras.headerMediaId, extras.interactive, now, now,
            );
        const id = Number(info.lastInsertRowid);
        this.#writeVersion(id, 1, String(body ?? ''), declared, now);
        this.#writeMeta(id, meta);
        return this.get(id);
    }

    /**
     * Patch a template. A change to `body` or `variables` writes a new
     * immutable version and bumps `current_version`; anything else - a rename,
     * a channel pin, an approval decision - leaves history alone.
     */
    update(id, patch = {}) {
        const template = this.#require(id);
        if (patch.templateType !== undefined && !TEMPLATE_TYPES.includes(patch.templateType)) {
            throw new TemplateError(`template type must be one of ${TEMPLATE_TYPES.join(', ')}`);
        }
        if (patch.approvalStatus !== undefined && !APPROVAL_STATUSES.includes(patch.approvalStatus)) {
            throw new TemplateError(`approval status must be one of ${APPROVAL_STATUSES.join(', ')}`);
        }

        const meta = cleanMeta(patch);
        const extras = cleanExtras({
            category: patch.category ?? template.category,
            sampleValues: patch.sampleValues === undefined ? template.sampleValues : patch.sampleValues,
            headerMediaId: patch.headerMediaId === undefined ? template.headerMediaId : patch.headerMediaId,
            interactive: patch.interactive === undefined ? template.interactive : patch.interactive,
        });

        let name = template.name;
        if (patch.name !== undefined) {
            name = String(patch.name).trim();
            if (!name) throw new TemplateError('a template needs a name');
            const clash = this.getByName(name);
            if (clash && clash.id !== template.id) {
                throw new TemplateError(`a template named ${name} already exists`, 409);
            }
        }

        const body = patch.body === undefined ? template.body : String(patch.body);
        // Declarations that were in step with the old body stay in step with
        // the new one. Hand-curated declarations are left alone, so a caller
        // that deliberately declared an unused variable keeps it.
        const variables = patch.variables !== undefined
            ? cleanList(patch.variables)
            : (sameList(template.variables, usedIn(template.body)) ? usedIn(body) : template.variables);
        const reworded = body !== template.body || !sameList(variables, template.variables);
        const version = reworded ? template.currentVersion + 1 : template.currentVersion;
        const now = utcNow();

        this.db.prepare(
            `UPDATE templates SET name = ?, template_type = ?, body = ?, variables = ?,
                                  channel_id = ?, provider_template_name = ?, approval_status = ?,
                                  current_version = ?, category = ?, sample_values = ?,
                                  header_media_id = ?, interactive = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ?`)
            .run(
                name,
                patch.templateType ?? template.templateType,
                body, JSON.stringify(variables),
                patch.channelId === undefined
                    ? template.channelId
                    : (patch.channelId == null ? null : Number(patch.channelId)),
                patch.providerTemplateName === undefined
                    ? template.providerTemplateName
                    : String(patch.providerTemplateName).trim(),
                patch.approvalStatus ?? template.approvalStatus,
                version, extras.category, extras.sampleValues, extras.headerMediaId, extras.interactive,
                now, template.id, this.tenantId,
            );
        if (reworded) this.#writeVersion(template.id, version, body, variables, now);
        this.#writeMeta(template.id, meta);
        return this.get(template.id);
    }

    /** Roll the wording back by writing it forward. History is never rewritten. */
    revert(id, version) {
        const template = this.#require(id);
        const old = this.getVersion(template.id, version);
        if (!old) throw new TemplateError(`template version ${version} not found`, 404);
        if (old.version === template.currentVersion) return template;
        return this.update(template.id, { body: old.body, variables: old.variables });
    }

    /** Platform review verdict (see templates/policy.js). Never touches Meta's approval_status. */
    setReview(id, status, note = '') {
        const template = this.#require(id);
        this.db.prepare('UPDATE templates SET review_status = ?, review_note = ?, reviewed_at = ? WHERE id = ? AND tenant_id = ?')
            .run(status, String(note ?? '').trim().slice(0, 500), status === 'pending' ? null : utcNow(), template.id, this.tenantId);
        return this.get(template.id);
    }

    /**
     * Why this template may not be sent right now, or null. `sendGate` is set
     * by the channel runtime (policy + live channel); every send path that
     * resolves a stored template asks here.
     */
    sendBlock(idOrTemplate) {
        const template = typeof idOrTemplate === 'object' ? idOrTemplate : this.#require(idOrTemplate);
        return this.sendGate?.(template) ?? null;
    }

    remove(id) {
        const template = this.#require(id);
        this.db.prepare('DELETE FROM template_versions WHERE template_id = ?').run(template.id);
        this.db.prepare('DELETE FROM templates WHERE id = ? AND tenant_id = ?')
            .run(template.id, this.tenantId);
        return template;
    }

    /**
     * Count a send. A counter and a timestamp on the row answer "which
     * templates does this business actually use" without an events table that
     * would need its own retention policy.
     */
    recordUse(id) {
        const template = this.#require(id);
        this.db.prepare(
            'UPDATE templates SET use_count = use_count + 1, last_used_at = ? WHERE id = ? AND tenant_id = ?')
            .run(utcNow(), template.id, this.tenantId);
        return this.get(template.id);
    }

    // -------------------------------------------------------------- reads --
    get(id) {
        const row = this.db.prepare('SELECT * FROM templates WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId);
        return row ? toTemplate(row) : null;
    }

    getByName(name) {
        const row = this.db.prepare('SELECT * FROM templates WHERE tenant_id = ? AND name = ?')
            .get(this.tenantId, String(name).trim());
        return row ? toTemplate(row) : null;
    }

    /** `channelId` matches templates pinned to that channel plus the unpinned. */
    list({ type, channelId, category } = {}) {
        const clauses = ['tenant_id = ?'];
        const args = [this.tenantId];
        if (type) {
            clauses.push('template_type = ?');
            args.push(String(type));
        }
        if (category) {
            clauses.push('category = ?');
            args.push(String(category));
        }
        if (channelId != null) {
            clauses.push('(channel_id IS NULL OR channel_id = ?)');
            args.push(Number(channelId));
        }
        return this.db.prepare(`SELECT * FROM templates WHERE ${clauses.join(' AND ')} ORDER BY id`)
            .all(...args).map(toTemplate);
    }

    versions(id) {
        const template = this.#require(id);
        return this.db.prepare(
            'SELECT * FROM template_versions WHERE template_id = ? ORDER BY version DESC')
            .all(template.id).map(toVersion);
    }

    getVersion(id, version) {
        const template = this.#require(id);
        const row = this.db.prepare(
            'SELECT * FROM template_versions WHERE template_id = ? AND version = ?')
            .get(template.id, Number(version));
        return row ? toVersion(row) : null;
    }

    // ------------------------------------------------------------ render --
    /**
     * Fill in a template. `missing` lists the declared variables the context
     * did not supply - exactly the ones `personalize` will have left as literal
     * `{braces}` in the body, so a caller can refuse to send rather than ship a
     * message with a placeholder in it.
     */
    render(id, context = {}, { version } = {}) {
        const template = this.#require(id);
        const source = version === undefined ? template : this.getVersion(template.id, version);
        if (!source) throw new TemplateError(`template version ${version} not found`, 404);
        const declared = source.variables.length ? source.variables : usedIn(source.body);
        return {
            body: personalize(source.body, context),
            missing: declared.filter((key) => context[key] === undefined || context[key] === null),
        };
    }

    /**
     * Render for a UI. Variables the sample does not cover show up as `[name]`
     * so the operator sees the shape of the message instead of a raw brace.
     */
    preview(id, sampleContext = {}) {
        const template = this.#require(id);
        const declared = template.variables.length ? template.variables : usedIn(template.body);
        const filled = { ...sampleContext };
        for (const key of declared) {
            if (filled[key] === undefined || filled[key] === null) filled[key] = `[${key}]`;
        }
        return { body: personalize(template.body, filled), missing: [] };
    }

    // The checks themselves need no database, so they live as free functions
    // below and are reachable here for callers that already hold a store.
    validate(draft) {
        return validate(draft);
    }

    compatibility(template, channel) {
        return compatibility(template, channel);
    }

    // ------------------------------------------------------------ private --
    #require(id) {
        const template = this.get(id);
        if (!template) throw new TemplateError('template not found', 404);
        return template;
    }

    /** Meta send settings (see cleanMeta). They never change wording, so no version. */
    #writeMeta(id, { language, paramMapping }) {
        if (language !== undefined) {
            this.db.prepare('UPDATE templates SET language = ? WHERE id = ? AND tenant_id = ?')
                .run(language, id, this.tenantId);
        }
        if (paramMapping !== undefined) {
            this.db.prepare('UPDATE templates SET param_mapping = ? WHERE id = ? AND tenant_id = ?')
                .run(paramMapping, id, this.tenantId);
        }
    }

    #writeVersion(templateId, version, body, variables, now) {
        this.db.prepare(
            `INSERT INTO template_versions (template_id, version, body, variables, created_at)
             VALUES (?, ?, ?, ?, ?)`)
            .run(templateId, version, body, JSON.stringify(variables), now);
    }
}

/**
 * Problems with a body and its declared variables, as plain sentences a UI can
 * show. Returns an empty array when there is nothing to say; a non-empty array
 * is advice, not a refusal - a half-written draft is allowed to be saved.
 */
export function validate({ body = '', variables } = {}) {
    const text = String(body ?? '');
    const problems = [];

    const opens = (text.match(/\{/g) ?? []).length;
    const closes = (text.match(/\}/g) ?? []).length;
    if (opens !== closes) problems.push('unbalanced braces: every { needs a matching }');

    for (const [, inner] of text.matchAll(BRACED)) {
        if (!/^\w+(\|[^{}]*)?$/.test(inner)) problems.push(`malformed placeholder: {${inner}}`);
    }

    const used = usedIn(text);
    const declared = variables === undefined ? used : cleanList(variables);
    for (const key of used) {
        if (!declared.includes(key)) problems.push(`{${key}} is used in the body but not declared`);
    }
    for (const key of declared) {
        if (!used.includes(key)) problems.push(`${key} is declared but never used in the body`);
    }
    return problems;
}

/**
 * Can this template go out on this channel? The rules are the providers', not
 * ours: Meta's own template machinery only exists on the Cloud API and only
 * accepts a template Meta has approved, and interactive messages are a Cloud
 * API payload shape that a browser session cannot produce.
 */
export function compatibility(template, channel) {
    const problems = [];
    if (!template) return ['template not found'];
    if (!channel) return ['channel not found'];

    const transport = channel.provider ?? channel.settings?.transport;

    if (template.channelId != null && Number(template.channelId) !== Number(channel.id)) {
        problems.push(`template is pinned to channel ${template.channelId}`);
    }

    if (template.templateType === 'provider_template') {
        if (QR_TRANSPORTS.includes(transport)) {
            problems.push('a WhatsApp Web channel cannot send provider templates');
        } else if (transport !== TRANSPORT_CLOUD_API) {
            problems.push('provider templates need a Cloud API channel');
        }
        if (template.approvalStatus !== 'approved') {
            problems.push(`provider template is ${template.approvalStatus}, not approved`);
        }
        if (!template.providerTemplateName) {
            problems.push('provider template has no provider template name');
        }
    }

    if (template.templateType === 'interactive' && transport !== TRANSPORT_CLOUD_API) {
        problems.push('interactive messages need a Cloud API channel');
    }

    return problems;
}

/** The variables a body actually references. */
export function usedIn(body) {
    return [...new Set([...String(body ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

const cleanList = (list) => (Array.isArray(list)
    ? [...new Set(list.map((v) => String(v).trim()).filter(Boolean))]
    : []);

/** Validates the Meta-facing extras and returns them as column values. */
function cleanExtras({ category, sampleValues, headerMediaId, interactive }) {
    if (!TEMPLATE_CATEGORIES.includes(category)) {
        throw new TemplateError(`category must be one of ${TEMPLATE_CATEGORIES.join(', ')}`);
    }
    if (sampleValues != null && (typeof sampleValues !== 'object' || Array.isArray(sampleValues))) {
        throw new TemplateError('sample values must be an object of variable to example');
    }
    const samples = Object.fromEntries(Object.entries(sampleValues ?? {})
        .filter(([key, value]) => /^\w+$/.test(key) && value != null && String(value) !== '')
        .slice(0, 50)
        .map(([key, value]) => [key, String(value).slice(0, 200)]));
    let normalized;
    try {
        normalized = normalizeInteractive(interactive);
    } catch (err) {
        if (err instanceof InteractiveError) throw new TemplateError(err.message);
        throw err;
    }
    return {
        category,
        sampleValues: JSON.stringify(samples),
        headerMediaId: String(headerMediaId ?? '').trim().slice(0, 100) || null,
        interactive: normalized ? JSON.stringify(normalized) : null,
    };
}

/**
 * Meta send settings: language code and the {{n}} -> variable mapping
 * (messaging/templateSend.js). Absent fields stay undefined (= unchanged).
 */
function cleanMeta({ language, paramMapping } = {}) {
    const meta = {};
    if (language !== undefined) {
        meta.language = String(language ?? '').trim();
        if (meta.language && !/^[a-z]{2,3}(_[A-Za-z]{2,4})?$/.test(meta.language)) {
            throw new TemplateError('language must be a Meta language code such as en, en_US or hi');
        }
    }
    if (paramMapping !== undefined) {
        const mapping = paramMapping ?? {};
        if (typeof mapping !== 'object' || Array.isArray(mapping)
            || (mapping.body !== undefined && !Array.isArray(mapping.body))
            || (mapping.buttons !== undefined && !Array.isArray(mapping.buttons))) {
            throw new TemplateError('paramMapping must be { body: [...], header?, buttons?: [...] }');
        }
        meta.paramMapping = JSON.stringify(mapping);
    }
    return meta;
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function toTemplate(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        name: row.name,
        templateType: row.template_type,
        body: row.body ?? '',
        variables: parse(row.variables, []),
        channelId: row.channel_id ?? null,
        providerTemplateName: row.provider_template_name ?? '',
        approvalStatus: row.approval_status,
        currentVersion: row.current_version,
        useCount: row.use_count ?? 0,
        lastUsedAt: row.last_used_at ?? null,
        category: row.category ?? 'marketing',
        sampleValues: parse(row.sample_values, {}),
        headerMediaId: row.header_media_id ?? null,
        interactive: parse(row.interactive, null),
        language: row.language ?? '',
        paramMapping: parse(row.param_mapping, {}),
        reviewStatus: row.review_status ?? '',
        reviewNote: row.review_note ?? '',
        reviewedAt: row.reviewed_at ?? null,
        spam: spamScore({ body: row.body, interactive: parse(row.interactive, null) }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toVersion(row) {
    return {
        id: row.id,
        templateId: row.template_id,
        version: row.version,
        body: row.body ?? '',
        variables: parse(row.variables, []),
        createdAt: row.created_at,
    };
}

function parse(value, fallback) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}
