import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';

import {
  PolicyApi,
  PolicyField,
  PolicyOverview,
  PolicyValue,
  PolicyValues,
  TenantPolicy,
} from './policy-api';

/** One field as it reads at the scope being edited. */
interface PolicyRow {
  readonly field: PolicyField;
  readonly id: string;
  /** The value the control shows: pending edit, else this scope's override, else inherited. */
  readonly value: PolicyValue;
  readonly overridden: boolean;
  readonly inherited: PolicyValue;
  /** "Platform default", "Built-in default", "Gold plan". */
  readonly inheritedFrom: string;
  readonly dirty: boolean;
}

/** Enum options become a segmented control only when they fit on one line. */
const SEG_MAX_OPTIONS = 3;
const SEG_MAX_LABEL = 14;
const FLASH_MS = 3000;

let nextId = 0;

const same = (a: PolicyValue | undefined, b: PolicyValue | undefined) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Generic, field-driven editor for platform policy (`server/src/policy`).
 *
 * The server declares every rule with its type, label and hint, so this one
 * form serves every service and every scope. Without `tenantId` it edits the
 * platform default and each billing plan (plans inherit the default); with one
 * it edits that business's overrides on top of its plan.
 *
 * Edits are kept as a patch keyed by field, so switching `service` keeps them
 * and Save sends only what changed. A reset sends `null`, which removes the
 * override and lets the layer below show through. Switching scope is blocked
 * while changes are pending, because a patch belongs to one scope.
 */
@Component({
  selector: 'app-policy-editor',
  templateUrl: './policy-editor.html',
  styleUrl: './policy-editor.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PolicyEditor {
  private readonly api = inject(PolicyApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly uid = `pe${nextId++}`;
  private flashTimer?: ReturnType<typeof setTimeout>;

  /** Service key, e.g. `whatsapp_channels`; only its fields are shown. */
  readonly service = input.required<string>();
  /** Edit one business's overrides instead of the platform default and plans. */
  readonly tenantId = input<number | null>(null);
  /** Emits the scope after a successful save. */
  readonly saved = output<string>();

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly saveError = signal('');
  protected readonly saving = signal(false);
  protected readonly flash = signal('');
  protected readonly overview = signal<PolicyOverview | null>(null);
  protected readonly tenant = signal<TenantPolicy | null>(null);
  /** Scope picked on the strip; ignored in tenant mode. */
  protected readonly pickedScope = signal('global');
  /** Pending changes for the current scope; `null` removes the override. */
  protected readonly draft = signal<Record<string, PolicyValue | null>>({});

  protected readonly plans = computed(() =>
    [...(this.overview()?.planList ?? [])].sort((a, b) => a.tier - b.tier),
  );
  protected readonly scope = computed(() => {
    const id = this.tenantId();
    return id == null ? this.pickedScope() : `tenant:${id}`;
  });
  protected readonly tenantPlan = computed(() => {
    const key = this.tenant()?.planKey;
    return key ? (this.plans().find((p) => p.key === key)?.name ?? key) : null;
  });
  protected readonly dirtyCount = computed(() => Object.keys(this.draft()).length);

  protected readonly groups = computed(() => {
    const ov = this.overview();
    if (!ov) return [];
    const scope = this.scope();
    const draft = this.draft();
    const stored = this.storedAt(ov, scope);
    const out = new Map<string, PolicyRow[]>();
    for (const field of ov.fields) {
      if (field.service !== this.service()) continue;
      const [inherited, inheritedFrom] = this.inheritedFor(ov, scope, field);
      const pending = field.key in draft;
      const own = pending ? draft[field.key] : stored[field.key];
      const row: PolicyRow = {
        field,
        id: `${this.uid}-${field.key.replace(/\W/g, '-')}`,
        value: own ?? inherited,
        overridden: own != null,
        inherited,
        inheritedFrom,
        dirty: pending,
      };
      out.set(field.group, [...(out.get(field.group) ?? []), row]);
    }
    return [...out].map(([name, rows]) => ({ name, rows }));
  });

  constructor() {
    effect(() => {
      const id = this.tenantId();
      untracked(() => this.load(id));
    });
    this.destroyRef.onDestroy(() => clearTimeout(this.flashTimer));
  }

  protected load(id = this.tenantId()) {
    this.loading.set(true);
    this.error.set('');
    this.draft.set({});
    forkJoin([this.api.overview(), id == null ? of(null) : this.api.tenant(id)])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ([overview, tenant]) => {
          this.overview.set(overview);
          this.tenant.set(tenant);
          this.loading.set(false);
        },
        error: (err: Error) => {
          this.error.set(err.message);
          this.loading.set(false);
        },
      });
  }

  protected pickScope(scope: string) {
    if (this.dirtyCount()) return;
    this.pickedScope.set(scope);
    this.saveError.set('');
  }

  /** Record an edit; an edit back to the saved value is no change at all. */
  protected set(row: PolicyRow, value: PolicyValue) {
    const ov = this.overview();
    if (!ov) return;
    const stored = this.storedAt(ov, this.scope())[row.field.key];
    const unchanged = stored === undefined ? same(value, row.inherited) : same(value, stored);
    this.draft.update((d) => {
      const { [row.field.key]: _, ...rest } = d;
      return unchanged ? rest : { ...rest, [row.field.key]: value };
    });
  }

  /** Drop this scope's override (or the pending one) so the inherited value applies. */
  protected reset(row: PolicyRow) {
    const ov = this.overview();
    if (!ov) return;
    const hasStored = row.field.key in this.storedAt(ov, this.scope());
    this.draft.update((d) => {
      const { [row.field.key]: _, ...rest } = d;
      return hasStored ? { ...rest, [row.field.key]: null } : rest;
    });
  }

  protected setNumber(row: PolicyRow, raw: string) {
    if (raw.trim() === '' || !Number.isFinite(Number(raw))) return;
    this.set(row, Number(raw));
  }

  protected setList(row: PolicyRow, raw: string) {
    this.set(
      row,
      raw
        .split('\n')
        .map((v) => v.trim())
        .filter(Boolean),
    );
  }

  protected discard() {
    this.draft.set({});
    this.saveError.set('');
  }

  protected save() {
    const scope = this.scope();
    const patch = this.draft();
    if (!Object.keys(patch).length || this.saving()) return;
    this.saving.set(true);
    this.saveError.set('');
    this.api
      .save(scope, patch)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ values }) => {
          this.applySaved(scope, values);
          this.draft.set({});
          this.saving.set(false);
          this.showFlash(`Saved ${Object.keys(patch).length} change${Object.keys(patch).length === 1 ? '' : 's'}`);
          this.saved.emit(scope);
        },
        error: (err: Error) => {
          this.saving.set(false);
          this.saveError.set(err.message);
        },
      });
  }

  protected isSeg(field: PolicyField): boolean {
    const options = field.options ?? [];
    return options.length <= SEG_MAX_OPTIONS && options.every((o) => o.label.length <= SEG_MAX_LABEL);
  }

  protected isUnlimited(row: PolicyRow): boolean {
    return row.field.unlimitedAt !== undefined && row.value === row.field.unlimitedAt;
  }

  /** Hint, source note and any extra id, so a screen reader hears the rule's context. */
  protected desc(row: PolicyRow, extra = ''): string {
    return [row.field.hint ? `${row.id}-h` : '', `${row.id}-s`, extra].filter(Boolean).join(' ');
  }

  protected asList(value: PolicyValue): string {
    return Array.isArray(value) ? value.join('\n') : String(value ?? '');
  }

  /** Short human form of a value, for the "otherwise" note under an override. */
  protected format(field: PolicyField, value: PolicyValue): string {
    if (field.type === 'bool') return value ? 'On' : 'Off';
    if (field.type === 'int' && value === field.unlimitedAt) return 'No limit';
    if (field.type === 'enum') return field.options?.find((o) => o.value === value)?.label ?? String(value);
    if (Array.isArray(value)) return value.length ? `${value.length} item${value.length === 1 ? '' : 's'}` : 'none';
    return String(value) || 'empty';
  }

  protected planScope(key: string): string {
    return `plan:${key}`;
  }

  private storedAt(ov: PolicyOverview, scope: string): PolicyValues {
    if (scope === 'global') return ov.global;
    if (scope.startsWith('plan:')) return ov.plans[scope.slice(5)] ?? {};
    return this.tenant()?.overrides ?? {};
  }

  /** The value one layer down: tenant -> its plan -> platform default -> built-in default. */
  private inheritedFor(ov: PolicyOverview, scope: string, field: PolicyField): [PolicyValue, string] {
    const key = field.key;
    if (scope.startsWith('tenant:')) {
      const planKey = this.tenant()?.planKey;
      const plan = planKey ? ov.plans[planKey] : undefined;
      if (plan && key in plan) return [plan[key], `${this.tenantPlan()} plan`];
    }
    if (scope !== 'global' && key in ov.global) return [ov.global[key], 'Platform default'];
    return [field.default, 'Built-in default'];
  }

  private applySaved(scope: string, values: PolicyValues) {
    if (scope.startsWith('tenant:')) {
      this.tenant.update((t) => (t ? { ...t, overrides: values } : t));
      return;
    }
    this.overview.update((ov) => {
      if (!ov) return ov;
      return scope === 'global'
        ? { ...ov, global: values }
        : { ...ov, plans: { ...ov.plans, [scope.slice(5)]: values } };
    });
  }

  private showFlash(text: string) {
    clearTimeout(this.flashTimer);
    this.flash.set(text);
    this.flashTimer = setTimeout(() => this.flash.set(''), FLASH_MS);
  }
}
