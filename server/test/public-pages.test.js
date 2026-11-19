/** The prerendered public pages (publicPages.js): which routes get their own file, and that nothing else does. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';

import { publicPageFile } from '../src/publicPages.js';

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-public-'));
fs.mkdirSync(path.join(dist, 'seo', 'blog'), { recursive: true });
for (const file of ['seo/index.html', 'seo/blog.html', 'seo/blog/keep-safe.html', 'secret.html']) fs.writeFileSync(path.join(dist, file), 'x');
after(() => fs.rmSync(dist, { recursive: true, force: true }));

it('serves the landing page, the blog and a post from their own files', () => {
    const name = (route) => publicPageFile(dist, route)?.slice(dist.length + 1).replaceAll('\\', '/') ?? null;
    assert.equal(name('/'), 'seo/index.html');
    assert.equal(name('/blog'), 'seo/blog.html');
    assert.equal(name('/blog/'), 'seo/blog.html');
    assert.equal(name('/blog/keep-safe'), 'seo/blog/keep-safe.html');
});

it('gives nothing for app routes, unknown posts and paths that try to leave the folder', () => {
    for (const route of ['/home', '/login', '/blog/no-such-post', '/blog/../../secret', '/blog/..%2f..%2fsecret', '/blog/Keep-Safe', '/blog/a/b', '/seo/index']) {
        assert.equal(publicPageFile(dist, route), null, route);
    }
    assert.equal(publicPageFile(path.join(dist, 'missing'), '/'), null, 'a build without the SEO step');
});
