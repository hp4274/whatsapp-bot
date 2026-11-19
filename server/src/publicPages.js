import fs from 'node:fs';
import path from 'node:path';

/** The public routes the build prerenders (web/scripts/seo.mjs): the landing page, the blog and its posts. */
const PUBLIC_ROUTE = /^\/(?:blog(?:\/[a-z0-9-]+)?)?\/?$/;

/**
 * The prerendered HTML file for a public route, or null: any other route, a build made without the SEO step, or
 * a post that does not exist. A crawler that runs no JavaScript reads the page's own title, schema and text there.
 * The route is matched whole, so the only request text that reaches the file path is a slug of a-z, 0-9 and "-".
 */
export function publicPageFile(webDist, reqPath) {
    if (!PUBLIC_ROUTE.test(reqPath)) return null;
    const file = path.join(webDist, 'seo', `${reqPath.replace(/^\/|\/$/g, '') || 'index'}.html`);
    return fs.existsSync(file) ? file : null;
}
