import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { StorageApi, type StorageUse, type StoredFile, type StoredKind } from './storage-api';
import { FILE_ICON, fileDetail, fileType, shortDate } from './storage-format';

/** Enough to cover "the one I used last week" without turning the wizard into a file browser. */
const RECENT = 5;

/**
 * "Or reuse a previous file": the few most recent stored files of one kind, for
 * the campaign wizard's upload steps. Picking one asks the server to re-open it
 * (`POST /storage/:id/use`) and emits the result, which the step handles exactly
 * like a fresh upload. This is a shortcut beside an upload control, so a failed
 * or empty list renders nothing rather than a banner; the step stays usable.
 */
@Component({
  selector: 'app-reuse-picker',
  imports: [RouterLink],
  templateUrl: './reuse-picker.html',
  styleUrl: './reuse-picker.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReusePicker {
  private readonly api = inject(StorageApi);

  readonly kind = input.required<StoredKind>();
  /** Storage id of the file currently in use, so its row can say so. */
  readonly activeId = input<number | null | undefined>(null);
  /** The step is busy with something else (an upload): rows are inert. */
  readonly disabled = input(false);
  readonly used = output<StorageUse>();

  protected readonly files = signal<readonly StoredFile[] | null>(null);
  protected readonly busy = signal<number | null>(null);
  protected readonly error = signal('');

  protected readonly icon = (f: StoredFile): string => FILE_ICON[fileType(f)];
  protected readonly detail = fileDetail;
  protected readonly date = shortDate;

  constructor() {
    effect(() => {
      const kind = this.kind();
      untracked(() => this.load(kind));
    });
  }

  private load(kind: StoredKind): void {
    this.api.list(kind).subscribe({
      next: ({ files }) => this.files.set(files.slice(0, RECENT)),
      error: () => this.files.set([]),
    });
  }

  protected pick(f: StoredFile): void {
    this.busy.set(f.id);
    this.error.set('');
    this.api.use(f.id).subscribe({
      next: (result) => {
        this.busy.set(null);
        this.used.emit(result);
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.error.set(err.message);
      },
    });
  }
}
