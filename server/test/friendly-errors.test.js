/** Customers see a sentence they can act on, never a provider stack trace. */

import assert from 'node:assert/strict';
import { it } from 'node:test';

import { friendlyError } from '../src/messaging/errors.js';

it('turns raw WhatsApp failures into plain language', () => {
    const raw = "Data passed to getter must include an id property (it's how we memoize) but got undefined s (https://static.whatsapp.net/rsrc.php/v4/yp/r/NooljZMhLNn.js:85:180)";
    assert.match(friendlyError(raw), /could not find this chat/);
    assert.match(friendlyError('Evaluation failed: Error: Protocol error (Runtime.callFunctionOn): Target closed'), /disconnected/);
    assert.match(friendlyError('919999999999 is not on WhatsApp'), /not on WhatsApp/);
    assert.match(friendlyError('Too many requests'), /limiting/);
    assert.match(friendlyError('TypeError: x is undefined at foo (/srv/app.js:10:3)'), /could not send this message/);
    assert.equal(friendlyError('Daily limit reached'), 'Daily limit reached', 'our own reasons pass through');
    const once = friendlyError(raw);
    assert.equal(friendlyError(once), once, 'idempotent');
    assert.equal(friendlyError(''), '');
});
