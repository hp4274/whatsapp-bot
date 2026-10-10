/** One tenant cannot resolve another tenant's upload by guessing its id. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

import { MediaStore } from '../src/mediaStore.js';

it('resolves uploads from disk only for the owning tenant', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-media-'));
    fs.writeFileSync(path.join(dir, 'med_0123456789ab_pic.png'), 'x');
    new MediaStore(dir, 1).claim('med_0123456789ab');
    assert.equal(new MediaStore(dir, 2).get('med_0123456789ab'), undefined);
    assert.equal(new MediaStore(dir, 1).get('med_0123456789ab').filename, 'pic.png');
    fs.writeFileSync(path.join(dir, 'med_ba9876543210_old.pdf'), 'x');
    assert.equal(new MediaStore(dir, 2).get('med_ba9876543210').mimetype, 'application/pdf');
});
