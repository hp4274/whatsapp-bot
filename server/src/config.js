/**
 * Application configuration, stored as JSON in the user profile directory so
 * an access token never has to live in the source tree.  Every operational
 * number (rate limit, retries, timeouts) is configurable.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_DIR = process.env.WHATSAPP_SENDER_HOME
    || path.join(os.homedir(), '.whatsapp_sender_web');
export const CONFIG_PATH = path.join(APP_DIR, 'config.json');
export const DB_PATH = path.join(APP_DIR, 'messages.db');
export const SESSION_DIR = path.join(APP_DIR, 'wwebjs_auth');

export const TRANSPORT_CLOUD_API = 'cloud_api';
export const TRANSPORT_BAILEYS = 'baileys';
/** The offline fake transport: only for the test suite and the demo script (WHATSAPP_SENDER_SANDBOX=1). */
export const TRANSPORT_SANDBOX = 'sandbox';
const SANDBOX_ENABLED = Boolean(process.env.WHATSAPP_SENDER_SANDBOX);
export const TRANSPORTS = [TRANSPORT_CLOUD_API, TRANSPORT_BAILEYS, ...(SANDBOX_ENABLED ? [TRANSPORT_SANDBOX] : [])];
/** QR-login transports that automate a personal/business number (same plan limit, same ToS warning). */
export const QR_TRANSPORTS = [TRANSPORT_BAILEYS];

/**
 * Transports that no longer exist map onto their replacement: WhatsApp Web
 * (whatsapp-web.js) and the sandbox both become Baileys, so a saved number keeps
 * working after a fresh QR scan.
 */
export function currentTransport(transport) {
    if (transport === 'whatsapp_web') return TRANSPORT_BAILEYS;
    if (transport === TRANSPORT_SANDBOX && !SANDBOX_ENABLED) return TRANSPORT_BAILEYS;
    return transport;
}

export const DEFAULTS = Object.freeze({
    transport: TRANSPORT_CLOUD_API,

    // Cloud API credentials
    graphVersion: 'v23.0',
    phoneNumberId: '',
    accessToken: '',

    // message shape
    useTemplate: false,
    templateName: 'hello_world',
    templateLanguage: 'en_US',
    previewUrl: true,

    // delivery control
    rateLimitPerSecond: 1.0,
    rateLimitBurst: 1,
    maxRetries: 3,
    retryDelay: 2.0,
    retryBackoff: 2.0,
    retryMaxDelay: 60.0,
    retryJitter: 0.25,
    requestTimeout: 30.0,

    // Cloud API delivery receipts
    webhookEnabled: false,
    webhookPath: '/api/webhook',
    webhookVerifyToken: 'change-me',
    // Meta app secret, used to verify X-Hub-Signature-256 on the webhook.
    // Per channel like the token; empty means the webhook is unverified (see
    // security/signature.js for why that is the default).
    appSecret: '',

    // WhatsApp Web
    chromePath: '',
    qrTimeout: 180.0,

    // set when the user connects, cleared when they disconnect: restarts honour it
    autoConnect: false,

    // sending safety (see campaign/safety.js)
    safetyEnabled: true,
    dailyLimit: 250,
    pacingMode: 'adaptive',
    minDelaySeconds: 0,
    maxDelaySeconds: 0,
    restEvery: 40,
    restMinMinutes: 2,
    restMaxMinutes: 5,
    failureStopPercent: 0,
    // number protection (platform policy, 0 = off; see campaign/safety.js)
    warmupDays: 0,            // new number: daily cap ramps 30, 60, 120... for this many days
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
    warmupDays: [0, 90],
    recipientDailyCap: [0, 100],
    requireVariationAbove: [0, 1000000],
    quietHoursStart: [0, 23],
    quietHoursEnd: [0, 23],
});
export const POLICY_KEYS = Object.keys(POLICY_SPEC);

export function ensureAppDir() {
    fs.mkdirSync(APP_DIR, { recursive: true });
    return APP_DIR;
}

function applyEnvOverrides(config) {
    // Env wins over the file: handy for CI and for people who refuse to write
    // a token to disk.
    if (process.env.WHATSAPP_ACCESS_TOKEN) config.accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (process.env.WHATSAPP_PHONE_NUMBER_ID) {
        config.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    }
    if (process.env.WHATSAPP_APP_SECRET) config.appSecret = process.env.WHATSAPP_APP_SECRET;
    return config;
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
    return applyEnvOverrides(config);
}

export function saveConfig(config, configPath = CONFIG_PATH) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return config;
}

/** Never send the token or the app secret to the browser. */
export function publicConfig(config) {
    return {
        ...config,
        accessToken: config.accessToken ? '__set__' : '',
        appSecret: config.appSecret ? '__set__' : '',
    };
}

/** Merge an update from the client, keeping a token the client did not resend. */
export function mergeConfig(current, update) {
    const merged = { ...current };
    for (const [key, value] of Object.entries(update ?? {})) {
        if (!(key in DEFAULTS)) continue;
        if ((key === 'accessToken' || key === 'appSecret') && value === '__set__') continue; // unchanged
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
    if (config.transport === TRANSPORT_CLOUD_API) {
        if (!String(config.phoneNumberId).trim()) {
            problems.push('Phone Number ID is required for the Cloud API transport.');
        }
        if (!String(config.accessToken).trim()) {
            problems.push('Access Token is required for the Cloud API transport.');
        }
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

export function graphBaseUrl(config) {
    return `https://graph.facebook.com/${config.graphVersion}`;
}
