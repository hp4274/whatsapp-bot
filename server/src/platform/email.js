/**
 * Email the Wuzie team writes from the dashboard: saved templates, and a queue that sends one at a time.
 *
 * The queue lives in the database so a send to hundreds neither holds the request open nor is lost to a restart
 * (one mid-flight when the server dies goes out again). Platform-wide, like the WhatsApp texts in notify.js.
 */

import { customEmail } from '../mail/emails.js';
import { logger } from '../observability/logger.js';
import { utcNow } from '../protocol.js';

export const PLATFORM_EMAIL_SCHEMA = `
CREATE TABLE IF NOT EXISTS email_templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    subject    TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_emails (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    to_email   TEXT NOT NULL,
    label      TEXT NOT NULL,
    subject    TEXT NOT NULL,
    body       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'queued',
    error      TEXT,
    created_at TEXT NOT NULL,
    sent_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_platform_emails_status ON platform_emails(status, id);
`;

/** One address and nothing else: a comma or angle bracket would let the mail library read it as several. */
const EMAIL = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;
export const isEmail = (value) => EMAIL.test(value);

export const SUBJECT_MAX = 200;
export const BODY_MAX = 20_000;

export class EmailError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** Subject and body as typed, or the reason they cannot be used. */
export function cleanMessage({ subject, body } = {}) {
    const clean = { subject: String(subject ?? '').trim(), body: String(body ?? '').trim() };
    if (!clean.subject) throw new EmailError('Write a subject.');
    if (!clean.body) throw new EmailError('Write the email.');
    if (clean.subject.length > SUBJECT_MAX) throw new EmailError(`Keep the subject under ${SUBJECT_MAX} characters.`);
    if (clean.body.length > BODY_MAX) throw new EmailError(`Keep the email under ${BODY_MAX} characters.`);
    return clean;
}

const toTemplate = (r) => ({ id: r.id, name: r.name, subject: r.subject, body: r.body, updatedAt: r.updated_at });

export class PlatformEmails {
    /**
     * @param {import('node:sqlite').DatabaseSync} raw the platform-wide connection
     * @param {object} deps
     * @param {object} deps.mailer  mail/mailer.js
     * @param {number} [deps.gapMs]  the wait between two emails, so a big send stays under the mail host's rate limit
     * @param {() => void} [deps.onChange]  told after each email, so open pages update
     */
    constructor(raw, { mailer, gapMs = 1000, onChange = () => undefined }) {
        this.db = raw;
        this.mailer = mailer;
        this.gapMs = gapMs;
        this.onChange = onChange;
        this.running = null;
        this.stopped = false;
    }

    templates() {
        return this.db.prepare('SELECT * FROM email_templates ORDER BY name COLLATE NOCASE').all().map(toTemplate);
    }

    /** Adds one, or updates `id`. */
    saveTemplate(id, input = {}) {
        const name = String(input.name ?? '').trim();
        if (!name) throw new EmailError('Give the template a name.');
        if (name.length > 80) throw new EmailError('Keep the name under 80 characters.');
        const { subject, body } = cleanMessage(input);
        const now = utcNow();
        if (id === null) {
            const info = this.db.prepare('INSERT INTO email_templates (name, subject, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
                .run(name, subject, body, now, now);
            id = Number(info.lastInsertRowid);
        } else if (!this.db.prepare('UPDATE email_templates SET name = ?, subject = ?, body = ?, updated_at = ? WHERE id = ?')
            .run(name, subject, body, now, id).changes) {
            throw new EmailError('That template no longer exists.', 404);
        }
        return toTemplate(this.db.prepare('SELECT * FROM email_templates WHERE id = ?').get(id));
    }

    deleteTemplate(id) {
        return this.db.prepare('DELETE FROM email_templates WHERE id = ?').run(id).changes > 0;
    }

    recent(limit = 50) {
        return this.db.prepare('SELECT * FROM platform_emails ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({
            id: r.id, to: r.to_email, label: r.label, subject: r.subject, status: r.status, error: r.error ?? null,
            createdAt: r.created_at, sentAt: r.sent_at,
        }));
    }

    /**
     * An automatic email that already went out (or failed), for the log. The body is left out: a welcome email holds
     * the password. Never throws, because nearly all callers do not wait for the email.
     */
    record({ to, subject }, label, result) {
        if (!this.mailer.configured) return;
        try {
            const now = utcNow();
            this.db.prepare(`INSERT INTO platform_emails (to_email, label, subject, body, status, error, created_at, sent_at)
                VALUES (?, ?, ?, '', ?, ?, ?, ?)`)
                .run(to, label, subject, result.sent ? 'sent' : 'failed', result.sent ? null : result.reason ?? null, now, result.sent ? now : null);
            this.onChange();
        } catch (err) {
            logger.warn('email not logged', { to, error: err.message });
        }
    }

    /** @param {{to: string, label: string, subject: string, body: string}[]} items already rendered per person */
    enqueue(items) {
        const now = utcNow();
        const insert = this.db.prepare('INSERT INTO platform_emails (to_email, label, subject, body, created_at) VALUES (?, ?, ?, ?, ?)');
        this.db.exec('BEGIN');
        try {
            for (const item of items) insert.run(item.to, item.label, item.subject, item.body, now);
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
        this.drain();
    }

    /** Starts the sender if it is idle; the returned promise settles when the queue is empty. */
    drain() {
        if (this.running || this.stopped || !this.mailer.configured) return this.running;
        this.running = this.#work()
            .catch((err) => logger.warn('email queue stopped', { error: err.message }))
            .finally(() => { this.running = null; });
        return this.running;
    }

    async #work() {
        const next = this.db.prepare("SELECT * FROM platform_emails WHERE status = 'queued' ORDER BY id LIMIT 1");
        const finish = this.db.prepare('UPDATE platform_emails SET status = ?, error = ?, sent_at = ? WHERE id = ?');
        for (let row = next.get(); row && !this.stopped; row = next.get()) {
            const result = await this.mailer.send({ to: row.to_email, replyTo: this.mailer.notifyTo ?? undefined, ...customEmail(row) });
            finish.run(result.sent ? 'sent' : 'failed', result.sent ? null : result.reason, result.sent ? utcNow() : null, row.id);
            this.onChange();
            if (this.gapMs) await new Promise((resolve) => setTimeout(resolve, this.gapMs));
        }
    }

    /** Lets the email in flight finish; anything still queued goes out after the next start. */
    async stop() {
        this.stopped = true;
        await this.running;
    }
}
