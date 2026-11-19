/**
 * Real screenshots for every step of every page guide (web/src/app/core/guides/*.ts).
 *   npm --prefix web run build
 *   node --import ./test/isolate-home.js scripts/guide-shots.mjs [guideKey,guideKey...]
 * Boots an isolated sandbox server (temp data, every service on, demo data seeded), then walks each task in Chrome:
 * for each step it finds the on-screen control the step names, rings it, screenshots the area around it and - when
 * the step says to click/open/choose it - clicks it so the next step sees the next screen. Writes
 * web/public/assets/guides/<key>/<task>-<step>.webp and the manifest web/src/app/core/guide-shots.ts.
 * shortcut: label matching is a heuristic; a step whose words match no control gets a shot of the page as it stands.
 *
 * A guide can carry a plan, scripts/guide-shots/<key>.mjs, for steps the heuristic gets wrong (numbers are 1-based):
 *   export default {
 *     async setup(h) {},                       // once per guide: extra data via h.api(method, url, body)
 *     tasks: { 3: {
 *       path: '/campaigns/1',                  // where the task starts (default: the guide's page)
 *       async before(h) {},                    // after landing, before step 1
 *       steps: { 2: {
 *         act: async (h) => {},                // before the shot: get the screen into this step's state
 *         ring: 'Your contacts' | { selector } | null,  // what to ring (null: no ring, page shot)
 *         click: false,                        // override the auto-click after the shot
 *         after: async (h) => {},
 *       } },
 *     } },
 *   };
 * h = { page, base, settle(ms), db, api, goto(url), click(words | { selector }), type(selector, value) }.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import express from 'express';
import puppeteer from 'puppeteer-core';

import { createApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { trackIndexHashes } from '../src/security/headers.js';
import { TENANT_SERVICES } from '../src/tenancy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', '..', 'web');
const GUIDE_DIR = path.join(WEB, 'src', 'app', 'core', 'guides');
const OUT = path.join(WEB, 'public', 'assets', 'guides');
const MANIFEST = path.join(WEB, 'src', 'app', 'core', 'guide-shots.ts');
const PORT = Number(process.env.GUIDE_SHOTS_PORT ?? 3111);
const base = `http://127.0.0.1:${PORT}`;
const only = (process.argv[2] ?? '').split(',').filter(Boolean);

// ------------------------------------------------------------- guides --

const pathsSrc = fs.readFileSync(path.join(WEB, 'src', 'app', 'core', 'guides.ts'), 'utf8');
const pageOf = {};
for (const [, url, key] of pathsSrc.matchAll(/\['(\/[^']+)', '(\w+)'\]/g)) pageOf[key] ??= url;
const guides = {};
for (const file of fs.readdirSync(GUIDE_DIR).filter((f) => f.endsWith('.ts'))) {
    const mod = await import(pathToFileURL(path.join(GUIDE_DIR, file)).href); // `import type` only: Node strips it
    for (const [key, guide] of Object.entries(mod)) guides[key] = guide;
}

// ------------------------------------------------------------- server --

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-shots-'));
const app = createApp({
    db: new Database(path.join(tmp, 'shots.db')), dataDir: tmp, scheduler: false,
    config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, defaultCountryCode: '91' },
});
const tenancy = app.locals.tenancy;
tenancy.db.prepare('UPDATE tenants SET services = ?, name = ? WHERE id = 1').run(JSON.stringify(TENANT_SERVICES), 'Sunrise Boutique');
const mint = (role) => {
    const info = tenancy.db.prepare(
        `INSERT INTO users (tenant_id, email, name, password_hash, role, created_at)
         VALUES (?, ?, ?, 'x', ?, '2026-01-01T00:00:00Z')`)
        .run(role === 'super_admin' ? null : 1, `${role}@demo.dev`, role === 'owner' ? 'Asha Verma' : role, role);
    return tenancy.createSession(Number(info.lastInsertRowid));
};
const owner = mint('owner');
const superAdmin = mint('super_admin');

const webDist = path.join(WEB, 'dist', 'web', 'browser');
trackIndexHashes(app, path.join(webDist, 'index.html'));
app.use(express.static(webDist));
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
const server = app.listen(PORT, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const call = async (method, url, body, token = owner) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) console.warn(method, url, res.status, JSON.stringify(json).slice(0, 200));
    return json;
};
await call('POST', '/api/channels', { displayName: 'Sunrise Boutique', settings: { transport: TRANSPORT_SANDBOX } });
await call('POST', '/api/connection/connect', {});
await call('POST', '/api/admin/tenants/1/seed', {}, superAdmin);

// -------------------------------------------------------------- shoot --

const NEVER_CLICK = /delete|remove|log ?out|sign out|disconnect|unlink|reset|revoke|stop sending|close account/i;
const CLICK_VERB = /\b(click|open|choose|pick|switch|tap|select|go to|turn on|tick|press|expand)\b|^(in|on) /i;

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 820 });
await page.goto(`${base}/login`);
await page.evaluate((t) => {
    localStorage.setItem('wsender.token', t);
    localStorage.setItem('wsender.theme', 'light');
    localStorage.setItem('wuzie.guide.open', '0');
}, owner);
page.on('dialog', (d) => d.dismiss());
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

/**
 * In the page: ring a control and return its box. `{ selector }` names it outright; `{ step }` or `{ text }` picks the
 * visible control whose label those words contain (longest label wins).
 */
function markTarget({ step, text, selector }) {
    document.querySelectorAll('[data-shot-ring]').forEach((n) => n.remove());
    const words = ` ${(step ?? text ?? '').toLowerCase().replace(/[^\p{L}\p{N}{}%+]+/gu, ' ')} `;
    const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}{}%+]+/gu, ' ').trim();
    const CLICKABLE = 'button, a, [role=tab], [role=button], [role=menuitem], [role=radio], [role=switch], summary, label, option, select';
    const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'one', 'all', 'any', 'new', 'yes', 'off', 'then', 'with', 'this', 'that', 'each', 'here', 'there']);
    let best = null;
    if (selector) {
        const el = [...document.querySelectorAll(selector)].find((n) => n.checkVisibility?.());
        if (el) best = { el, label: norm(el.textContent ?? '') };
    }
    // Open dialogs first, then the page body; the sidebar and top bar only when neither names anything.
    const scopes = [document.querySelector('dialog[open], [role=dialog], .cdk-overlay-pane'), document.querySelector('main'), document].filter(Boolean);
    for (const scope of scopes) {
      if (best) break;
      for (const el of scope.querySelectorAll('*')) {
        if (el.matches('script, style, svg, svg *, i') || el.closest('app-page-guide, .guide, .guide-btn')) continue;
        const label = norm(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '');
        if (label.length < 3 || label.length > 48 || STOP.has(label) || !words.includes(` ${label} `)) continue;
        if (!el.checkVisibility?.() || el.getBoundingClientRect().width < 4) continue;
        // Ring the control the words sit in (a card, a button), not just the words.
        const host = el.closest(CLICKABLE);
        const target = host && host.getBoundingClientRect().height < 220 && !host.closest('app-page-guide') ? host : el;
        const score = label.length * 10 + (target.matches(CLICKABLE) ? 3 : 0);
        if (!best || score > best.score) best = { el: target, score, label };
      }
    }
    if (!best) return null;
    best.el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = best.el.getBoundingClientRect();
    const ring = document.createElement('div');
    ring.dataset.shotRing = '';
    Object.assign(ring.style, {
        position: 'fixed', left: `${r.left - 5}px`, top: `${r.top - 5}px`, width: `${r.width + 10}px`, height: `${r.height + 10}px`,
        border: '3px solid #f97316', borderRadius: '10px', boxShadow: '0 0 0 6px rgba(249,115,22,.22)', zIndex: 2147483647, pointerEvents: 'none',
    });
    // A modal <dialog> sits in the top layer, above anything in body: ring inside it or the ring is hidden.
    // A transformed dialog is the ring's containing block, so move the ring by however far it landed off target.
    (best.el.closest('dialog[open]') ?? document.body).append(ring);
    const got = ring.getBoundingClientRect();
    ring.style.left = `${2 * (r.left - 5) - got.left}px`;
    ring.style.top = `${2 * (r.top - 5) - got.top}px`;
    best.el.dataset.shotTarget = '';
    return { x: r.left, y: r.top, w: r.width, h: r.height, label: best.label, clickable: best.el.matches('button, a, [role=tab], [role=button], summary, label, option, [role=menuitem], .chip') };
}

const W = 760, H = 475, VW = 1366, VH = 820;
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
const clear = () => page.evaluate(() => {
    document.querySelectorAll('[data-shot-ring]').forEach((n) => n.remove());
    document.querySelectorAll('[data-shot-target]').forEach((n) => delete n.dataset.shotTarget);
});
/** Find (and ring) a control: { selector } or words the label sits in. */
const find = (hint) => page.evaluate(markTarget, typeof hint === 'string' ? { text: hint } : hint).catch(() => null);
const h = {
    page, base, settle,
    db: tenancy.db, // raw SQLite handle, for rows no API can make (delivered/read/failed history in the sandbox)
    api: call,
    goto: async (url) => { await page.goto(base + url, { waitUntil: 'networkidle2' }).catch(() => {}); await settle(1000); },
    /** Click the control named by words (or { selector }). */
    click: async (hint) => {
        const box = await find(hint);
        if (box) await page.click('[data-shot-target]').catch(() => {});
        await clear();
        await settle();
        return Boolean(box);
    },
    type: async (selector, value) => { await page.click(selector, { clickCount: 3 }).catch(() => {}); await page.type(selector, value).catch(() => {}); await settle(300); },
};

for (const [key, guide] of Object.entries(guides)) {
    if (only.length && !only.includes(key)) continue;
    const planFile = path.join(HERE, 'guide-shots', `${key}.mjs`);
    const plan = fs.existsSync(planFile) ? (await import(pathToFileURL(planFile).href)).default : {};
    const dir = path.join(OUT, key);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true, maxRetries: 5 });
    await plan.setup?.(h);
    let hits = 0, total = 0;
    for (const [ti, task] of guide.tasks.entries()) {
        const tp = plan.tasks?.[ti + 1] ?? {};
        await h.goto(tp.path ?? pageOf[key]);
        await tp.before?.(h);
        for (const [si, step] of task.steps.entries()) {
            total++;
            const sp = tp.steps?.[si + 1] ?? {};
            await sp.act?.(h);
            const box = sp.ring === null ? null : await find(sp.ring ?? { step });
            await settle(250);
            // A target bigger than the shot (a whole card) gets a wider area scaled down to W x H, so its ring and labels fit.
            const zoom = box ? Math.min(VW / W, VH / H, Math.max(1, (box.w + 60) / W, (box.h + 60) / H)) : 1;
            const cw = W * zoom, ch = H * zoom;
            const clip = box
                ? { x: Math.max(0, Math.min(VW - cw, box.x + box.w / 2 - cw / 2)), y: Math.max(0, Math.min(VH - ch, box.y + box.h / 2 - ch / 2)), width: cw, height: ch, scale: 1 / zoom }
                : { x: 300, y: 0, width: W, height: H };
            await page.screenshot({ path: path.join(dir, `${ti + 1}-${si + 1}.webp`), type: 'webp', quality: 72, clip });
            if (box) hits++;
            await page.evaluate(() => document.querySelectorAll('[data-shot-ring]').forEach((n) => n.remove()));
            const click = sp.click ?? (box?.clickable && CLICK_VERB.test(step) && !NEVER_CLICK.test(box.label));
            if (box && click) { await page.click('[data-shot-target]').catch(() => {}); await settle(); }
            await clear();
            await sp.after?.(h);
        }
    }
    console.log(`${key}: ${total} shots, ${hits} ringed`);
}

// The manifest is whatever is on disk, so separate runs (one guide each) never overwrite each other's entries.
const all = fs.readdirSync(OUT).flatMap((k) => fs.statSync(path.join(OUT, k)).isDirectory()
    ? fs.readdirSync(path.join(OUT, k)).filter((f) => f.endsWith('.webp')).map((f) => `${k}/${f.slice(0, -5)}`) : [])
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
fs.writeFileSync(MANIFEST, `/** Generated by server/scripts/guide-shots.mjs - do not edit. Guide steps that have a screenshot, as "<guide>/<task>-<step>". */
export const GUIDE_SHOTS: ReadonlySet<string> = new Set([
${all.map((id) => `  '${id}',`).join('\n')}
]);
`);
if (errors.length) console.log('page errors:', JSON.stringify([...new Set(errors)].slice(0, 10)));
await browser.close();
server.close();
process.exit(0);
