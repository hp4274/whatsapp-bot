import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { PolicyCell, PolicyColumn, PolicyField, PolicyTableRow, PolicyValue } from './policy-api';

/** One cell as the grid draws it. */
interface GridCell {
  readonly col: PolicyColumn;
  readonly value: PolicyCell;
  readonly readOnly: boolean;
  /** Differs from the layer below (plan, platform default or built-in). */
  readonly differs: boolean;
}

/** The parts of a `need` cell, in the order the column label names them. */
const NEED_PARTS: readonly string[] = ['days', 'delivered', 'bulk'];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const asRows = (value: PolicyValue): PolicyTableRow[] =>
  Array.isArray(value) ? (value as PolicyTableRow[]).filter((r) => r && typeof r === 'object') : [];

/**
 * Same rows, cell by cell. Not a whole-table JSON compare: the server rebuilds
 * saved rows in column order, which is not the built-in rows' key order.
 */
export function sameTable(a: PolicyValue, b: PolicyValue, columns: readonly PolicyColumn[]): boolean {
  const x = asRows(a);
  const y = asRows(b);
  return x.length === y.length && x.every((row, i) => columns.every((c) => same(row[c.key], y[i][c.key])));
}

/**
 * Grid editor for a `table` policy field (the QR sending levels).
 *
 * The row count is fixed by the server (row i is level i), so there is no add
 * or remove: only cells change. Fixed columns and cells whose built-in value is
 * null (level 0's "needs") are read-only because
 * the server keeps them whatever is sent. Number cells commit on `change`, not
 * on every keystroke, so a half-typed decimal is never rewritten under the
 * cursor. Every edit emits a whole new array; the policy editor treats it like
 * any other value.
 *
 * These tables decide how fast numbers send, so cells that differ from the
 * layer below are marked and a table that no longer matches the built-in one
 * carries a warning.
 */
@Component({
  selector: 'app-policy-table',
  templateUrl: './policy-table.html',
  styleUrl: './policy-table.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PolicyTable {
  readonly field = input.required<PolicyField>();
  readonly value = input.required<PolicyValue>();
  /** What applies without an override at this scope, for the per-cell marks. */
  readonly inherited = input.required<PolicyValue>();
  /** Where `inherited` comes from: "Platform default", "Gold plan", "Built-in default". */
  readonly inheritedFrom = input('');
  /** Ids of the field's label, hint and source note. */
  readonly labelledBy = input('');
  readonly describedBy = input('');
  readonly changed = output<PolicyTableRow[]>();

  protected readonly needParts = NEED_PARTS;
  protected readonly columns = computed(() => this.field().columns ?? []);
  protected readonly grid = computed(() => {
    const base = asRows(this.field().default);
    const below = asRows(this.inherited());
    const cols = this.columns();
    return asRows(this.value()).map((row, i) => ({
      label: this.rowLabel(row, i),
      cells: cols.map(
        (col): GridCell => ({
          col,
          value: row[col.key] ?? null,
          readOnly: !!col.fixed || base[i]?.[col.key] === null,
          differs: !same(row[col.key], below[i]?.[col.key]),
        }),
      ),
    }));
  });
  protected readonly differsFromBuiltIn = computed(
    () => !sameTable(this.value(), this.field().default, this.columns()),
  );
  protected readonly changedCells = computed(() =>
    this.grid().reduce((n, row) => n + row.cells.filter((c) => c.differs).length, 0),
  );

  /*
   * A cleared or unreadable input changes nothing, so it is put back to the
   * model value: the box always shows what Save will store.
   */
  protected setNumber(i: number, col: PolicyColumn, el: HTMLInputElement) {
    const n = this.parse(el.value);
    if (n !== null) this.setCell(i, col.key, n);
    else el.value = String(this.cell(i, col) ?? '');
  }

  protected setText(i: number, col: PolicyColumn, el: HTMLInputElement) {
    if (el.value.trim()) this.setCell(i, col.key, el.value.trim());
    else el.value = String(this.cell(i, col) ?? '');
  }

  /** One end of a `range` cell (0 = from, 1 = to). */
  protected setRange(i: number, col: PolicyColumn, end: 0 | 1, el: HTMLInputElement) {
    const n = this.parse(el.value);
    const cur = this.cell(i, col);
    if (!Array.isArray(cur)) return;
    if (n === null) el.value = String(cur[end]);
    else this.setCell(i, col.key, end === 0 ? [n, cur[1]] : [cur[0], n]);
  }

  /** One part of a `need` cell (`days`, `delivered` or `bulk`). */
  protected setNeed(i: number, col: PolicyColumn, part: string, el: HTMLInputElement) {
    const n = this.parse(el.value);
    const cur = this.cell(i, col);
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return;
    if (n === null) el.value = String(cur[part] ?? '');
    else this.setCell(i, col.key, { ...cur, [part]: n });
  }

  private cell(i: number, col: PolicyColumn): PolicyCell | undefined {
    return this.grid()[i]?.cells.find((c) => c.col.key === col.key)?.value;
  }

  protected setCell(i: number, key: string, cell: PolicyCell) {
    this.changed.emit(asRows(this.value()).map((row, j) => (j === i ? { ...row, [key]: cell } : row)));
  }

  protected range(cell: PolicyCell): number[] {
    return Array.isArray(cell) ? cell : [0, 0];
  }

  protected need(cell: PolicyCell, part: string): number | null {
    return cell && typeof cell === 'object' && !Array.isArray(cell) ? (cell[part] ?? null) : null;
  }

  /** Read-only cells: "—" for null, "6 – 8" for a range, "3 / 8 / 0" for needs. */
  protected show(cell: PolicyCell): string {
    if (cell === null || cell === undefined) return '—';
    if (typeof cell === 'boolean') return cell ? 'Yes' : 'No';
    if (Array.isArray(cell)) return cell.join(' – ');
    if (typeof cell === 'object') return NEED_PARTS.map((p) => cell[p] ?? '—').join(' / ');
    return String(cell);
  }

  protected step(col: PolicyColumn): string {
    return col.type === 'num' || col.type === 'range' ? 'any' : '1';
  }

  /** "Level 3 · Building": the fixed id column plus the name, so every cell's label says which row it is in. */
  private rowLabel(row: PolicyTableRow, i: number): string {
    const id = this.columns().find((c) => c.fixed);
    const name = this.columns().find((c) => c.type === 'text');
    const head = id ? `${id.label} ${row[id.key]}` : `Row ${i + 1}`;
    return name && row[name.key] ? `${head} · ${row[name.key]}` : head;
  }

  private parse(raw: string): number | null {
    if (raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
}
