/**
 * The build's SEO step, run after `ng build` (web/package.json "postbuild", so `npm run build` does both).
 *
 * The app is rendered in the browser, so a crawler that runs no JavaScript (most AI assistants, link previews)
 * saw the same index.html for every address. This writes each public page as its own HTML file, with its own
 * title, description, canonical link, schema.org data and readable text:
 *   dist/web/browser/seo/index.html          the landing page, with its FAQ as FAQPage schema
 *   dist/web/browser/seo/blog.html           the list of guides
 *   dist/web/browser/seo/blog/<slug>.html    each guide, as BlogPosting schema and full text
 * (served for /, /blog and /blog/<slug> by server/src/publicPages.js; the browser then starts the app as usual),
 * plus sitemap.xml and llms-full.txt, all from the same data the pages use, so none of them can fall behind.
 *
 * SITE_URL sets the public address (default https://wuzie.in): `SITE_URL=https://example.com npm run build`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist', 'web', 'browser');
/** The address written in index.html, robots.txt and llms.txt; replaced by SITE_URL in the built copies. */
const WRITTEN_SITE = 'https://wuzie.in';
const SITE = (process.env.SITE_URL || WRITTEN_SITE).replace(/\/+$/, '');

// Node reads these TypeScript files directly (they hold only data and types).
const load = (file) => import(pathToFileURL(path.join(HERE, '..', 'src', 'app', file)).href);
const { POSTS, BLOG_TITLE, BLOG_DESCRIPTION } = await load('blog/posts.ts');
const { FAQS } = await load('landing/faq.ts');
const posts = [...POSTS].sort((a, b) => b.published.localeCompare(a.published));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const base = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');

/** `base` as one page. A pattern that no longer matches index.html stops the build instead of writing a wrong page. */
function page({ title, description, route, type = 'website', schema = [], body }) {
    let html = base;
    const swap = (pattern, value) => {
        if (!pattern.test(html)) throw new Error(`seo.mjs: index.html no longer has ${pattern}`);
        html = html.replace(pattern, (whole, before, after) => before + value + after);
    };
    if (title) {
        swap(/(<title>)[\s\S]*?(<\/title>)/, esc(title));
        swap(/(<meta property="og:title" content=")[^"]*(")/, esc(title));
    }
    if (description) {
        swap(/(<meta name="description" content=")[^"]*(")/, esc(description));
        swap(/(<meta property="og:description" content=")[^"]*(")/, esc(description));
    }
    swap(/(<meta property="og:type" content=")[^"]*(")/, type);
    const url = SITE + route;
    const head = [
        `<link rel="canonical" href="${url}">`,
        `<meta property="og:url" content="${url}">`,
        // "<" escaped so no text inside the data can close the script element.
        ...schema.map((data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`),
    ];
    swap(/()(<\/head>)/, head.map((line) => `  ${line}\n`).join(''));
    // The body's <noscript> (the one in <head> is the stylesheet fallback the build adds).
    if (body) swap(/(<app-root><\/app-root>[\s\S]*?<noscript>)[\s\S]*?(<\/noscript>)/, `\n${body}\n  `);
    return html.replaceAll(WRITTEN_SITE, SITE);
}

function write(file, text) {
    const target = path.join(DIST, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
}

const guideLinks = `<ul>\n${posts.map((p) => `      <li><a href="/blog/${p.slug}">${esc(p.title)}</a>: ${esc(p.description)}</li>`).join('\n')}\n    </ul>`;

// ---------------------------------------------------------------- landing --
{
    // The hand-written text stays; its questions and guide links are rebuilt from the data, so they cannot drift.
    const current = /<noscript>(?![\s\S]*<noscript>)([\s\S]*?)<\/noscript>/.exec(base)?.[1];
    const lists = /<h2>Questions<\/h2>[\s\S]*?<\/ul>/;
    if (!current || !lists.test(current)) throw new Error('seo.mjs: the <noscript> block in index.html lost its Questions and Guides sections');
    const body = current.replace(lists, () => [
        '<h2>Questions</h2>',
        ...FAQS.map((f) => `    <h3>${esc(f.q)}</h3>\n    <p>${esc(f.a)}</p>`),
        `    <h2>Guides</h2>\n    ${guideLinks}`,
    ].join('\n')).trim();
    write('seo/index.html', page({
        route: '/',
        body: `    ${body}`,
        schema: [{
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: FAQS.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
        }],
    }));
}

// ------------------------------------------------------------------- blog --
write('seo/blog.html', page({
    title: BLOG_TITLE,
    description: BLOG_DESCRIPTION,
    route: '/blog',
    body: `    <h1>Wuzie blog: guides to WhatsApp messaging for small businesses</h1>\n    <p>${esc(BLOG_DESCRIPTION)}</p>\n    ${guideLinks}\n    <p><a href="/">About Wuzie</a></p>`,
    schema: [{
        '@context': 'https://schema.org',
        '@type': 'Blog',
        name: 'Wuzie blog',
        url: `${SITE}/blog`,
        publisher: { '@id': `${SITE}/#org` },
        blogPost: posts.map((p) => ({ '@type': 'BlogPosting', headline: p.title, url: `${SITE}/blog/${p.slug}`, datePublished: p.published })),
    }],
}));

const blockHtml = (b) => {
    if (b.kind === 'h2') return `<h2>${esc(b.text)}</h2>`;
    if (b.kind === 'list') return `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
    if (b.kind === 'example') return `<blockquote><p><strong>${esc(b.label)}</strong></p><p>${esc(b.text).replace(/\n/g, '<br>')}</p></blockquote>`;
    return `<p>${esc(b.text)}</p>`;
};
for (const p of posts) {
    const url = `${SITE}/blog/${p.slug}`;
    write(`seo/blog/${p.slug}.html`, page({
        title: `${p.title} - Wuzie`,
        description: p.description,
        route: `/blog/${p.slug}`,
        type: 'article',
        body: [
            `<article>`,
            `<h1>${esc(p.title)}</h1>`,
            `<p>${esc(p.description)}</p>`,
            `<p>Published <time datetime="${p.published}">${p.published}</time> by Wuzie. Topic: ${esc(p.topic)}.</p>`,
            ...p.body.map(blockHtml),
            `</article>`,
            `<p><a href="/blog">More guides</a> · <a href="/">About Wuzie</a></p>`,
        ].map((line) => `    ${line}`).join('\n'),
        schema: [
            {
                '@context': 'https://schema.org',
                '@type': 'BlogPosting',
                headline: p.title,
                description: p.description,
                datePublished: p.published,
                dateModified: p.published,
                articleSection: p.topic,
                inLanguage: 'en',
                mainEntityOfPage: url,
                image: `${SITE}/assets/landing/hero-shop.jpg`,
                author: { '@id': `${SITE}/#org` },
                publisher: { '@id': `${SITE}/#org` },
            },
            {
                '@context': 'https://schema.org',
                '@type': 'BreadcrumbList',
                itemListElement: [['Home', `${SITE}/`], ['Blog', `${SITE}/blog`], [p.title, url]]
                    .map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })),
            },
        ],
    }));
}

// ------------------------------------------------- sitemap and llms-full --
const newest = posts[0]?.published;
write('sitemap.xml', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${SITE}/</loc></url>`,
    `  <url><loc>${SITE}/blog</loc>${newest ? `<lastmod>${newest}</lastmod>` : ''}</url>`,
    ...posts.map((p) => `  <url><loc>${SITE}/blog/${p.slug}</loc><lastmod>${p.published}</lastmod></url>`),
    '</urlset>',
    '',
].join('\n'));

const blockText = (b) => {
    if (b.kind === 'h2') return `### ${b.text}`;
    if (b.kind === 'list') return b.items.map((i) => `- ${i}`).join('\n');
    if (b.kind === 'example') return `Example (${b.label}):\n\n${b.text.split('\n').map((line) => `> ${line}`).join('\n')}`;
    return b.text;
};
write('llms-full.txt', [
    '# Wuzie: full text',
    `> Everything on the public pages of ${SITE}, as plain text for AI assistants. The short version is ${SITE}/llms.txt.`,
    '## Questions and answers',
    ...FAQS.map((f) => `### ${f.q}\n\n${f.a}`),
    ...posts.map((p) => [`## ${p.title}`, `${SITE}/blog/${p.slug} · published ${p.published}`, p.description, ...p.body.map(blockText)].join('\n\n')),
    '',
].join('\n\n'));

// The files written by hand name the default address: the built copies follow SITE_URL.
for (const file of ['robots.txt', 'llms.txt']) {
    const target = path.join(DIST, file);
    if (fs.existsSync(target)) fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replaceAll(WRITTEN_SITE, SITE));
}

console.log(`seo: ${2 + posts.length} pages, sitemap.xml and llms-full.txt written for ${SITE}`);
