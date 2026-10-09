import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin, of } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';

import {
  Api,
  AutoReplyMatchType,
  AutoReplyRule,
  AutoReplyRulePayload,
} from '../core/api';
import { Store } from '../core/store';

interface AutoReplyForm {
  id: number | null;
  keyword: string;
  matchType: AutoReplyMatchType;
  replyBody: string;
  isActive: boolean;
  cooldownSec: number;
}

const EMPTY_FORM: AutoReplyForm = {
  id: null,
  keyword: '',
  matchType: 'CONTAINS',
  replyBody: '{time_greeting} {name}, thank you for contacting us.',
  isActive: true,
  cooldownSec: 0,
};

const MATCH_TYPES: { value: AutoReplyMatchType; label: string; hint: string }[] = [
  { value: 'EXACT', label: 'Exact', hint: 'The incoming message must equal the keyword.' },
  { value: 'CONTAINS', label: 'Contains', hint: 'The keyword can appear anywhere in the message.' },
  { value: 'REGEX', label: 'Regex', hint: 'Use a JavaScript regular expression.' },
  { value: 'FALLBACK', label: 'Fallback', hint: 'Used when no keyword rule matches.' },
];

@Component({
  selector: 'app-auto-replies',
  imports: [FormsModule],
  templateUrl: './auto-replies.html',
  styleUrl: './auto-replies.scss',
})
export class AutoRepliesView {
  private readonly api = inject(Api);
  protected readonly store = inject(Store);

  protected readonly rules = signal<AutoReplyRule[]>([]);
  protected readonly form = signal<AutoReplyForm>({ ...EMPTY_FORM });
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly bulkSaving = signal(false);
  protected readonly notice = signal('');
  protected readonly errors = signal<string[]>([]);
  protected readonly preview = signal('');
  protected readonly previewing = signal(false);
  protected readonly testText = signal('Hi, I need pricing details');
  protected readonly testSender = signal('919876543210');
  protected readonly testName = signal('Aarav');
  protected readonly matchTypes = MATCH_TYPES;

  protected readonly activeCount = computed(() => this.rules().filter((rule) => rule.isActive).length);
  protected readonly inactiveCount = computed(() => this.rules().length - this.activeCount());
  protected readonly allDisabled = computed(() => this.rules().length > 0 && this.activeCount() === 0);
  protected readonly connected = computed(() => this.store.connection().connected);

  protected readonly matchedRule = computed(() => this.findMatch(this.testText(), this.rules()));

  protected readonly formTitle = computed(() =>
    this.form().id === null ? 'Create Keyword Reply' : 'Edit Keyword Reply');

  constructor() {
    this.load();
    this.store.watch(['auto-replies'], () => this.load(true));
  }

  protected load(quiet = false): void {
    if (!quiet) {
      this.loading.set(true);
      this.errors.set([]);
    }
    this.api.autoReplies().subscribe({
      next: ({ rules }) => {
        this.rules.set(rules);
        if (!quiet && rules[0] && this.form().id === null) this.edit(rules[0]);
        this.loading.set(false);
      },
      error: (err: Error) => {
        if (!quiet) this.errors.set(err.message.split('\n'));
        this.loading.set(false);
      },
    });
  }

  protected createNew(): void {
    this.form.set({ ...EMPTY_FORM });
    this.preview.set('');
    this.notice.set('');
  }

  protected edit(rule: AutoReplyRule): void {
    this.form.set({
      id: rule.id,
      keyword: rule.keyword,
      matchType: rule.matchType,
      replyBody: rule.replyBody,
      isActive: rule.isActive,
      cooldownSec: rule.cooldownSec,
    });
    this.preview.set('');
    this.notice.set('');
  }

  protected update<K extends keyof AutoReplyForm>(key: K, value: AutoReplyForm[K]): void {
    this.form.update((current) => {
      const next = { ...current, [key]: value };
      if (key === 'matchType' && value === 'FALLBACK') next.keyword = '';
      return next;
    });
  }

  protected save(): void {
    const form = this.form();
    const payload = this.toPayload(form);
    const request = form.id === null
      ? this.api.createAutoReply(payload)
      : this.api.updateAutoReply(form.id, payload);

    this.saving.set(true);
    this.errors.set([]);
    request.subscribe({
      next: ({ rule }) => {
        this.upsert(rule);
        this.edit(rule);
        this.saving.set(false);
        this.store.setStatus(`Auto-reply saved: ${this.ruleLabel(rule)}`, 'primary');
      },
      error: (err: Error) => {
        this.errors.set(err.message.split('\n'));
        this.saving.set(false);
      },
    });
  }

  protected toggle(rule: AutoReplyRule): void {
    this.api.updateAutoReply(rule.id, { isActive: !rule.isActive }).subscribe({
      next: ({ rule: saved }) => {
        this.upsert(saved);
        if (this.form().id === saved.id) this.edit(saved);
        this.store.setStatus(`${this.ruleLabel(saved)} ${saved.isActive ? 'enabled' : 'disabled'}.`);
      },
      error: (err: Error) => this.errors.set(err.message.split('\n')),
    });
  }

  protected setAll(active: boolean): void {
    const targets = this.rules().filter((rule) => rule.isActive !== active);
    if (!targets.length) return;
    this.bulkSaving.set(true);
    this.errors.set([]);
    forkJoin(targets.map((rule) =>
      this.api.updateAutoReply(rule.id, { isActive: active }).pipe(catchError((err: Error) => of(err)))))
      .pipe(finalize(() => this.bulkSaving.set(false)))
      .subscribe((results) => {
        const errors = results.filter((result): result is Error => result instanceof Error);
        const saved = results.filter((result): result is { rule: AutoReplyRule } => !(result instanceof Error));
        saved.forEach(({ rule }) => this.upsert(rule));
        if (errors.length) {
          this.errors.set(errors.map((err) => err.message));
          return;
        }
        this.store.setStatus(active ? 'Auto-replies enabled.' : 'Auto-replies disabled.');
      });
  }

  protected delete(rule: AutoReplyRule): void {
    this.api.deleteAutoReply(rule.id).subscribe({
      next: () => {
        this.rules.update((rules) => rules.filter((item) => item.id !== rule.id));
        if (this.form().id === rule.id) this.createNew();
        this.store.setStatus(`Deleted auto-reply: ${this.ruleLabel(rule)}.`, 'warning');
      },
      error: (err: Error) => this.errors.set(err.message.split('\n')),
    });
  }

  protected renderPreview(rule = this.form()): void {
    this.previewing.set(true);
    this.preview.set('');
    this.api.previewAutoReply(rule.replyBody, this.testSender(), this.testName()).subscribe({
      next: ({ preview }) => {
        this.preview.set(preview);
        this.previewing.set(false);
      },
      error: (err: Error) => {
        this.errors.set(err.message.split('\n'));
        this.previewing.set(false);
      },
    });
  }

  protected ruleLabel(rule: Pick<AutoReplyRule, 'matchType' | 'keyword'>): string {
    return rule.matchType === 'FALLBACK' ? 'Fallback' : rule.keyword;
  }

  private toPayload(form: AutoReplyForm): AutoReplyRulePayload {
    return {
      keyword: form.matchType === 'FALLBACK' ? '' : form.keyword.trim(),
      matchType: form.matchType,
      replyBody: form.replyBody.trim(),
      isActive: form.isActive,
      cooldownSec: Number(form.cooldownSec) || 0,
    };
  }

  private upsert(rule: AutoReplyRule): void {
    this.rules.update((rules) => {
      const exists = rules.some((item) => item.id === rule.id);
      const next = exists ? rules.map((item) => item.id === rule.id ? rule : item) : [...rules, rule];
      return next.sort((a, b) => a.id - b.id);
    });
  }

  private findMatch(text: string, rules: AutoReplyRule[]): AutoReplyRule | null {
    const normalized = normalize(text);
    if (!normalized) return null;
    const active = rules.filter((rule) => rule.isActive);
    for (const rule of active) {
      const type = rule.matchType;
      if (type === 'FALLBACK') continue;
      const keyword = normalize(rule.keyword);
      if (type === 'EXACT' && normalized === keyword) return rule;
      if (type === 'CONTAINS' && keyword && normalized.includes(keyword)) return rule;
      if (type === 'REGEX') {
        try {
          if (new RegExp(rule.keyword, 'i').test(normalized)) return rule;
        } catch {
          continue;
        }
      }
    }
    return active.find((rule) => rule.matchType === 'FALLBACK') ?? null;
  }
}

function normalize(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
