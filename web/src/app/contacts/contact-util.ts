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
