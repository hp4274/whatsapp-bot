import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { closeApp } from '../src/app.js';
import { createTestApp, sessionFor } from './helpers.js';

const app = await createTestApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
after(async () => { await new Promise((r) => server.close(r)); await closeApp(app); });
const base = `http://127.0.0.1:${server.address().port}`;

it('a database saved before the merge never shows the old bulk service anywhere', async () => {
    const db = app.locals.tenancy.db;
    // as production has it: the tenant and a stored plan both list the old key beside campaigns
    db.prepare('UPDATE tenants SET services = ? WHERE id = 1').run(JSON.stringify(['contacts', 'bulk_messages', 'campaigns', 'templates']));
    db.prepare(`INSERT OR REPLACE INTO plans (key, name, tier, details, limits, features, created_at, updated_at) VALUES ('starter', 'Starter', 1, ?, '{}', '{}', '2026-01-01', '2026-01-01')`)
        .run(JSON.stringify({ services: ['contacts', 'bulk_messages', 'campaigns'] }));
    const sup = sessionFor(app, { role: 'super_admin' });
    const get = async (url, token = sup) => (await fetch(base + url, { headers: { authorization: `Bearer ${token}` } })).text();
    for (const url of ['/api/admin/tenants', '/api/admin/plans', '/api/admin/policy', '/api/auth/me', '/api/admin/tenants/1']) {
        const text = await get(url);
        assert.ok(!text.includes('bulk_messages'), `${url} still names bulk_messages: ${text.slice(Math.max(0, text.indexOf('bulk_messages') - 120), text.indexOf('bulk_messages') + 60)}`);
    }
});
