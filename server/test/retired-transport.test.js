/** Numbers saved on the removed whatsapp-web.js transport come back as Baileys. */

import assert from 'node:assert/strict';
import { it } from 'node:test';

import { DEFAULTS, TRANSPORTS, currentTransport, mergeConfig } from '../src/config.js';

it('maps whatsapp_web onto baileys and no longer offers it', () => {
    assert.equal(currentTransport('whatsapp_web'), 'baileys');
    assert.equal(mergeConfig(DEFAULTS, { transport: 'whatsapp_web' }).transport, 'baileys');
    assert.ok(!TRANSPORTS.includes('whatsapp_web'));
});
