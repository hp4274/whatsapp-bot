/**
 * Outgoing email over SMTP (Hostinger: smtp.hostinger.com, 465 with TLS). Settings come from the environment
 * (.env, never the code), and with none set the mailer is a no-op, so tests and local runs send nothing:
 *
 *   SMTP_HOST, SMTP_PORT (465 = TLS from the start, 587 = STARTTLS), SMTP_USER, SMTP_PASSWORD,
 *   SMTP_FROM (optional, default "Wuzie <SMTP_USER>"), LEADS_NOTIFY_EMAIL (optional, default SMTP_USER).
 *
 * `send` never throws: a mail that fails is logged and reported back as { sent: false, reason }, because no
 * email is worth failing the request that triggered it.
 */

import nodemailer from 'nodemailer';

import { logger } from '../observability/logger.js';

/** Account emails already sent, by event key (app.js mailOnce): the hourly "ends soon" check emails each one once. */
export const SENT_MAIL_SCHEMA = `
CREATE TABLE IF NOT EXISTS sent_mail (
    key      TEXT PRIMARY KEY,
    sent_at  TEXT NOT NULL
);
`;

const NOT_CONFIGURED = Object.freeze({ sent: false, reason: 'Email is not set up on this server.' });

/** The no-op mailer: what createApp uses unless index.js hands it a real one. */
export const noMailer = Object.freeze({
    configured: false,
    notifyTo: null,
    send: async () => NOT_CONFIGURED,
});

export function createMailer(env = process.env) {
    const host = env.SMTP_HOST?.trim();
    const user = env.SMTP_USER?.trim();
    if (!host || !user || !env.SMTP_PASSWORD) return noMailer;
    const port = Number(env.SMTP_PORT) || 465;
    const transport = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass: env.SMTP_PASSWORD },
        // A slow mail server must not hold a request open for minutes.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
    });
    const from = env.SMTP_FROM?.trim() || `Wuzie <${user}>`;
    return {
        configured: true,
        notifyTo: env.LEADS_NOTIFY_EMAIL?.trim() || user,
        async send({ to, subject, html, text, replyTo }) {
            try {
                const info = await transport.sendMail({ from, to, subject, html, text, replyTo });
                return { sent: true, id: info.messageId };
            } catch (err) {
                logger.warn('email failed', { to, subject, error: err.message });
                return { sent: false, reason: `The email could not be sent (${err.message}).` };
            }
        },
    };
}
