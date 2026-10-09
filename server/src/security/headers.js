/**
 * Response hardening: security headers on every response, and the CSP hashes
 * for the inline script the Angular build emits (it flips the deferred
 * stylesheet's media back to "all"; without its hash the app renders unstyled).
 *
 * The CSP allows only this origin plus Google Fonts (stylesheet from
 * fonts.googleapis.com, font files from fonts.gstatic.com). Inline styles stay
 * allowed: Angular injects component styles as <style> tags.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

/** sha256 CSP sources for every inline <script> in `html`. */
export function inlineScriptHashes(html) {
    return [...String(html).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
        .filter(([, body]) => body.trim())
        .map(([, body]) => `'sha256-${crypto.createHash('sha256').update(body).digest('base64')}'`);
}

/**
 * Point `app.locals.cspScriptHashes` at a built index.html. Re-hashed when the
 * file changes, so rebuilding the frontend never needs a server restart.
 */
export function trackIndexHashes(app, indexPath) {
    let seen = -1;
    let hashes = [];
    Object.defineProperty(app.locals, 'cspScriptHashes', {
        configurable: true,
        get() {
            try {
                const mtime = fs.statSync(indexPath).mtimeMs;
                if (mtime !== seen) {
                    hashes = inlineScriptHashes(fs.readFileSync(indexPath, 'utf8'));
                    seen = mtime;
                }
            } catch {
                // No build: nothing inline to allow.
            }
            return hashes;
        },
    });
}

export function contentSecurityPolicy(scriptHashes = []) {
    return [
        "default-src 'self'",
        `script-src 'self'${scriptHashes.length ? ` ${scriptHashes.join(' ')}` : ''}`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ].join('; ');
}

/** Reads `req.app.locals.cspScriptHashes` per request, so index.js can set it after boot. */
export function securityHeaders() {
    return (req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Content-Security-Policy', contentSecurityPolicy(req.app.locals.cspScriptHashes));
        // Only over TLS: HSTS on plain http would be ignored at best.
        if (req.secure || req.get('x-forwarded-proto') === 'https') {
            res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }
        next();
    };
}
