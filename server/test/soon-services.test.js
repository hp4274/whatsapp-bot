/** "Coming soon" services: no tenant or plan has one, whatever was saved, until it opens. */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { TENANT_SERVICES, normalizeTenantServices, openServices, soonServices } from '../src/tenancy.js';

describe('coming soon services', () => {
    let saved;
    before(() => {
        saved = process.env.WHATSAPP_SOON_SERVICES;
        delete process.env.WHATSAPP_SOON_SERVICES; // the production default, not the tests' "all open"
    });
    after(() => {
        process.env.WHATSAPP_SOON_SERVICES = saved;
    });

    it('are left out of every saved list and of the count', () => {
        assert.ok(soonServices().includes('ai') && soonServices().includes('school_whatsapp_bot'));
        assert.deepEqual(openServices(), ['whatsapp_channels', 'contacts', 'templates', 'auto_replies', 'bulk_messages', 'campaigns']);
        assert.deepEqual(normalizeTenantServices([...TENANT_SERVICES]), openServices(), 'a tenant saved with all 21');
        assert.deepEqual(normalizeTenantServices(['contacts', 'faq']), ['contacts']);
        assert.deepEqual(normalizeTenantServices(null), openServices(), 'no list = every open one');
    });

    it('open again by name', () => {
        process.env.WHATSAPP_SOON_SERVICES = 'ai';
        assert.ok(normalizeTenantServices(['faq', 'ai']).includes('faq'));
        assert.ok(!normalizeTenantServices(['faq', 'ai']).includes('ai'));
        delete process.env.WHATSAPP_SOON_SERVICES;
    });
});
