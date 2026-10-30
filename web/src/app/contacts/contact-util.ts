/** Small, pure helpers shared by the contacts page and its child components. */

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 minutes ago", "yesterday" - always paired with the absolute time in a title. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const seconds = Math.round((at - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

export function initials(name: string, phone: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length) return (words[0][0] + (words[1]?.[0] ?? '')).toUpperCase();
  return phone.slice(-2);
}

/** A stable hue per contact, so the same person always gets the same avatar. */
export function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export const displayPhone = (phone: string) => (/^\d+$/.test(phone) ? `+${phone}` : phone);

/** ITU calling codes are prefix-free: 1 and 7 are one digit, these are two, every other code is three. */
const TWO_DIGIT_CODES = new Set(
  '20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98'.split(' '),
);

/** Digits as "+91 9773444404": the country code, a space, then the national number. */
export const spacedPhone = (phone: string) => {
  if (!/^\d{8,15}$/.test(phone)) return displayPhone(phone);
  const cc = /^[17]/.test(phone) ? 1 : TWO_DIGIT_CODES.has(phone.slice(0, 2)) ? 2 : 3;
  return `+${phone.slice(0, cc)} ${phone.slice(cc)}`;
};

export function splitTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,;]/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** Hand a blob to the browser as a download. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const today = () => new Date().toISOString().slice(0, 10);
