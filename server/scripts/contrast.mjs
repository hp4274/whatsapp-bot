/** node scripts/contrast.mjs <ownerToken> <superToken> - lists text below WCAG AA on the demo server. */
import puppeteer from 'puppeteer-core';

const [owner, sup] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const SCHOOL = ['overview', 'attendance', 'timetable', 'homework', 'notices', 'students', 'fees', 'leave', 'results', 'broadcast', 'ptm', 'staff', 'settings'].map((t) => `school?tab=${t}`);
const APP = ['connection', 'channels', 'contacts', 'campaign', 'auto-replies', 'payment-reminder', 'history', 'team'];
const ADMIN = ['admin/tenants', 'admin/plans', 'admin/usage', 'admin/health', 'admin/audit-logs', 'admin/channels', 'admin/services/school_whatsapp_bot'];

const probe = () => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
    const bgOf = (el) => {
        const stack = [];
        for (let n = el; n; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (cs.backgroundImage !== 'none' && !cs.backgroundImage.startsWith('linear-gradient(') && !cs.backgroundImage.startsWith('radial-gradient(')) return null;
            const c = parse(cs.backgroundColor);
            if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
        }
        let acc = { r: 255, g: 255, b: 255, a: 1 };
        if (!stack.length || stack[stack.length - 1].a < 1) acc = parse(getComputedStyle(document.documentElement).backgroundColor) ?? acc;
        for (let i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
        return acc;
    };
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const text = t.textContent.trim();
        const el = t.parentElement;
        if (!text || !el || seen.has(el)) continue;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (cs.visibility === 'hidden' || cs.display === 'none' || !r.width || !r.height || Number(cs.opacity) === 0) continue;
        if (el.closest('.sr-only, script, style, [disabled], :disabled, .ms, .layer')) continue;
        if (cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)' || cs.color === 'rgba(0, 0, 0, 0)') continue;
        seen.add(el);
        const fg = parse(cs.color); const bg = bgOf(el);
        if (!fg || !bg) continue;
        const f = over({ ...fg, a: fg.a * Number(cs.opacity) }, bg);
        const [a, b] = [lum(f), lum(bg)].sort((x, y) => y - x);
        const ratio = (a + 0.05) / (b + 0.05);
        const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
        const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
        if (ratio < need) out.push({ ratio: Math.round(ratio * 100) / 100, need, text: text.slice(0, 40), cls: (el.className?.baseVal ?? el.className ?? '').toString().slice(0, 40), tag: el.tagName.toLowerCase(), size });
    }
    return out;
};

for (const theme of ['dark', 'light']) {
    for (const [token, paths] of [[owner, [...SCHOOL, ...APP]], [sup, ADMIN]]) {
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 900 });
        await page.goto('http://127.0.0.1:3100/login', { waitUntil: 'domcontentloaded' });
        await page.evaluate((t, th) => { localStorage.setItem('wsender.token', t); localStorage.setItem('wsender.theme', th); }, token, theme);
        for (const path of paths) {
            try { await page.goto(`http://127.0.0.1:3100/${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch { console.log('skip', path); continue; }
            await new Promise((r) => setTimeout(r, 3500));
            const bad = await page.evaluate(probe);
            const uniq = new Map(bad.map((b) => [`${b.cls}|${b.tag}`, b]));
            for (const b of uniq.values()) console.log(`${theme} ${path} ${b.ratio}<${b.need} <${b.tag} .${b.cls}> "${b.text}" ${b.size}px`);
        }
        await page.close();
    }
}
await browser.close();
