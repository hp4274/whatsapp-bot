/**
 * Dedicated script to reset or sync the platform admin credentials.
 * Usage:
 *   node server/scripts/reset-password.js
 *   node server/scripts/reset-password.js newPassword123
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// Automatically load .env if found
const potentialEnvs = [
    path.join(process.cwd(), '.env'),
    path.join(ROOT, '.env'),
    path.join(ROOT, 'server', '.env'),
    '/var/www/whatsapp-bot/.env',
];

for (const envPath of potentialEnvs) {
    if (fs.existsSync(envPath)) {
        try {
            process.loadEnvFile(envPath);
            console.log(`[reset-password] Loaded environment from ${envPath}`);
            break;
        } catch (err) {
            // ignore
        }
    }
}

const email = (process.argv[3] || process.env.SUPER_ADMIN_EMAIL || 'admin@whatsapp.local').trim().toLowerCase();
const password = process.argv[2] || process.env.SUPER_ADMIN_PASSWORD || 'admin@2210';

if (!password || password.length < 8) {
    console.error('[reset-password] Error: Password must be at least 8 characters long.');
    process.exit(1);
}

const scrypt = promisify(crypto.scrypt);

async function hashPassword(pwd) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(String(pwd), salt, 64);
    return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(pwd, stored) {
    const [scheme, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(String(pwd), Buffer.from(salt, 'base64'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

const possibleDbPaths = [
    process.env.WHATSAPP_SENDER_HOME ? path.join(process.env.WHATSAPP_SENDER_HOME, 'messages.db') : null,
    '/var/lib/whatsapp-bot/messages.db',
    path.join(os.homedir(), '.whatsapp_sender_web', 'messages.db'),
    path.join(ROOT, 'server', 'messages.db'),
].filter(Boolean);

// Filter to unique paths
const uniqueDbPaths = [...new Set(possibleDbPaths)];
let updatedAny = false;

const newHash = await hashPassword(password);

for (const dbPath of uniqueDbPaths) {
    if (!fs.existsSync(dbPath)) {
        continue;
    }

    try {
        const db = new DatabaseSync(dbPath);
        
        // Ensure table exists
        const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
        if (!tableCheck) {
            continue;
        }

        const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (existing) {
            db.prepare('UPDATE users SET password_hash = ?, disabled = 0 WHERE id = ?').run(newHash, existing.id);
            console.log(`[reset-password] Successfully updated password for user "${email}" in ${dbPath}`);
        } else {
            const now = new Date().toISOString();
            db.prepare(
                `INSERT INTO users (tenant_id, email, name, password_hash, role, disabled, created_at)
                 VALUES (NULL, ?, 'Platform admin', ?, 'super_admin', 0, ?)`
            ).run(email, newHash, now);
            console.log(`[reset-password] Successfully created user "${email}" as super_admin in ${dbPath}`);
        }

        // Verify
        const verifyRow = db.prepare('SELECT password_hash FROM users WHERE email = ?').get(email);
        const ok = await verifyPassword(password, verifyRow.password_hash);
        if (ok) {
            console.log(`[reset-password] Verification: OK (authentication tested successfully).`);
            updatedAny = true;
        } else {
            console.error(`[reset-password] Warning: verification failed for ${dbPath}`);
        }
    } catch (err) {
        console.error(`[reset-password] Error updating ${dbPath}:`, err.message);
    }
}

if (!updatedAny) {
    console.log('[reset-password] No existing database files found yet.');
    console.log('[reset-password] Creating database with credentials in: ' + uniqueDbPaths[0]);
    try {
        fs.mkdirSync(path.dirname(uniqueDbPaths[0]), { recursive: true });
        const { Database } = await import('../src/db.js');
        const db = new Database();
        const now = new Date().toISOString();
        db.db.prepare(
            `INSERT INTO users (tenant_id, email, name, password_hash, role, disabled, created_at)
             VALUES (NULL, ?, 'Platform admin', ?, 'super_admin', 0, ?)`
        ).run(email, newHash, now);
        console.log(`[reset-password] Successfully initialized database and admin user.`);
        updatedAny = true;
    } catch (err) {
        console.error('[reset-password] Error initializing database:', err);
    }
}

console.log('\n=========================================');
console.log(' Credentials are ready:');
console.log(` Email:    ${email}`);
console.log(` Password: ${password}`);
console.log('=========================================\n');
