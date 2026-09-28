import { Component, computed, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { Store, ThemeMode } from './core/store';

/** Inline SVG, so the icons need no font, no sprite and no network. */
function icon(path: string): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

const ICONS = {
  connection: icon('<path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>'),
  campaign: icon('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l2-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z"/>'),
  history: icon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>'),
};

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly store = inject(Store);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly themes: { value: ThemeMode; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  protected readonly navigation: { path: string; label: string; icon: SafeHtml }[] = [
    { path: '/connection', label: 'Connection', icon: this.trust(ICONS.connection) },
    { path: '/campaign', label: 'Messaging & Campaign', icon: this.trust(ICONS.campaign) },
    { path: '/history', label: 'History', icon: this.trust(ICONS.history) },
  ];

  protected readonly subtitle = computed(() => {
    const connection = this.store.connection();
    if (!this.store.streamOnline()) return 'Backend not reachable';
    return connection.connected ? `Connected - ${connection.name}` : 'Not connected';
  });

  protected readonly toneColor = computed(() => {
    const tone = this.store.statusTone();
    return {
      muted: 'var(--text-muted)',
      primary: 'var(--primary)',
      warning: 'var(--warning)',
      danger: 'var(--danger)',
    }[tone];
  });

  private trust(markup: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(markup);
  }
}
