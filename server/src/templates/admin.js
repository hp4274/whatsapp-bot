/**
 * Super-admin template endpoints, mounted on the /api/admin router:
 * the cross-tenant review queue, the starter library, and Meta status per tenant.
 */

import { TemplateError, TemplateStore } from './store.js';
import { listLibrary, removeLibraryEntry, saveLibraryEntry } from './library.js';
import { needsReview } from './policy.js';

export function registerTemplateAdmin(admin, { db, tenancy, policy, audit }) {
    const fail = (res, err) => {
        if (err instanceof TemplateError) return res.status(err.status).json({ errors: [err.message] });
        throw err;
    };

    // Unreviewed ('' = saved before the queue was switched on) and pending, for tenants whose policy reviews.
    admin.get('/template-review', (req, res) => {
        const queue = [];
        for (const tenant of tenancy.listTenants()) {
            const values = policy.resolve(tenant.id).values;
            if (values['templates.requireApproval'] === 'off') continue;
            for (const template of new TemplateStore(db.forTenant(tenant.id)).list()) {
                if (needsReview(values, template) && ['', 'pending'].includes(template.reviewStatus)) {
                    queue.push({ ...template, tenantName: tenant.name, mode: values['templates.requireApproval'] });
                }
            }
        }
        res.json({ templates: queue });
    });

    admin.post('/template-review/:id/:templateId/:verdict', (req, res) => {
        const { verdict } = req.params;
        if (!['approve', 'reject'].includes(verdict)) return res.status(404).json({ errors: ['unknown review action'] });
        if (!tenancy.getTenant(Number(req.params.id))) return res.status(404).json({ errors: ['tenant not found'] });
        const note = String(req.body?.note ?? '').trim();
        if (verdict === 'reject' && !note) return res.status(400).json({ errors: ['Say why the template is rejected so the business can fix it.'] });
        try {
            const template = new TemplateStore(db.forTenant(Number(req.params.id)))
                .setReview(req.params.templateId, verdict === 'approve' ? 'approved' : 'rejected', note);
            audit(req, `template.${verdict}`, `template:${template.id}`, note || template.name);
            return res.json({ template });
        } catch (err) {
            return fail(res, err);
        }
    });

    admin.get('/template-library', (req, res) => res.json({ starters: listLibrary(db.db) }));

    admin.post('/template-library', (req, res) => {
        try {
            const entry = saveLibraryEntry(db.db, null, req.body ?? {});
            audit(req, 'template_library.create', `starter:${entry.id}`, entry.name);
            return res.status(201).json({ starter: entry });
        } catch (err) {
            return fail(res, err);
        }
    });

    admin.put('/template-library/:entryId', (req, res) => {
        try {
            const entry = saveLibraryEntry(db.db, req.params.entryId, req.body ?? {});
            audit(req, 'template_library.update', `starter:${entry.id}`, entry.name);
            return res.json({ starter: entry });
        } catch (err) {
            return fail(res, err);
        }
    });

    admin.delete('/template-library/:entryId', (req, res) => {
        try {
            const entry = removeLibraryEntry(db.db, req.params.entryId);
            audit(req, 'template_library.delete', `starter:${entry.id}`, entry.name);
            return res.json({ deleted: entry.id });
        } catch (err) {
            return fail(res, err);
        }
    });

    /**
     * Meta's verdict on each tenant's Cloud API templates, as stored in
     * approval_status. `lastSynced` is the latest update to one of them -
     * status changes are written onto the row, there is no separate sync log.
     */
    admin.get('/template-meta', (req, res) => {
        const rows = db.db.prepare(
            `SELECT tenant_id, approval_status, COUNT(*) AS n, MAX(updated_at) AS last
             FROM templates WHERE template_type = 'provider_template' GROUP BY tenant_id, approval_status`).all();
        const tenants = tenancy.listTenants().map((tenant) => {
            const mine = rows.filter((r) => r.tenant_id === tenant.id);
            const count = (status) => mine.filter((r) => r.approval_status === status).reduce((n, r) => n + r.n, 0);
            return {
                tenantId: tenant.id,
                tenantName: tenant.name,
                total: mine.reduce((n, r) => n + r.n, 0),
                approved: count('approved'),
                pending: count('pending'),
                rejected: count('rejected'),
                draft: count('draft'),
                lastSynced: mine.map((r) => r.last).sort().at(-1) ?? null,
            };
        });
        res.json({ tenants });
    });
}
