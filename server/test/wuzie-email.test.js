/** Wuzie's own email: templates, and a send from the dashboard that goes through the queue. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { Database } from '../src/db.js';
import { AUTOMATIC_EMAILS, LOGO_CID, LOGO_PNG, customEmail } from '../src/mail/emails.js';
import { createMailer } from '../src/mail/mailer.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-email-'));
const outbox = [];
const mailer = {
    configured: true,
    from: 'Wuzie <hello@wuzie.test>',
    notifyTo: 'team@wuzie.test',
    send: async (mail) => {
        outbox.push(mail);
        return mail.to.startsWith('bounce') ? { sent: false, reason: 'The email could not be sent (550).' } : { sent: true };
    },
};
let db;
let app;
let server;
let base;
let sup;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
};
const sendAll = async (body) => {
    outbox.length = 0;
    const res = await call(sup, 'POST', '/api/admin/wapzo/email/send', { subject: 'News', body: 'Hello', ...body });
    await app.locals.platformEmails.running;
    return res;
};

before(async () => {
    db = new Database(path.join(tmp, 'email.db'));
    app = createTestApp({ db, dataDir: tmp, mailer, emailGapMs: 0 });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    sup = sessionFor(app, { role: 'super_admin' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Wuzie email', () => {
    it('sends each address once, fills the words per person and reports what it skipped', async () => {
        const res = await sendAll({ subject: 'Hi {email}', emails: ['A@Test.dev', 'a@test.dev', 'not-an-address', 'x,y@test.dev'] });
        assert.equal(res.status, 200);
        assert.equal(res.body.queued, 1);
        assert.deepEqual(res.body.skipped.map((s) => s.to), ['not-an-address', 'x,y@test.dev']);
        assert.equal(outbox.length, 1);
        assert.equal(outbox[0].to, 'a@test.dev');
        assert.equal(outbox[0].subject, 'Hi a@test.dev');
        assert.equal(outbox[0].replyTo, 'team@wuzie.test');
    });

    it('leaves businesses that switched updates off out of "all"', async () => {
        const tenancy = app.locals.tenancy;
        const { tenant: on } = await tenancy.createTenantWithOwner({ name: 'On Ltd', owner: { email: 'on@test.dev', name: 'On', password: 'password123' } });
        const { tenant: off } = await tenancy.createTenantWithOwner({ name: 'Off Ltd', owner: { email: 'off@test.dev', name: 'Off', password: 'password123' } });
        tenancy.updateDetails(off.id, { wapzoUpdates: false });
        await sendAll({ body: 'Hi {name} of {business}', tenants: 'all' });
        const mine = outbox.filter((m) => m.to === 'on@test.dev' || m.to === 'off@test.dev');
        assert.deepEqual(mine.map((m) => m.to), ['on@test.dev']);
        assert.equal(mine[0].text, `Hi On of ${on.name}`);
    });

    it('records a failed email in the log', async () => {
        await sendAll({ subject: 'Bounce', emails: ['bounce@test.dev'] });
        const { body } = await call(sup, 'GET', '/api/admin/wapzo/email');
        assert.equal(body.configured, true);
        const entry = body.log.find((e) => e.to === 'bounce@test.dev');
        assert.equal(entry.status, 'failed');
        assert.match(entry.error, /550/);
    });

    it('refuses an empty email and nobody to send to', async () => {
        assert.equal((await sendAll({ subject: ' ', emails: ['a@test.dev'] })).status, 400);
        assert.equal((await sendAll({})).status, 400);
    });

    it('saves, updates and deletes a template', async () => {
        const created = await call(sup, 'POST', '/api/admin/wapzo/email/templates', { name: 'Offer', subject: 'S', body: 'B' });
        assert.equal(created.status, 200);
        const { id } = created.body.template;
        const updated = await call(sup, 'PUT', `/api/admin/wapzo/email/templates/${id}`, { name: 'Offer 2', subject: 'S', body: 'B' });
        assert.equal(updated.body.template.name, 'Offer 2');
        assert.equal((await call(sup, 'POST', '/api/admin/wapzo/email/templates', { name: '', subject: 'S', body: 'B' })).status, 400);
        assert.equal((await call(sup, 'DELETE', `/api/admin/wapzo/email/templates/${id}`)).status, 200);
        assert.equal((await call(sup, 'DELETE', `/api/admin/wapzo/email/templates/${id}`)).status, 404);
    });

    it('is the super admin\'s alone', async () => {
        const owner = sessionFor(app, { role: 'owner' });
        assert.equal((await call(owner, 'POST', '/api/admin/wapzo/email/send', { subject: 'S', body: 'B', emails: ['a@test.dev'] })).status, 403);
    });

    it('lists every automatic email with a sample that renders', async () => {
        const { body } = await call(sup, 'GET', '/api/admin/wapzo/email');
        assert.deepEqual(body.automatic.map((a) => a.kind), AUTOMATIC_EMAILS.map((a) => a.kind));
        for (const { kind } of body.automatic) {
            const sample = await call(sup, 'GET', `/api/admin/wapzo/email/automatic/${kind}`);
            assert.equal(sample.status, 200, kind);
            assert.ok(sample.body.subject && sample.body.html.includes('wuzie'), kind);
            assert.ok(!/undefined|null|NaN/.test(sample.body.subject + sample.body.html.replace(/<[^>]+>/g, '')), kind);
        }
        assert.equal((await call(sup, 'GET', '/api/admin/wapzo/email/automatic/nope')).status, 404);
    });

    it('logs an automatic email without keeping its body', async () => {
        const res = await fetch(`${base}/api/leads`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Asha', business: 'Asha Foods', email: 'asha@test.dev', phone: '+919812345678' }),
        });
        assert.equal(res.status, 201);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const { body } = await call(sup, 'GET', '/api/admin/wapzo/email');
        const entry = body.log.find((e) => e.to === 'asha@test.dev');
        assert.equal(entry.subject, 'We got your request for Wuzie');
        assert.equal(entry.status, 'sent');
        assert.equal(entry.label, 'Asha Foods');
        assert.ok(body.log.some((e) => e.to === 'team@wuzie.test' && e.subject.includes('Asha Foods')));
        const stored = db.db.prepare('SELECT body FROM platform_emails WHERE to_email = ?').get('asha@test.dev');
        assert.equal(stored.body, '');
    });

    it('carries the logo inside the email, and shows it in previews', async () => {
        assert.equal(LOGO_PNG.subarray(1, 4).toString(), 'PNG');
        assert.ok(customEmail({ subject: 'S', body: 'B' }).html.includes(`cid:${LOGO_CID}`));
        const sample = await call(sup, 'GET', '/api/admin/wapzo/email/automatic/plan_ending');
        assert.ok(sample.body.html.includes('src="data:image/png;base64,'));
        assert.ok(!sample.body.html.includes('cid:'));
        // The real mailer, against a server that will not answer: the attachment must not be what breaks it.
        const refused = await createMailer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USER: 'a@b.c', SMTP_PASSWORD: 'x' })
            .send({ to: 'a@test.dev', ...customEmail({ subject: 'S', body: 'B' }) });
        assert.equal(refused.sent, false);
    });

    it('escapes what is typed and links only web addresses', () => {
        const { html, text } = customEmail({ subject: 'S', body: 'See https://wuzie.test/a?b=1. <script>x</script>\n\njavascript:alert(1)' });
        assert.ok(html.includes('<a href="https://wuzie.test/a?b=1"'));
        assert.ok(!html.includes('<script>'));
        assert.ok(!html.includes('href="javascript'));
        assert.ok(text.includes('<script>x</script>'));
    });
});
