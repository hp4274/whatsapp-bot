/** The placeholders an OTP message may use; `{code}` is required (the server rejects a template without it). */
export const OTP_PLACEHOLDERS: readonly string[] = ['{code}', '{brand}', '{minutes}'];

/** The message a customer gets: every placeholder filled, as the server fills it. */
export function renderOtp(template: string, values: { code: string; brand: string; minutes: number }): string {
  return template
    .replace(/\{code\}/g, values.code)
    .replace(/\{brand\}/g, values.brand)
    .replace(/\{minutes\}/g, String(values.minutes));
}

/** A fixed, made-up code of the chosen length for the preview, so it does not flicker on each keystroke. */
export function sampleCode(length: number): string {
  const n = Math.min(8, Math.max(4, Math.round(length) || 6));
  return '73915284'.slice(0, n);
}

export type SampleLang = 'curl' | 'node' | 'python' | 'php';

export const OTP_LANGS: readonly { readonly id: SampleLang; readonly label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'node', label: 'Node.js' },
  { id: 'python', label: 'Python' },
  { id: 'php', label: 'PHP' },
];


/** Send + verify for each language, against this server's own address. */
export function codeSamples(base: string): Record<SampleLang, string> {
  const send = `${base}/api/v1/otp/send`;
  const verify = `${base}/api/v1/otp/verify`;
  return {
    curl: `# 1. Send a code to your customer's WhatsApp
curl -X POST ${send} \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"phone": "+919876543210", "purpose": "login"}'

# 2. Check the code they typed (use the id from step 1)
curl -X POST ${verify} \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"id": "OTP_ID", "code": "123456"}'`,
    node: `const KEY = 'YOUR_API_KEY';
const headers = { Authorization: \`Bearer \${KEY}\`, 'Content-Type': 'application/json' };

// 1. Send a code to your customer's WhatsApp
const sent = await fetch('${send}', {
  method: 'POST',
  headers,
  body: JSON.stringify({ phone: '+919876543210', purpose: 'login' }),
}).then((r) => r.json());

// 2. Check the code they typed
const check = await fetch('${verify}', {
  method: 'POST',
  headers,
  body: JSON.stringify({ id: sent.id, code: '123456' }),
}).then((r) => r.json());

if (check.valid) {
  // signed in
}`,
    python: `import requests

KEY = "YOUR_API_KEY"
headers = {"Authorization": f"Bearer {KEY}"}

# 1. Send a code to your customer's WhatsApp
sent = requests.post("${send}", headers=headers,
                     json={"phone": "+919876543210", "purpose": "login"}).json()

# 2. Check the code they typed
check = requests.post("${verify}", headers=headers,
                      json={"id": sent["id"], "code": "123456"}).json()

if check["valid"]:
    pass  # signed in`,
    php: `<?php
$key = 'YOUR_API_KEY';

function wuzie(string $url, array $body, string $key): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ["Authorization: Bearer $key", 'Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode($body),
    ]);
    $res = json_decode(curl_exec($ch), true);
    curl_close($ch);
    return $res;
}

// 1. Send a code to your customer's WhatsApp
$sent = wuzie('${send}', ['phone' => '+919876543210', 'purpose' => 'login'], $key);

// 2. Check the code they typed
$check = wuzie('${verify}', ['id' => $sent['id'], 'code' => '123456'], $key);

if ($check['valid']) {
    // signed in
}`,
  };
}

/** One field of a request: its name, type, whether it must be sent, and what it does. */
export type ApiField = readonly [name: string, type: string, required: boolean, about: string];

/** One call of the OTP API, for the reference on the page. */
export interface ApiEndpoint {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly summary: string;
  readonly fields: readonly ApiField[];
  /** The HTTP status of a good answer, and an example of it. */
  readonly status: number;
  readonly answer: string;
}

/** The three calls, as the server's /v1/otp routes take and answer them (server/src/otp/routes.js). */
export const OTP_ENDPOINTS: readonly ApiEndpoint[] = [
  {
    method: 'POST',
    path: '/otp/send',
    summary: 'Sends a one-time code to the customer\'s WhatsApp, ahead of any campaign on your number. A new code cancels that number\'s older ones.',
    fields: [
      ['phone', 'string', true, 'The customer\'s number with country code, e.g. +919876543210.'],
      ['purpose', 'string', false, 'What the code is for (login, signup…), up to 60 characters. Shown in Recent codes.'],
      ['length', 'number', false, 'Digits in the code, 4 to 8. Default: your WhatsApp OTP settings.'],
      ['ttlMinutes', 'number', false, 'Minutes the code works, 1 to your plan\'s most. Default: your WhatsApp OTP settings.'],
      ['code', 'string', false, 'Your own 4-8 digit code instead of ours, if your plan allows it.'],
    ],
    status: 201,
    answer: `{
  "id": "otp_8f3a2c9e1b7d4f60",
  "phone": "919876543210",
  "status": "sent",
  "expiresAt": "2026-11-23T10:15:00.000Z",
  "resendAfter": "2026-11-23T10:05:30.000Z"
}`,
  },
  {
    method: 'POST',
    path: '/otp/verify',
    summary: 'Checks the code the customer typed. Send the id from the send, or the phone (its newest code).',
    fields: [
      ['id', 'string', false, 'The id the send answered with. Give this or phone.'],
      ['phone', 'string', false, 'The customer\'s number, when you did not keep the id.'],
      ['code', 'string', true, 'What the customer typed.'],
    ],
    status: 200,
    answer: `{ "valid": true, "id": "otp_8f3a2c9e1b7d4f60" }

{ "valid": false, "reason": "wrong_code", "attemptsLeft": 4 }`,
  },
  {
    method: 'GET',
    path: '/otp/{id}',
    summary: 'Where a code stands, without using up a try.',
    fields: [],
    status: 200,
    answer: `{
  "id": "otp_8f3a2c9e1b7d4f60",
  "status": "verified",
  "expiresAt": "2026-11-23T10:15:00.000Z",
  "verifiedAt": "2026-11-23T10:06:12.000Z",
  "attempts": 1
}`,
  },
];

/** Why a verify said no (`reason`), and what to tell the customer. */
export const VERIFY_REASONS: readonly (readonly [string, string])[] = [
  ['wrong_code', 'Not the code. `attemptsLeft` says how many tries remain.'],
  ['too_many_attempts', 'Out of tries: the code no longer works. Send a new one.'],
  ['expired', 'The code ran out of time. Send a new one.'],
  ['already_used', 'This code was already verified once.'],
  ['not_found', 'No such code (or it never went out). Check the id or phone.'],
];

/** What GET /otp/{id} answers as `status`. */
export const OTP_STATUSES: readonly (readonly [string, string])[] = [
  ['pending', 'Sent and waiting for the customer.'],
  ['verified', 'The right code was typed.'],
  ['expired', 'Its time ran out before it was verified.'],
  ['blocked', 'Too many wrong tries.'],
  ['failed', 'WhatsApp would not take it (see the send\'s send_failed).'],
];

/** What the guide file needs beyond the reference: where to call, this account's limits, the error table. */
export interface GuideInput {
  readonly base: string;
  /** The business's name and limits, when a signed-in owner downloads it; the public page has neither. */
  readonly business?: string;
  readonly limits?: string;
}


/** Text into HTML safely, with `backticked` words as code, as the page writes them. */
const html = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/`([^`]+)`/g, '<code>$1</code>');

/**
 * The developer guide as one printable page (the browser saves it as a PDF), from the same data the page shows, so
 * the two never disagree: connect, the three calls, verify reasons, statuses, errors and the code samples.
 */
export function otpGuideHtml({ base, business = '', limits = '' }: GuideInput): string {
  const title = `WhatsApp OTP API guide${business ? ` - ${business}` : ''}`;
  const table = (head: readonly string[], rows: readonly (readonly string[])[]) =>
    `<table><thead><tr>${head.map((h) => `<th>${html(h)}</th>`).join('')}</tr></thead><tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${html(c)}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`;
  const code = (text: string) => `<pre>${html(text).replace(/<code>|<\/code>/g, '`')}</pre>`;
  const samples = codeSamples(base);
  const facts: [string, string][] = [
    ['Address', `\`${base}/api/v1\``],
    ['Key', 'Send it as `Authorization: Bearer YOUR_API_KEY` (or the `X-API-Key` header). Keys start with `wsk_`; only keys made on the WhatsApp OTP page can send codes. Keep the key on your server, never in an app or a web page.'],
    ['Format', 'JSON in, JSON out (`Content-Type: application/json`). Errors answer `error` and `message`.'],
    ['Safe retries', 'Add an `Idempotency-Key` header (any unique text) to a send. Sent again after a timeout, it answers the first result instead of sending a second code.'],
    ...(limits ? [['Your limits', `${limits}.`] as [string, string]] : []),
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><title>${html(title)}</title><style>
  html { color-scheme: light; background: #fff; }
  body { font: 12.5px/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #16161d; margin: 28px 32px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 26px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ddd; }
  h3 { font-size: 13.5px; margin: 18px 0 6px; } p { margin: 0 0 8px; } .lede { color: #555; margin-bottom: 14px; }
  .verb { display: inline-block; padding: 1px 7px; margin-right: 6px; border-radius: 4px; font: 600 11px monospace; background: #e7f6ee; color: #0f7a4c; }
  .verb.get { background: #e6f0fd; color: #2f80ed; }
  dl { margin: 0; } dl div { display: grid; grid-template-columns: 110px 1fr; gap: 10px; padding: 5px 0; border-bottom: 1px solid #eee; }
  dt { font-weight: 600; } dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 12.5px; } th, td { text-align: left; vertical-align: top; padding: 5px 8px; border-bottom: 1px solid #e3e3e8; }
  th { font-weight: 600; background: #f5f5f8; }
  code { font: 11.5px monospace; background: #f1f1f5; padding: 0 3px; border-radius: 3px; }
  pre { font: 11px/1.5 monospace; background: #f5f5f8; border: 1px solid #e3e3e8; border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; margin: 6px 0 12px; }
  h2, h3 { break-after: avoid; } tr, pre, dl div { break-inside: avoid; }
</style></head><body>
<h1>${html(title)}</h1>
<p class="lede">Send a one-time code to a customer's WhatsApp from your own app or website, then check the code they type.</p>
<h2>Connect</h2>
<dl>${facts.map(([k, v]) => `<div><dt>${html(k)}</dt><dd>${html(v)}</dd></div>`).join('')}</dl>
<h2>Calls</h2>
${OTP_ENDPOINTS.map((e) => `<h3><span class="verb${e.method === 'GET' ? ' get' : ''}">${e.method}</span><code>/api/v1${html(e.path)}</code></h3>
<p>${html(e.summary)}</p>
${e.fields.length ? table(['Field', 'Type', 'Required', 'What it does'], e.fields.map((f) => [`\`${f[0]}\``, f[1], f[2] ? 'Yes' : 'No', f[3]])) : ''}
<p>Answer (${e.status}):</p>${code(e.answer)}`).join('\n')}
<h2>When a verify says no</h2>
${table(['reason', 'Means'], VERIFY_REASONS.map(([r, m]) => [`\`${r}\``, m]))}
<h2>Code status</h2>
${table(['status', 'Means'], OTP_STATUSES.map(([s, m]) => [`\`${s}\``, m]))}
<h2>Errors</h2>
${table(['HTTP', 'error', 'Means'], OTP_ERRORS.map(([h, e, m]) => [String(h), `\`${e}\``, m]))}
<h2>Examples</h2>
<h3>cURL</h3>${code(samples.curl)}
<h3>Node.js</h3>${code(samples.node)}
<h3>Python</h3>${code(samples.python)}
<h3>PHP</h3>${code(samples.php)}
</body></html>`;
}

/** The public API's error answers, for the developer reading the samples. */
export const OTP_ERRORS: readonly (readonly [number, string, string])[] = [
  [401, 'invalid_api_key', 'No key, a wrong one, a revoked one, or one past its age limit.'],
  [403, 'ip_not_allowed', 'Your account only takes API calls from listed addresses, and this is not one.'],
  [409, 'idempotency_key_reused', 'That Idempotency-Key was already used for a different call.'],
  [400, 'invalid_phone', 'The number is not a valid phone number.'],
  [400, 'invalid_code', 'Your own `code` must be 4 to 8 digits; a verify needs a code.'],
  [400, 'invalid_request', '`length` or `ttlMinutes` is not a whole number.'],
  [403, 'otp_not_enabled', 'WhatsApp OTP is not on your plan.'],
  [403, 'tenant_blocked', 'Sending is switched off for your account.'],
  [403, 'insufficient_scope', 'The key cannot send codes. Use a key made on the WhatsApp OTP page.'],
  [403, 'custom_code_not_allowed', 'You sent your own `code`, which your plan does not allow.'],
  [409, 'channel_unavailable', 'Your number is paused, outside its sending hours, or cannot send this.'],
  [422, 'send_failed', 'The code was made but WhatsApp would not take it (e.g. the number opted out). `id` says which.'],
  [429, 'resend_too_soon', 'Asked again too quickly. Wait `retryAfter` seconds.'],
  [429, 'phone_rate_limited', 'Too many codes to this number in the last hour.'],
  [429, 'monthly_limit', 'This month\'s codes are used up.'],
  [503, 'whatsapp_not_connected', 'Your WhatsApp number is offline. Link it again.'],
];

/**
 * Print the guide from a hidden frame: the print dialog's "Save as PDF" makes the file (as the number lists do,
 * admin/number-collections.ts), so no PDF library is needed. The frame's title is the suggested file name.
 */
export function printOtpGuide(input: GuideInput): void {
  const frame = Object.assign(document.createElement('iframe'), { title: 'API guide' });
  frame.style.cssText = 'position: fixed; width: 0; height: 0; border: 0';
  document.body.append(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) return frame.remove();
  doc.open();
  doc.write(otpGuideHtml(input));
  doc.close();
  doc.title = 'wuzie-whatsapp-otp-api-guide';
  win.addEventListener('afterprint', () => frame.remove());
  win.print();
}
