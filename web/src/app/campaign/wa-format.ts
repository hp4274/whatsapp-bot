/**
 * Pure helpers for the campaign composer preview.
 *
 * `substitute` mirrors the server's renderMessage (server/src/campaign/importer.js
 * + protocol.js personalize + campaign/spintax.js) closely enough that the phone
 * preview tells the truth, but instead of silently dropping an unfilled
 * placeholder it highlights it so the operator can fix it before sending.
 *
 * Output markup is limited to b / i / s / code / br / mark so Angular's own
 * sanitiser leaves it intact.
 */

const MISS_OPEN = '\u0001';
const MISS_CLOSE = '\u0002';
const CODE_MARK = '\u0003';

const ESC_OPEN = '\u0004';
const ESC_CLOSE = '\u0005';
const ESC_PIPE = '\u0006';

export const blank = (v: unknown): boolean => v === undefined || v === null || String(v).trim() === '';

export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** WhatsApp markdown to safe HTML: escape first, then *bold* _italic_ ~strike~ ```mono```. */
export function waToHtml(text: string): string {
  let html = escapeHtml(text);
  // Monospace first, stashed so its contents are not formatted again.
  const code: string[] = [];
  html = html.replace(/```([\s\S]+?)```/g, (_m, inner: string) => {
    code.push(inner);
    return `${CODE_MARK}${code.length - 1}${CODE_MARK}`;
  });
  html = html
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1<b>$2</b>')
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w~])~(?=\S)([^~\n]*?\S)~(?!\w)/g, '$1<s>$2</s>');
  html = html.replace(new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, 'g'), (_m, i: string) => `<code>${code[Number(i)]}</code>`);
  return html.replace(/\r?\n/g, '<br>');
}

/** Small deterministic PRNG (mulberry32), so one seed always gives the same variants. */
function rng(seed: number): () => number {
  let a = (Math.floor(seed) >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Port of server parseSpintax: innermost `{a|b}` groups first, choice drawn from the seed. */
export function resolveSpintax(text: string, seed = 0): string {
  if (!text) return '';
  const next = rng(seed);
  let source = text.replace(/\\\{/g, ESC_OPEN).replace(/\\\}/g, ESC_CLOSE).replace(/\\\|/g, ESC_PIPE);
  for (let guard = 0; guard < 500; guard++) {
    const group = innermostGroup(source);
    if (!group) break;
    const choices = source.slice(group.start + 1, group.end).split('|');
    const index = Math.min(choices.length - 1, Math.floor(next() * choices.length));
    source = source.slice(0, group.start) + (choices[index] ?? '').trim() + source.slice(group.end + 1);
  }
  return source.replaceAll(ESC_OPEN, '{').replaceAll(ESC_CLOSE, '}').replaceAll(ESC_PIPE, '|');
}

function innermostGroup(text: string): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') start = i;
    else if (text[i] === '}' && start !== -1) {
      if (text.slice(start + 1, i).includes('|')) return { start, end: i };
      start = -1;
    }
  }
  return null;
}

/** A context where every empty value takes its fallback (server withFallbacks). */
export function withFallbacks(context: Record<string, string>, fallbacks: Record<string, string> = {}): Record<string, string> {
  const out = { ...context };
  for (const [key, value] of Object.entries(fallbacks ?? {})) {
    if (blank(out[key]) && !blank(value)) out[key] = String(value);
  }
  return out;
}

export interface Rendered {
  /** Safe HTML with WhatsApp formatting and unresolved keys wrapped in <mark class="missing">. */
  html: string;
  /** Plain text as the recipient would see it (unresolved keys left as `{key}`). */
  text: string;
  /** Keys nothing filled, in order of first appearance. */
  missing: string[];
}

/**
 * Personalise `text` for one contact: `{key|inline fallback}`, spintax (seeded),
 * then `{key}` from the contact, then the campaign fallbacks.
 */
export function substitute(
  text: string,
  context: Record<string, string>,
  fallbacks: Record<string, string> = {},
  seed = 0,
): Rendered {
  const ctx = withFallbacks(context ?? {}, fallbacks);
  const missing: string[] = [];
  const inline = String(text ?? '').replace(/\{(\w+)\|([^{}]*)\}/g, (match, key: string, fallback: string) => {
    if (!Object.prototype.hasOwnProperty.call(ctx, key)) return match; // spintax, not a fallback
    return blank(ctx[key]) ? fallback : String(ctx[key]);
  });
  const spun = resolveSpintax(inline, seed);
  const marked = spun.replace(/\{(\w+)\}/g, (_m, key: string) => {
    if (!blank(ctx[key])) return String(ctx[key]);
    if (!missing.includes(key)) missing.push(key);
    return `${MISS_OPEN}${key}${MISS_CLOSE}`;
  }).trim();
  const plain = marked.replace(new RegExp(`${MISS_OPEN}(\\w+)${MISS_CLOSE}`, 'g'), '{$1}');
  const html = waToHtml(marked)
    .replace(new RegExp(`${MISS_OPEN}(\\w+)${MISS_CLOSE}`, 'g'), '<mark class="missing">{$1}</mark>');
  return { html, text: plain, missing };
}

/** Plain `{key}` placeholders in a template (spintax and inline-fallback groups excluded). */
export function plainPlaceholders(text: string): string[] {
  return [...new Set([...String(text ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
}

/** True when the text varies per recipient: spintax or any placeholder. */
export function hasVariation(text: string): boolean {
  return /\{[^{}]*\|[^{}]*\}/.test(text) || /\{\w+\}/.test(text);
}

// ---- Meta approved templates (mirror of server/src/messaging/templateSend.js) ----
const SLOT = /\{\{\s*(\d+)\s*\}\}/g;

/** Highest {{n}} in an approved body: how many body parameters Meta expects. */
export function slotCount(body: string): number {
  let max = 0;
  for (const [, n] of String(body ?? '').matchAll(SLOT)) max = Math.max(max, Number(n));
  return max;
}

/** One slot's value: the contact's variable, else the slot fallback (server `fill`). */
export function fillSlot(slot: { var?: string; fallback?: string } | null | undefined, context: Record<string, string>): string {
  if (!slot) return '';
  const key = String(slot.var ?? '').trim();
  const value = key ? context[key] : undefined;
  return String(blank(value) ? (slot.fallback ?? '') : value).trim();
}

/** The approved body with {{n}} filled for one contact (server `renderTemplateText`); empty slots stay `{{n}}`. */
export function renderTemplateText(
  body: string,
  slots: ({ var?: string; fallback?: string } | null | undefined)[],
  context: Record<string, string>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = String(body ?? '').replace(SLOT, (match, n: string) => {
    const value = fillSlot(slots[Number(n) - 1], context);
    if (!value && !missing.includes(match)) missing.push(match);
    return value || match;
  });
  return { text, missing };
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Offset (ms) of `timeZone` from UTC at instant `utcMs`. */
function tzOffset(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant of a wall-clock date + time in `timeZone`; null when the input is incomplete. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  const t = /^(\d{1,2}):(\d{2})/.exec(time ?? '');
  if (!d || !t) return null;
  const guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  try {
    const first = tzOffset(guess, timeZone);
    let utc = guess - first;
    const second = tzOffset(utc, timeZone);
    if (second !== first) utc = guess - second; // crossed a DST change
    return new Date(utc);
  } catch {
    return null; // unknown time zone
  }
}
