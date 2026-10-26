/**
 * Application configuration, stored as JSON in the user profile directory.
 * Every operational number (rate limit, retries, timeouts) is configurable.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SECRET_SETTING_KEYS } from './security/crypto.js';

export const APP_DIR = process.env.WHATSAPP_SENDER_HOME
    || path.join(os.homedir(), '.whatsapp_sender_web');
export const CONFIG_PATH = path.join(APP_DIR, 'config.json');
export const DB_PATH = path.join(APP_DIR, 'messages.db');
export const SESSION_DIR = path.join(APP_DIR, 'wwebjs_auth');

export const TRANSPORT_BAILEYS = 'baileys';
/** The offline fake transport: only for the test suite and the demo script (WHATSAPP_SENDER_SANDBOX=1). */
export const TRANSPORT_SANDBOX = 'sandbox';
const SANDBOX_ENABLED = Boolean(process.env.WHATSAPP_SENDER_SANDBOX);
export const TRANSPORTS = [TRANSPORT_BAILEYS, ...(SANDBOX_ENABLED ? [TRANSPORT_SANDBOX] : [])];
/** QR-login transports that automate a personal/business number (same plan limit, same ToS warning). */
export const QR_TRANSPORTS = [TRANSPORT_BAILEYS];

/**
 * Transports that no longer exist map onto their replacement: WhatsApp Web
 * (whatsapp-web.js), the Meta Cloud API and the sandbox all become Baileys, so
 * a saved number keeps working after a fresh QR scan.
 */
export function currentTransport(transport) {
    if (transport === 'whatsapp_web' || transport === 'cloud_api') return TRANSPORT_BAILEYS;
    if (transport === TRANSPORT_SANDBOX && !SANDBOX_ENABLED) return TRANSPORT_BAILEYS;
    return transport;
}

export const DEFAULTS = Object.freeze({
    transport: TRANSPORT_BAILEYS,

    // delivery control
    rateLimitPerSecond: 1.0,
    rateLimitBurst: 1,
    maxRetries: 3,
    retryDelay: 2.0,
    retryBackoff: 2.0,
    retryMaxDelay: 60.0,
    retryJitter: 0.25,
    requestTimeout: 30.0,

    // WhatsApp Web
    chromePath: '',
    qrTimeout: 180.0,

    // set when the user connects, cleared when they disconnect: restarts honour it
    autoConnect: false,

    // sending safety (see campaign/safety.js). QR numbers follow sending levels (campaign/humanize.js LEVELS);
    // dailyLimit only ever lowers a level.
    safetyEnabled: true,
    dailyLimit: 250,          // 0 = no limit; on QR it only ever lowers the level's day
    // When a QR scan last linked a number here (app.js 'ready'): it rests before bulk. Server-set only.
    linkedAt: '',
    // Nightly rest, recipient-local sending hours and typing pauses. Off only for the test run (WHATSAPP_SENDER_FAST=1).
    humanTiming: process.env.WHATSAPP_SENDER_FAST !== '1',
    pacingMode: 'adaptive',
    minDelaySeconds: 0,
    maxDelaySeconds: 0,
    restEvery: 40,
    restMinMinutes: 2,
    restMaxMinutes: 5,
    failureStopPercent: 0,
    // number protection (platform policy, 0 = off; see campaign/safety.js)
    recipientDailyCap: 0,     // bulk messages one recipient may get per 24h
    requireVariationAbove: 0, // campaigns bigger than this need {a|b} or {name} in the text
    quietHoursStart: 0,       // hour (0-23, channel timezone) bulk sending holds from...
    quietHoursEnd: 0,         // ...until this hour; equal = off

    misc: undefined,
    defaultCountryCode: '',
    logLevel: 'info',
});

/**
 * Anti-ban policy: owned by the platform admin, never by a tenant.  Each key
 * maps to its allowed range (or values); see Tenancy.setSafety.
 */
export const POLICY_SPEC = Object.freeze({
    safetyEnabled: 'bool',
    pacingMode: ['adaptive', 'fixed'],
    dailyLimit: [0, 100000],
    minDelaySeconds: [0, 3600],
    maxDelaySeconds: [0, 3600],
    failureStopPercent: [0, 100],
    restEvery: [0, 10000],
    restMinMinutes: [0, 240],
    restMaxMinutes: [0, 240],
    rateLimitPerSecond: [0.01, 50],
    rateLimitBurst: [1, 100],
    maxRetries: [0, 10],
    retryDelay: [0, 600],
    retryBackoff: [1, 10],
    retryMaxDelay: [0, 3600],
    retryJitter: [0, 1],
    recipientDailyCap: [0, 100],
    requireVariationAbove: [0, 1000000],
    quietHoursStart: [0, 23],
    quietHoursEnd: [0, 23],
    requestTimeout: [1, 300],
});
export const POLICY_KEYS = Object.keys(POLICY_SPEC);

/**
 * Channel settings a tenant never writes (PUT /config, channel settings):
 * `linkedAt` is stamped by a QR scan only (an earlier stamp would skip a new
 * number's rest), `humanTiming` is the test run's switch, and the rest are
 * platform policy the super admin sets (POLICY_SPEC).
 */
export const ADMIN_CHANNEL_KEYS = Object.freeze(['linkedAt', 'humanTiming', 'requestTimeout']);

export function ensureAppDir() {
    fs.mkdirSync(APP_DIR, { recursive: true });
    return APP_DIR;
}

export function loadConfig(configPath = CONFIG_PATH) {
    const config = { ...DEFAULTS };
    delete config.misc;
    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        for (const [key, value] of Object.entries(raw)) {
            if (key in config) config[key] = value;
        }
    } catch {
        // No file yet, or unreadable: defaults stand.
    }
    config.transport = currentTransport(config.transport);
    return config;
}

export function saveConfig(config, configPath = CONFIG_PATH) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return config;
}

/** Secrets left in settings from the removed Cloud API never reach the browser. */
export function publicConfig(config) {
    const out = { ...config };
    for (const key of SECRET_SETTING_KEYS) delete out[key];
    return out;
}

/** Merge an update from the client: unknown keys are dropped. */
export function mergeConfig(current, update) {
    const merged = { ...current };
    for (const [key, value] of Object.entries(update ?? {})) {
        if (!(key in DEFAULTS)) continue;
        merged[key] = value;
    }
    merged.transport = currentTransport(merged.transport);
    return merged;
}

export function validateConfig(config) {
    const problems = [];
    if (!TRANSPORTS.includes(config.transport)) {
        problems.push(`Unknown transport: ${config.transport}`);
    }
    if (!(config.rateLimitPerSecond > 0)) problems.push('Rate limit must be greater than 0.');
    if (config.maxRetries < 0) problems.push('Max retries cannot be negative.');
    if (config.dailyLimit < 0) problems.push('Daily limit cannot be negative.');
    if (config.minDelaySeconds < 0 || config.maxDelaySeconds < 0) {
        problems.push('Delays cannot be negative.');
    }
    if (config.maxDelaySeconds > 0 && config.maxDelaySeconds < config.minDelaySeconds) {
        problems.push('Maximum delay must be at least the minimum delay.');
    }
    if (!(config.requestTimeout > 0)) problems.push('Request timeout must be greater than 0.');
    return problems;
}
