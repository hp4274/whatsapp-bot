import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
    DEFAULT_MODEL, askOpenAi, keepsDetails, listModels, makeVariations, parseList, retryWait, publicAiSettings, readAiSettings, saveAiSettings,
} from '../src/campaign/variations.js';
import { Database } from '../src/db.js';

const original = 'Hi {name}, our sale ends on 25/12. Shop now: https://shop.example.com\nThanks!';

test('keeps rewrites that say it another way with every detail intact', () => {
    assert.ok(keepsDetails(original, 'Hello {name}! The sale closes on 25/12, so visit https://shop.example.com\nThank you!'));
    assert.ok(keepsDetails('અમારો મોટો સેલ ૨૫ તારીખે પૂરો થાય છે.', 'અમારું મોટું વેચાણ ૨૫ તારીખે સમાપ્ત થાય છે.'));
    assert.ok(keepsDetails('{Hi|Hello} {name|there}, see you!', '{Hi|Hello} {name|there}, talk soon!'));
});

test('drops rewrites that change a detail or say the same thing', () => {
    // A changed number (also in Gujarati digits), a lost link, a lost placeholder.
    assert.equal(keepsDetails(original, 'Hello {name}, the sale closes on 26/12: https://shop.example.com'), false);
    assert.equal(keepsDetails('સેલ ૨૫ તારીખે પૂરો થાય છે.', 'વેચાણ ૨૬ તારીખે પૂરું થાય છે.'), false);
    assert.equal(keepsDetails(original, 'Hello {name}, the sale closes on 25/12. Thank you!'), false);
    assert.equal(keepsDetails(original, 'Hello there, the sale closes on 25/12: https://shop.example.com'), false);
    // A changed word choice group, a stray brace, or the original again.
    assert.equal(keepsDetails('{Hi|Hello} {name}', '{Hey|Hello} {name}'), false);
    assert.equal(keepsDetails(original, 'Hello {name}, sale closes {on 25/12: https://shop.example.com\nThank you!'), false);
    assert.equal(keepsDetails(original, original.toUpperCase()), false);
});

test('returns the rewrites that pass, retries once when none do, then gives up', async () => {
    const good = 'Hello {name}! The sale closes on 25/12, so visit https://shop.example.com\nThank you!';
    const answers = ['Sorry, no list here', '```json\n' + JSON.stringify([good, 'Changed price 99', good]) + '\n```'];
    const ask = async (text, system) => {
        assert.match(system, /JSON array of 5 strings/);
        return { done: true, text: answers.shift() };
    };
    assert.deepEqual(await makeVariations(original, { ask }), [good]);
    assert.equal(parseList('["a", 3, " b "]').join(','), 'a,b');
    await assert.rejects(makeVariations(original, { ask: async () => ({ done: true, text: '["Nope"]' }) }), { status: 422 });
});

test('talks to OpenAI-compatible APIs (ChatGPT, Gemini, custom) and maps their errors', async (t) => {
    const calls = [];
    let reply = { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] } };
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        const sent = JSON.parse(init.body);
        calls.push({ url, auth: init.headers.authorization, model: sent.model, ...(sent.reasoning ? { reasoning: sent.reasoning } : {}) });
        return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
    });
    const openai = askOpenAi({ provider: 'openai', apiKey: 'sk-1', model: 'gpt-x' });
    assert.deepEqual(await openai('Hi'), { done: true, text: 'ok' });
    await askOpenAi({ provider: 'custom', baseUrl: 'https://ai.example.com/v1/', apiKey: 'k', model: 'm' })('Hi');
    // OpenRouter thinking models answer nothing unless thinking is off.
    await askOpenAi({ provider: 'openrouter', apiKey: 'sk-or-1', model: 'x:free' })('Hi');
    assert.deepEqual(calls, [
        { url: 'https://api.openai.com/v1/chat/completions', auth: 'Bearer sk-1', model: 'gpt-x' },
        { url: 'https://ai.example.com/v1/chat/completions', auth: 'Bearer k', model: 'm' },
        { url: 'https://openrouter.ai/api/v1/chat/completions', auth: 'Bearer sk-or-1', model: 'x:free', reasoning: { enabled: false } },
    ]);
    reply = { status: 401, body: { error: { message: 'bad key' } } };
    await assert.rejects(openai('Hi'), { status: 503 });
    // Asked to wait longer than a business should: give up at once. Out of credit: no retry, a calm message.
    reply = { status: 429, body: {}, headers: { 'retry-after': '120' } };
    await assert.rejects(openai('Hi'), { status: 429 });
    reply = { status: 429, body: { error: { type: 'insufficient_quota', code: 'credit_balance_exhausted', message: 'no credit' } } };
    await assert.rejects(openai('Hi'), { status: 503, message: /paused for now/ });
    // Not Claude and no model named: not set up.
    await assert.rejects(makeVariations(original, { settings: { provider: 'openai', apiKey: 'k', model: '' } }), { status: 503 });
});

test('without an API key it says it is not set up', async () => {
    await assert.rejects(makeVariations(original, { settings: { apiKey: '', model: DEFAULT_MODEL } }), { status: 503 });
});

test('switched off by the super admin it refuses, even with a key', async () => {
    await assert.rejects(makeVariations(original, { settings: { apiKey: 'k', model: DEFAULT_MODEL, enabled: false } }), { status: 403 });
});

test('the admin settings keep the key, show only its end, and fall back to the default model', () => {
    const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-ai-')), 'ai.db'));
    try {
        const none = { provider: 'anthropic', model: DEFAULT_MODEL, baseUrl: '', enabled: true, hasKey: false, keyEnd: '' };
        assert.deepEqual(publicAiSettings(readAiSettings(db.db)), none);
        saveAiSettings(db.db, { apiKey: 'sk-ant-secret-1234', model: 'claude-sonnet-5-5' });
        assert.equal(readAiSettings(db.db).apiKey, 'sk-ant-secret-1234');
        assert.deepEqual(publicAiSettings(readAiSettings(db.db)), { ...none, model: 'claude-sonnet-5-5', hasKey: true, keyEnd: '1234' });
        // Model only: the key stays. Empty model: back to the default. Empty key: removed.
        saveAiSettings(db.db, { model: '' });
        assert.equal(readAiSettings(db.db).model, DEFAULT_MODEL);
        assert.equal(readAiSettings(db.db).apiKey, 'sk-ant-secret-1234');
        // Another provider has no default model.
        saveAiSettings(db.db, { provider: 'openai', apiKey: 'sk-proj-9876' });
        assert.deepEqual(publicAiSettings(readAiSettings(db.db)), { ...none, provider: 'openai', model: '', hasKey: true, keyEnd: '9876' });
        saveAiSettings(db.db, { apiKey: '' });
        assert.equal(readAiSettings(db.db).apiKey, '');
        // The show/hide switch: on by default, and off sticks until turned back on.
        saveAiSettings(db.db, { enabled: false });
        assert.equal(readAiSettings(db.db).enabled, false);
        saveAiSettings(db.db, { enabled: true });
        assert.equal(readAiSettings(db.db).enabled, true);
    } finally {
        db.close();
    }
});

test('lists the chat models a key can use, without image or audio ones', async (t) => {
    let status = 200;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai/models');
        assert.equal(init.headers.authorization, 'Bearer AIza-k');
        const data = [{ id: 'models/gemini-pro' }, { id: 'models/text-embedding-004' }, { id: 'models/gemini-flash' }];
        return new Response(JSON.stringify({ data }), { status });
    });
    assert.deepEqual(await listModels({ provider: 'gemini', apiKey: 'AIza-k' }), ['gemini-flash', 'gemini-pro']);
    status = 401;
    await assert.rejects(listModels({ provider: 'gemini', apiKey: 'AIza-k' }), /not accepted/);
});

test('waits and retries when the AI service is busy, as long as it asks', async (t) => {
    const replies = [
        { status: 429, body: {}, headers: { 'retry-after-ms': '10' } },
        { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] } },
    ];
    t.mock.method(globalThis, 'fetch', async () => {
        const r = replies.shift();
        return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
    });
    assert.deepEqual(await askOpenAi({ provider: 'openai', apiKey: 'k', model: 'm' })('Hi'), { done: true, text: 'ok' });
    assert.equal(replies.length, 0);
});

test('reads how long to wait from the rate-limit headers', () => {
    const wait = (h) => retryWait(new Headers(h), 1);
    assert.ok(wait({ 'retry-after': '3' }) >= 3000 && wait({ 'retry-after': '3' }) < 4000);
    assert.ok(wait({ 'x-ratelimit-reset-requests': '1m3s' }) >= 63000);
    assert.ok(wait({ 'x-ratelimit-reset-requests': '250ms' }) < 1250);
    assert.ok(wait({}) >= 2000 && wait({}) < 3000);
});

test('drops rewrites that merge, split or drop lines, or slip in foreign words (seen on a Gujarati invitation)', () => {
    const invite = [
        '✨ સવિનય આમંત્રણ, 18 વર્ષના વિશ્વાસ અને આપ સૌના પ્રેમભર્યા સાથ સાથે, Pluspoint એક નવા અધ્યાયની શરૂઆત કરવા જઈ રહ્યું છે.',
        'Shriyam by Pluspoint ના શુભ પ્રારંભ પ્રસંગે આપની ઉપસ્થિતિ અને આશીર્વાદની આતુરતાપૂર્વક રાહ જોઈશું.',
        'આપ અવશ્ય પધારશો.',
        '',
        '📅 24 નવેમ્બર, 2026 | સવારે 10:00 વાગ્યે',
        '📍 Shop No. 103, 1st Floor, Krishna Empire, Near Town Hall, A.V. Road, Anand, Gujarat – 388120',
        '',
        'યોગેશ ચૌહાણ અને પરિવાર',
    ].join('\n');
    const tail = invite.split('\n').slice(3).join('\n');
    // Three lines merged into one.
    assert.equal(keepsDetails(invite, '✨ 18 વર્ષની નોંધ વચ્ચે, પ્રેમ સાથે Pluspoint નવી શરૂઆત કરે છે. Shriyam by Pluspoint ના શુભ પ્રારંભ માટે આશીર્વાદ આપો. આપ પધારો.\n' + tail), false);
    // Split into more lines, with an English word in the Gujarati.
    assert.equal(keepsDetails(invite, '✨ 18 વર્ષની સાથે, Pluspoint એક નવી યાત્રાની શરૂઆત કર રહ્યું છે.\n\nShriyam by Pluspoint નો શુભ પ્રારંભ.\n\nતમારે વ Motivation થાય.\n' + tail), false);
    // The same three lines said another way: kept.
    assert.ok(keepsDetails(invite, [
        '✨ ભાવભર્યું આમંત્રણ, 18 વર્ષના ભરોસા અને આપ સૌના પ્રેમાળ સાથ સાથે, Pluspoint એક નવા અધ્યાયની શરૂઆત કરી રહ્યું છે.',
        'Shriyam by Pluspoint ના શુભ ઉદ્ઘાટન પ્રસંગે આપની હાજરી અને આશીર્વાદની આતુરતાથી રાહ જોઈશું.',
        'આપ જરૂર પધારજો.',
    ].join('\n') + '\n' + tail));
    // English messages may still use any English words.
    assert.ok(keepsDetails('Our sale ends Sunday, visit us!', 'The sale finishes on Sunday - come and see us!'));
});
