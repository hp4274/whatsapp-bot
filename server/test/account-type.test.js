/** Which WhatsApp app a linked number runs, from the platform the phone reports at pairing. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { accountTypeOf } from '../src/transports/baileys.js';

const sockOn = (platform) => ({ authState: { creds: { platform } } });

describe('linked account type', () => {
    it('tells WhatsApp Business from regular WhatsApp', () => {
        assert.equal(accountTypeOf(sockOn('smba')), 'business', 'Business on Android');
        assert.equal(accountTypeOf(sockOn('smbi')), 'business', 'Business on iPhone');
        assert.equal(accountTypeOf(sockOn('android')), 'personal');
        assert.equal(accountTypeOf(sockOn('iphone')), 'personal');
        assert.equal(accountTypeOf(sockOn(undefined)), null, 'not known yet');
        assert.equal(accountTypeOf(null), null);
    });
});
