/**
 * Server entry point.
 *
 *   npm start                 # API on http://127.0.0.1:3000
 *   PORT=4000 npm start
 *
 * In production the built Angular app is served from ../web/dist, so the whole
 * thing is one origin and one process.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { closeApp, createApp } from './app.js';
import { APP_DIR, ensureAppDir, loadConfig } from './config.js';
import { Database } from './db.js';
import { migrateChannelSettings } from './security/crypto.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Automatically load .env file if present
const envPaths = [
    path.join(process.cwd(), '.env'),
    path.join(HERE, '..', '..', '.env'),
    path.join(HERE, '..', '.env'),
];
for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
        try {
            process.loadEnvFile(envPath);
            break;
        } catch {
            // ignore
        }
    }
}

import { hashPassword, verifyPassword } from './tenancy.js';
import { trackIndexHashes } from './security/headers.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

ensureAppDir();
const config = loadConfig();
const db = new Database();
// Seal any credentials written before encryption existed. A no-op without a
// key, and idempotent, so it is safe on every boot.
migrateChannelSettings(db.db);
// The real server runs the workflow sweeper; tests opt in explicitly.
const app = createApp({ db, config, scheduler: true });

// Serve the built frontend when it exists, so `npm start` is the whole app.
const webDist = path.join(HERE, '..', '..', 'web', 'dist', 'web', 'browser');
if (fs.existsSync(webDist)) {
    // The CSP must allow the build's inline bootstrap script by hash (see security/headers.js).
    trackIndexHashes(app, path.join(webDist, 'index.html'));
    app.use(express.static(webDist));
    app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

// First run: there is nobody to sign in as, so create the platform admin.
// Set SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD, or take the generated password
// printed once below.
const tenancy = app.locals.tenancy;
if (tenancy.userCount() === 0) {
    const email = process.env.SUPER_ADMIN_EMAIL || 'admin@whatsapp.local';
    const password = process.env.SUPER_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    await tenancy.createUser({ email, name: 'Platform admin', password, role: 'super_admin' });
    console.log(`[whatsapp-sender] created super admin ${email}`
        + (process.env.SUPER_ADMIN_PASSWORD ? '' : ` with password ${password}  (shown once)`));
} else if (process.env.SUPER_ADMIN_PASSWORD) {
    try {
        const email = (process.env.SUPER_ADMIN_EMAIL || 'admin@whatsapp.local').trim().toLowerCase();
        const adminUser = tenancy.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        // Only when it actually changed: a new password signs the admin out everywhere.
        if (adminUser && !(await verifyPassword(process.env.SUPER_ADMIN_PASSWORD, adminUser.password_hash))) {
            const hash = await hashPassword(process.env.SUPER_ADMIN_PASSWORD);
            tenancy.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, adminUser.id);
            tenancy.revokeSessions(adminUser.id);
            console.log(`[whatsapp-sender] synced super admin password for ${email} from environment`);
        }
    } catch (err) {
        console.error('[whatsapp-sender] warning: failed to sync admin password from env:', err.message);
    }
}

const server = app.listen(PORT, HOST, () => {
    console.log(`[whatsapp-sender] API on http://${HOST}:${PORT}`);
    console.log(`[whatsapp-sender] data in ${APP_DIR}`);
    if (!fs.existsSync(webDist)) {
        console.log('[whatsapp-sender] frontend not built - run "npm run build" in ../web,'
            + ' or "npm start" there for the dev server');
    }
});

async function shutdown(signal) {
    console.log(`[whatsapp-sender] ${signal}, shutting down`);
    try {
        await closeApp(app);
    } catch (err) {
        console.error('[whatsapp-sender] shutdown error:', err.message);
    }
    db.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
    console.error('[whatsapp-sender] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('[whatsapp-sender] Unhandled rejection:', reason);
});
