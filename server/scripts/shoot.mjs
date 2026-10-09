/** node scripts/shoot.mjs <token> <outDir> [width] [tab,tab,...]  - screenshots each school tab of the demo server. */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const [token, out, width = '1440', tabsArg = '', themeArg = 'dark'] = process.argv.slice(2);
const tabs = (tabsArg || 'overview,attendance,timetable,homework,notices,students,fees,leave,results,broadcast,ptm,staff,settings').split(',');
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
await page.setViewport({ width: Number(width), height: 900 });
await page.goto('http://127.0.0.1:3100/login');
await page.evaluate((t, process_theme) => { localStorage.setItem('wsender.token', t); localStorage.setItem('wsender.theme', process_theme); }, token, themeArg);
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
for (const tab of tabs) {
    await page.goto(`http://127.0.0.1:3100/${tab.includes('/') ? tab : 'school?tab=' + tab}`, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 4500));
    await page.screenshot({ path: `${out}/${tab.replaceAll('/', '_')}-${themeArg}-${width}.png`, fullPage: true });
}
console.log(JSON.stringify(errors.slice(0, 10)));
await browser.close();
