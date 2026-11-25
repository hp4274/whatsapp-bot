/**
 * "Make variations": an AI model rewrites a campaign message VARIATION_COUNT (5) whole different ways, in the message's own language;
 * the campaign then sends each person the main message or one of them at random. The super admin picks the provider, API key and model (admin Campaigns page, `readAiSettings`):
 * Claude through its SDK, or any OpenAI-compatible chat API (ChatGPT, Gemini, Groq, OpenRouter, DeepSeek, custom).
 *
 * The details are guarded in code, not only in the prompt: a rewrite that adds, drops or changes a placeholder,
 * word-choice group, link, number or emoji is thrown away.
 */

import Anthropic from '@anthropic-ai/sdk';

import { decrypt, encrypt } from '../security/crypto.js';
import { utcNow } from '../protocol.js';
export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Provider id -> OpenAI-compatible base URL; 'anthropic' uses the Claude SDK, 'custom' the saved baseUrl. */
export const PROVIDERS = {
    anthropic: null,
    openai: 'https://api.openai.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
    groq: 'https://api.groq.com/openai/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    deepseek: 'https://api.deepseek.com/v1',
    custom: null,
};

/** Rewrites asked for per press of the button. */
export const VARIATION_COUNT = 5;

const SYSTEM = `You rewrite a WhatsApp marketing message ${VARIATION_COUNT} different ways, so each recipient gets different wording.

Rules - all of them are checked by code and a break throws that rewrite away:
- Every rewrite says exactly what the original says: add no new information, leave nothing out, never turn a statement into its opposite, change a tense, or change a quantity ("each" stays "each").
- Same language, script and tone as the original (Gujarati stays Gujarati, Hindi stays Hindi in the same script, Hinglish stays Hinglish, formal stays formal). Never translate.
- Copy exactly, character for character: everything in curly brackets such as {name}, {name|there} or {Hi|Hello}, names, brand or product names, prices, numbers, dates, times, links, phone numbers, emails, codes and emojis.
- Rewrite line by line: the same number of lines, each line saying what the same line said, at about the same length. Copy lines that are only a date, time, address, name or link unchanged. Keep *bold*, _italic_ and ~strike~ markers around the same words.
- Use only common, correct words of that language that a native speaker would write. Never mix in English or other-language words the original does not use. When unsure of a word, keep the original word.
- Make the rewrites clearly different from the original and from each other: other words, other word order, other sentence shapes.

Reply with a JSON array of ${VARIATION_COUNT} strings and nothing else.`;

export class VariationError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.status = status;
    }
}

// ---------------------------------------------------------------- settings --
// Platform-wide, in platform_policy under its own scope; the key sealed like channel credentials.
const SCOPE = 'ai';

export function readAiSettings(db) {
    const rows = db.prepare('SELECT key, value FROM platform_policy WHERE scope = ?').all(SCOPE);
    const get = (key) => rows.find((r) => r.key === key)?.value ?? '';
    const provider = Object.hasOwn(PROVIDERS, get('provider')) ? get('provider') : 'anthropic';
    return {
        provider,
        apiKey: get('apiKey') ? decrypt(get('apiKey')) : '',
        // Only Claude has a default; other providers need their model named.
        model: get('model') || (provider === 'anthropic' ? DEFAULT_MODEL : ''),
        baseUrl: get('baseUrl'),
        // The super admin's switch for the Make variations buttons on every business; on unless turned off.
        enabled: get('enabled') !== 'false',
    };
}

/** `apiKey`: a new key, '' to remove it, undefined to keep it. `model`: '' goes back to the default. Undefined keeps a field. */
export function saveAiSettings(db, { provider, apiKey, model, baseUrl, enabled }) {
    const put = db.prepare(`INSERT INTO platform_policy (scope, key, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    if (apiKey !== undefined) put.run(SCOPE, 'apiKey', apiKey ? encrypt(apiKey) : '', utcNow());
    if (model !== undefined) put.run(SCOPE, 'model', model, utcNow());
    if (provider !== undefined) put.run(SCOPE, 'provider', provider, utcNow());
    if (baseUrl !== undefined) put.run(SCOPE, 'baseUrl', baseUrl, utcNow());
    if (enabled !== undefined) put.run(SCOPE, 'enabled', String(enabled), utcNow());
    return readAiSettings(db);
}

/** What the admin page may see: never the key itself. */
export const publicAiSettings = ({ provider, apiKey, model, baseUrl, enabled }) =>
    ({ provider, model, baseUrl, enabled, hasKey: Boolean(apiKey), keyEnd: apiKey.slice(-4) });

// ------------------------------------------------------------------- check --
const squash = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
/** Bracketed placeholders and word choices, links, digit runs and emojis: what a rewrite may not add, drop or change. */
const facts = (s) => [
    ...(s.match(/\{[^{}]*\}/g) ?? []),
    ...(s.match(/\b(?:https?:\/\/|www\.)\S+/gi) ?? []),
    ...(s.match(/\p{Nd}+(?:[.,:/-]\p{Nd}+)*/gu) ?? []),
    ...(s.match(/\p{Extended_Pictographic}/gu) ?? []),
].sort().join('\n');
const braces = (s) => (s.match(/[{}]/g) ?? []).join('');

/** True when `rewrite` keeps every detail of `original` (brackets, links, numbers, emojis) and is not the same text. */
export function keepsDetails(original, rewrite) {
    if (!rewrite.trim() || rewrite.length > 4096) return false;
    if (squash(rewrite) === squash(original)) return false;
    // Same brackets in the same nesting (no stray or nested brace), then the same details.
    if (braces(rewrite) !== braces(original) || facts(rewrite) !== facts(original)) return false;
    // Line for line: a merged, split or dropped line is a dropped or invented sentence.
    const was = lines(original);
    const now = lines(rewrite);
    if (now.length !== was.length || now.some((l, i) => Math.abs(l.length - was[i].length) > Math.max(25, was[i].length * 0.6))) {
        return false;
    }
    // No words in another script than the message's own unless the original has them ("Motivation" in Gujarati).
    const known = new Set(words(original).map((w) => w.toLowerCase()));
    const main = mainScript(original);
    return words(rewrite).every((w) => latin(w) === main || known.has(w.toLowerCase()));
}

const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const words = (s) => s.match(/[\p{L}\p{M}]+/gu) ?? [];
const latin = (w) => /\p{Script=Latin}/u.test(w);
/** True when most letters are Latin (an English or Hinglish message), false for Gujarati, Hindi and the like. */
const mainScript = (s) => {
    const all = words(s).join('');
    return (all.match(/\p{Script=Latin}/gu) ?? []).length * 2 > all.length;
};

/** The JSON array in a model's answer, tolerating a code fence or a line of chatter around it. */
export function parseList(answer) {
    const start = answer.indexOf('[');
    const end = answer.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    try {
        const list = JSON.parse(answer.slice(start, end + 1));
        return Array.isArray(list) ? list.filter((x) => typeof x === 'string').map((x) => x.trim()) : [];
    } catch {
        return [];
    }
}

// ------------------------------------------------------------------- model --
const NOT_SET_UP = 'Making variations is not set up yet.';
const clients = new Map(); // by key, so a new key from the admin page takes effect at once

/** One Claude request: `{ done, text }`. */
function askClaude(settings) {
    if (!clients.has(settings.apiKey)) clients.set(settings.apiKey, new Anthropic({ apiKey: settings.apiKey, maxRetries: RETRIES }));
    const client = clients.get(settings.apiKey);
    return async (text, system) => {
        try {
            const r = await client.messages.create({
                model: settings.model,
                max_tokens: 16000,
                output_config: { effort: 'low' },
                system,
                messages: [{ role: 'user', content: text }],
            });
            return { done: r.stop_reason === 'end_turn', text: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('') };
        } catch (err) {
            if (err instanceof Anthropic.APIError) throw failed(err.status, err.message);
            throw err;
        }
    };
}

const RETRIES = 5;
const MAX_WAIT_MS = 30_000; // the business is watching a spinner
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long the service asks us to wait (retry-after, or OpenAI's "1m3.2s" reset), else a growing pause; jittered so
 * businesses that collided don't collide again. */
export function retryWait(headers, tries) {
    const ms = Number(headers.get('retry-after-ms'));
    const s = Number(headers.get('retry-after'));
    const reset = headers.get('x-ratelimit-reset-requests')?.match(/^(?:(\d+)m)?(?:([\d.]+)s)?(?:(\d+)ms)?$/);
    const asked = ms > 0 ? ms
        : s > 0 ? s * 1000
            : reset?.[0] ? (Number(reset[1] ?? 0) * 60 + Number(reset[2] ?? 0)) * 1000 + Number(reset[3] ?? 0)
                : 1000 * 2 ** tries;
    return Math.round(asked + Math.random() * 1000);
}

/** One request to an OpenAI-compatible chat API (ChatGPT and most others): `{ done, text }`. */
export function askOpenAi(settings) {
    const base = (PROVIDERS[settings.provider] ?? settings.baseUrl).replace(/\/+$/, '');
    return async (text, system) => {
        let res;
        let body;
        // Low-tier accounts allow only a few requests a minute: a few businesses at once hit it, so wait as asked.
        for (let tries = 1; ; tries++) {
            try {
                res = await fetch(`${base}/chat/completions`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
                    body: JSON.stringify({
                        model: settings.model,
                        messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
                        // Rewording needs no thinking, and thinking models on OpenRouter can spend the whole reply on it
                        // and answer nothing.
                        ...(settings.provider === 'openrouter' ? { reasoning: { enabled: false } } : {}),
                    }),
                    signal: AbortSignal.timeout(90_000),
                });
            } catch (err) {
                throw failed(0, err.message);
            }
            body = await res.json().catch(() => ({}));
            // OpenAI also answers 429 when the account has no credit left; waiting won't fix that.
            // (type insufficient_quota; code credit_balance_exhausted, or insufficient_quota on older accounts)
            if (/insufficient_quota|credit_balance/.test(`${body?.error?.type} ${body?.error?.code}`)) {
                throw failed(402, body.error.message);
            }
            const busy = res.status === 429 || res.status === 503;
            const wait = retryWait(res.headers, tries);
            if (!busy || tries >= RETRIES || wait > MAX_WAIT_MS) break;
            await sleep(wait);
        }
        if (!res.ok) throw failed(res.status, body?.error?.metadata?.raw ?? body?.error?.message ?? res.statusText);
        const choice = body.choices?.[0];
        return { done: choice?.finish_reason === 'stop', text: choice?.message?.content ?? '' };
    };
}

// Image, audio, embedding and other non-chat models the services list alongside chat ones.
const NOT_CHAT = /embed|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|search|davinci|babbage|guard|vision-preview|aqa|imagen|veo/i;

/** The chat models `apiKey` can use on its service, for the admin's model picker. Throws VariationError. */
export async function listModels({ provider, apiKey, baseUrl }) {
    let ids;
    if (provider === 'anthropic') {
        try {
            const client = new Anthropic({ apiKey });
            ids = [];
            for await (const m of client.models.list()) ids.push(m.id);
        } catch (err) {
            if (err instanceof Anthropic.APIError) throw modelsFailed(err.status);
            throw err;
        }
    } else {
        const base = (PROVIDERS[provider] ?? baseUrl).replace(/\/+$/, '');
        let res;
        try {
            res = await fetch(`${base}/models`, {
                headers: { authorization: `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(20_000),
            });
        } catch {
            throw new VariationError('Could not reach that AI service. Check the address.', 400);
        }
        if (!res.ok) throw modelsFailed(res.status);
        const body = await res.json().catch(() => ({}));
        // Gemini lists "models/gemini-..."; its chat endpoint takes the bare name.
        ids = (body.data ?? []).map((m) => String(m.id).replace(/^models\//, ''));
    }
    return [...new Set(ids.filter((id) => id && !NOT_CHAT.test(id)))].sort();
}

function modelsFailed(status) {
    if (status === 401 || status === 403) return new VariationError('That API key was not accepted by this AI service.', 400);
    return new VariationError(`Could not load the models (error ${status}). Try again.`, 400);
}

function failed(status, message) {
    if (status === 401 || status === 403) return new VariationError(NOT_SET_UP, 503);
    if (status === 402) {
        console.warn('[variations] the AI account is out of credit; top it up or change the key:', message);
        return new VariationError('Making variations is paused for now. Try again later.', 503);
    }
    if (status === 429) {
        console.warn('[variations] the AI service is limiting requests:', message);
        return new VariationError('The AI service is busy right now. Try again in a minute.', 429);
    }
    console.warn('[variations] AI request failed:', status, message);
    return new VariationError('Could not make variations right now. Try again.');
}

/** Up to VARIATION_COUNT rewrites of `text` that keep its details; throws VariationError when none do. */
export async function makeVariations(text, { settings, ask } = {}) {
    if (!ask) {
        if (settings?.enabled === false) throw new VariationError('Making variations is switched off.', 403);
        if (!settings?.apiKey || !settings.model) throw new VariationError(NOT_SET_UP, 503);
        if (settings.provider === 'custom' && !settings.baseUrl) throw new VariationError(NOT_SET_UP, 503);
        ask = (settings.provider ?? 'anthropic') === 'anthropic' ? askClaude(settings) : askOpenAi(settings);
    }
    // The model is random: one more try when no rewrite passes the check.
    for (let attempt = 0; attempt < 2; attempt++) {
        const { done, text: answer } = await ask(text, SYSTEM);
        if (!done) continue;
        const kept = [...new Set(parseList(answer).filter((v) => keepsDetails(text, v)))];
        if (kept.length) return kept.slice(0, VARIATION_COUNT);
    }
    throw new VariationError('Could not reword this message without changing its details. Try again.', 422);
}
