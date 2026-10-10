/** Small helpers shared by the Analytics page and its child components. */

import { Directive, ElementRef, effect, inject, input } from '@angular/core';

/** Round a chart ceiling up to 1/2/5 x 10^n so the axis labels read cleanly. */
export function niceMax(n: number) {
  if (n <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(n));
  return ([1, 2, 5, 10].find((m) => m * p >= n) ?? 10) * p;
}

/** 42 -> "42s", 300 -> "5m", 3900 -> "1h 5m", 93600 -> "1d 2h". */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return m < 10 && rest ? `${m}m ${rest}s` : `${Math.round(s / 60)}m`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** A server day key ('2026-10-10', UTC) as "10 Oct". */
export function dayLabel(key: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

/**
 * One CSV cell: quoted when it holds a quote, comma or newline, and defused
 * when it starts like a spreadsheet formula (= + - @, tab, CR).
 */
export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Hand the browser a CSV file. The BOM makes Excel read UTF-8 names correctly. */
export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const today = () => new Date().toISOString().slice(0, 10);

/**
 * `<span [countUp]="1234" [decimals]="1" suffix="%"></span>`: renders the
 * number, easing from the previous value to the new one. Null shows a dash.
 * Instant under prefers-reduced-motion.
 */
@Directive({ selector: '[countUp]' })
export class CountUp {
  readonly countUp = input<number | null | undefined>(null);
  readonly decimals = input(0);
  readonly suffix = input('');

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly still = typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  private shown = 0;
  private frame = 0;

  constructor() {
    effect((onCleanup) => {
      const target = this.countUp();
      const decimals = this.decimals();
      const suffix = this.suffix();
      const fmt = (n: number) =>
        n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
      if (target == null || !Number.isFinite(target)) {
        this.el.textContent = '—';
        this.shown = 0;
        return;
      }
      const from = this.shown;
      if (this.still || from === target) {
        this.el.textContent = fmt(target);
        this.shown = target;
        return;
      }
      const start = performance.now();
      const ms = 900;
      const tick = (t: number) => {
        const p = Math.min(1, (t - start) / ms);
        const eased = 1 - (1 - p) ** 3;
        this.shown = from + (target - from) * eased;
        this.el.textContent = fmt(p < 1 ? this.shown : target);
        if (p < 1) this.frame = requestAnimationFrame(tick);
        else this.shown = target;
      };
      this.frame = requestAnimationFrame(tick);
      onCleanup(() => cancelAnimationFrame(this.frame));
    });
  }
}
