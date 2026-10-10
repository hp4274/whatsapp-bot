# Angular conventions

The default way Angular code is written in this app. It follows the Kardlyz
codebase (`D:\Work\kardlyz`), which is the reference for both code style and
the visual language. Read this before adding or changing a component.

## Components

```ts
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { TicketsApi } from './tickets-api';

/**
 * Every customer issue in one queue.
 *
 * Say what the screen is for and why it behaves the way it does — the
 * decisions a reader cannot get from the code. Not a restatement of it.
 */
@Component({
  selector: 'app-tickets',
  imports: [],
  templateUrl: './tickets.html',
  styleUrl: './tickets.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TicketsView {
  private readonly api = inject(TicketsApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  /** Doc comment on any member whose purpose is not obvious from its name. */
  protected readonly openCount = computed(() => /* … */ 0);
}
```

- Standalone components, `changeDetection: ChangeDetectionStrategy.OnPush`
  written out explicitly, separate `templateUrl` for anything over a few lines.
- Dependencies through `inject()` as `private readonly` fields at the top of
  the class. No constructor injection.
- State is signals: `signal`, `computed`, `effect`, `linkedSignal`. Members the
  template reads are `protected readonly`; internal state is `private`. A
  service exposes state with `.asReadonly()`.
- `input()`, `input.required()`, `output()`, `model()`, `viewChild()` — never
  the decorator forms. Host listeners go in the `host: {}` metadata.
- RxJS only at the HTTP edge. Every `subscribe` in a component is piped through
  `takeUntilDestroyed(this.destroyRef)` unless it completes on its own.
- Template control flow: `@if (x(); as y)`, `@for (…; track id)`, `@empty`,
  `@else if`. No `*ngIf` / `*ngFor`.
- Existing classes keep their `…View` names; new ones may drop the suffix
  (Kardlyz names a class after the thing: `Usage`, `ConfirmDialog`).

## Services and types

- `@Injectable({ providedIn: 'root' })`, thin HTTP wrappers returning
  `Observable<T>`. One API class per feature (`tickets-api.ts`).
- Shared shapes are interfaces with `readonly` fields; import them with
  `import type`.
- Module-level constants are `SCREAMING_SNAKE`, typed `readonly T[]`, with a
  doc comment saying why the value is what it is.
- Imports: Angular, then third-party, a blank line, then app imports.

## Comments

Comments carry the *why*: a constraint, a trade-off, the bug a line prevents.
JSDoc `/** */` on classes and non-obvious members; a short HTML comment at the
top of a large template saying how it is laid out. Never narrate what the next
line does.

## Templates and accessibility

Every data screen has three states, in this order: an error banner
(`role="alert"`, with a *Try again* button), a skeleton while loading
(`aria-busy="true"`), and the content or an empty state. Icons are decorative
unless stated: `<i class="ti ti-name" aria-hidden="true"></i>`. Icon-only
buttons carry an `aria-label`. Sections are labelled with `aria-labelledby`.

## Visual language (from Kardlyz)

Tokens live in `src/styles.scss`; components never hard-code a colour.

| Role | Token |
| --- | --- |
| Brand fill, active state, focus ring | `--primary` (orange `#ed7e25`) |
| Orange as text | `--primary-text` (orange is 2.8:1 on white) |
| Primary action button | ink `--text-strong` → `--primary` on hover (`.btn.primary`) |
| Second accent | `--accent` (violet `#5f68ab`) |
| Page / card / sunken surfaces | `--bg-color` / `--surface-card` / `--surface-sunken` |
| Text | `--text-strong`, `--text-color`, `--text-muted`, `--hint` |
| Hairlines | `--border-color`, `--border-hover` |
| Status | `--success`, `--warning`, `--info`, `--danger` (fill) / `--danger-text` (type) |

Patterns:

- **Page header** (`.s-head` from `school/school-shared.scss`): 13px orange
  eyebrow, 26–32px title at weight 500 with -1px tracking, 14px muted lede, a
  hairline rule underneath, actions on the right.
- **Card**: 24px radius, 1px hairline border, card surface, no heavy shadow;
  17px weight-500 heading. Clickable cards lift with `--shadow-lift` on hover.
- **Buttons**: 38px tall, 10px radius, 13.5px weight 500. `.btn` outline,
  `.btn.primary` ink, `.btn.danger` red outline.
- **Inputs**: 12px radius, hairline border, orange border and glow on focus;
  13px weight-500 label above.
- **Tabs / segmented**: sunken track; active item on the card surface, semibold.
- **Pills**: fully rounded, 12–12.5px weight 500, tone at 12% as background.
- **Tables**: 12px `--hint` headers, 13px cells, hairline rows, sunken hover.
- **Numbers**: weight 500 with negative tracking, never bold-800.
- Font: Inter. Icons: Tabler (`ti ti-*`). Dark mode is a navy ramp; anything
  built from the tokens follows it automatically.

The one deliberate difference from Kardlyz: Kardlyz keeps all CSS in global
SCSS plus Tailwind utilities in templates. This app keeps a stylesheet per
component and shares patterns through the SCSS kit. Both read the same tokens.
