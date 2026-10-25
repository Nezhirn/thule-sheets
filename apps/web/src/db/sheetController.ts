/**
 * Shows a PostgreSQL table in a Univer sheet and turns cell edits into database changes.
 *
 * - Rows are fetched from the server in blocks as the user scrolls; sorting and filtering
 *   run on the server, so the sheet only ever holds a window of the table.
 * - Edits stay local until `save()`: changed cells, new rows (typed below the last row)
 *   and rows marked for deletion are highlighted and sent in one transaction.
 * - Edits that cannot be saved (primary key, generated columns, formulas, structure
 *   changes such as inserting columns) are rejected before Univer applies them.
 */
import { BooleanNumber, CommandType, type ICellData, type IStyleData } from '@univerjs/core';

import {
  api as http,
  ApiError,
  type DbChangeError,
  type DbChanges,
  type DbColumn,
  type DbTableInfo,
  type RowKey,
  type RowsRequest,
} from '../api/client';
import type { FUniver } from '../editor/univer';

type Text = string | null;

const BLOCK = 500;
// Blank rows kept below the data for typing new rows.
const NEW_ROWS_BUFFER = 20;
const MAX_ROWS = 1_000_000;
const SHEET_ID = 'db';
const SET_RANGE_VALUES = 'sheet.mutation.set-range-values';
const SET_ROW_COUNT = 'sheet.mutation.set-worksheet-row-count';
// Mutations a user may trigger on a database sheet. Anything else (insert/remove/move rows
// or columns, merges, sheet changes, number formats, rules) cannot be saved to the table.
const ALLOWED_MUTATIONS = new Set([
  SET_RANGE_VALUES,
  'sheet.mutation.set-worksheet-col-width',
  'sheet.mutation.set-worksheet-row-height',
  'sheet.mutation.set-worksheet-row-auto-height',
  'sheet.mutation.set-worksheet-row-is-auto-height',
  'sheet.mutation.set-frozen',
]);
const SCROLL_OPERATIONS = new Set(['sheet.operation.set-scroll', 'sheet.operation.scroll-to-cell', 'sheet.operation.scroll-to-range']);
// Canvas colors are inverted in dark mode: these light colors render as dark tints.
const EDITED: IStyleData = { bg: { rgb: '#FDE68A' } };
const INSERTED: IStyleData = { bg: { rgb: '#BBF7D0' } };
const DELETED: IStyleData = { bg: { rgb: '#FECACA' }, st: { s: BooleanNumber.TRUE }, cl: { rgb: '#6B7280' } };

export interface Query {
  sort: RowsRequest['sort'];
  filters: RowsRequest['filters'];
}

export interface SheetState {
  loading: boolean;
  total: number;
  totalExact: boolean;
  truncated: boolean;
  edited: number;
  inserted: number;
  deleted: number;
}

interface Column {
  info: DbColumn;
  numeric: boolean;
  /** Not editable in existing rows. */
  locked: boolean;
  base: IStyleData;
}

export interface ControllerOptions {
  connectionId: string;
  schema: string;
  table: string;
  meta: DbTableInfo;
  onState: (state: SheetState) => void;
  onNotice: (message: string, kind?: 'error' | 'success') => void;
}

function display(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function isSafeNumber(text: string): boolean {
  return /^-?\d{1,15}(\.\d+)?$/.test(text) && Number.isFinite(Number(text));
}

function numberPattern(type: string): string | undefined {
  const scale = /^numeric\(\d+,\s*(\d+)\)$/.exec(type)?.[1];
  return scale && Number(scale) > 0 ? `0.${'0'.repeat(Number(scale))}` : undefined;
}

export class DbSheetController {
  private readonly columns: Column[];
  private unitId = '';
  private query: Query = { sort: [], filters: [] };
  private generation = 0;
  private internal = false;
  private disposers: Array<() => void> = [];

  private total = 0;
  private totalExact = true;
  private truncated = false;
  private rowCount = 0;
  private loading = false;
  private loaded = new Set<number>();
  private pending = new Set<number>();
  /** Server text of loaded rows, by sheet row. */
  private original = new Map<number, Text[]>();
  /** What was written into the cells for loaded rows (display form), by sheet row. */
  private shown = new Map<number, string[]>();
  private keys = new Map<number, RowKey>();
  /** Changed cells of existing rows: sheet row -> column -> current display value. */
  private edits = new Map<number, Map<number, string>>();
  /** Non-empty cells of new rows (at and below `total`). */
  private added = new Map<number, Map<number, string>>();
  private deleted = new Set<number>();
  /** A save request is in flight: edits are refused so nothing typed meanwhile is lost. */
  private saving = false;
  /** Saved, but the sheet could not be re-read: it no longer matches the table. */
  private stale = false;
  /** While the count is an estimate: rows proven to exist, and an offset proven empty. */
  private knownRows = 0;
  private emptyFrom = Infinity;
  private seeking = false;
  private lastNotice = '';
  private lastNoticeAt = 0;

  constructor(
    private readonly api: FUniver,
    private readonly options: ControllerOptions,
  ) {
    const { meta } = options;
    const pk = new Set(meta.primary_key);
    this.columns = meta.columns.map((info) => {
      const numeric = info.category === 'N';
      const pattern = numeric ? numberPattern(info.type) : '@';
      return {
        info,
        numeric,
        locked: !meta.can_update || pk.has(info.name) || info.is_generated,
        base: pattern ? { n: { pattern } } : {},
      };
    });
    this.listen();
  }

  get dirty(): boolean {
    return this.edits.size > 0 || this.added.size > 0 || this.deleted.size > 0;
  }

  get canEdit(): boolean {
    const { meta } = this.options;
    return meta.can_update || meta.can_insert || meta.can_delete;
  }

  dispose(): void {
    this.generation += 1;
    this.disposers.forEach((d) => d());
    this.disposers = [];
  }

  // ------------------------------------------------------------------ loading

  /** (Re)build the sheet for a query, discarding local changes. */
  async load(query: Query, scrollRow = 0): Promise<boolean> {
    this.query = query;
    const generation = ++this.generation;
    this.loading = true;
    this.emit();
    let first;
    try {
      first = await this.fetch(0);
    } catch (error) {
      this.loading = false;
      this.emit();
      this.notice((error as Error).message, 'error');
      return false;
    }
    if (generation !== this.generation) return false;

    this.reset();
    this.stale = false;
    this.knownRows = 0;
    this.emptyFrom = Infinity;
    this.totalExact = first.total_exact;
    this.truncated = first.total > MAX_ROWS;
    this.total = Math.min(first.total_exact ? first.total : Math.max(first.total, first.rows.length), MAX_ROWS);
    if (first.rows.length < BLOCK) {
      this.total = first.rows.length;
      this.totalExact = true;
    }
    if (!this.totalExact) this.knownRows = first.rows.length;
    this.rowCount = this.total + (this.options.meta.can_insert ? NEW_ROWS_BUFFER : 0);
    this.build(first.rows);
    this.loading = false;
    this.emit();
    const sheet = this.sheet();
    if (sheet && scrollRow > 0) sheet.scrollToCell(Math.min(scrollRow, Math.max(this.rowCount - 1, 0)), 0);
    window.setTimeout(() => void this.ensureVisible(), 0);
    return true;
  }

  private reset(): void {
    this.loaded.clear();
    this.pending.clear();
    this.original.clear();
    this.shown.clear();
    this.keys.clear();
    this.edits.clear();
    this.added.clear();
    this.deleted.clear();
  }

  private fetch(block: number) {
    const { connectionId, schema, table } = this.options;
    return http.rows(connectionId, schema, table, {
      offset: block * BLOCK,
      limit: BLOCK,
      sort: this.query.sort,
      filters: this.query.filters,
    });
  }

  private build(firstRows: Text[][]): void {
    const previous = this.unitId ? this.api.getWorkbook(this.unitId) : null;
    if (previous) this.api.disposeUnit(this.unitId);
    this.unitId = `db-${crypto.randomUUID()}`;

    const cellData: Record<number, Record<number, ICellData>> = {};
    firstRows.forEach((row, r) => {
      cellData[r] = this.rowCells(row);
      this.remember(r, row);
    });
    this.loaded.add(0);

    const columnData: Record<number, { w: number }> = {};
    this.columns.forEach((col, c) => {
      const sample = firstRows.slice(0, 200).reduce((max, row) => Math.max(max, (row[c] ?? '').length), 0);
      const chars = Math.max(col.info.name.length + 2, Math.min(sample, 40));
      columnData[c] = { w: Math.max(72, Math.min(360, chars * 8 + 24)) };
    });

    const dataValidation = this.columns.flatMap((col, c) => {
      const values = col.info.enum_values ?? (col.info.category === 'B' ? ['true', 'false'] : null);
      if (!values) return [];
      return [
        {
          uid: `dv-${c}`,
          type: 'list',
          formula1: values.join(','),
          // The whole sheet; setRowCount() stretches it as the sheet grows.
          ranges: [{ startRow: 0, endRow: Math.max(this.rowCount, 1) - 1, startColumn: c, endColumn: c }],
          renderMode: 1,
          // Blank means NULL or the column default; the database validates the rest.
          allowBlank: true,
          showErrorMessage: true,
          errorStyle: 1,
        },
      ];
    });

    this.internal = true;
    try {
      this.api.createWorkbook({
        id: this.unitId,
        name: this.options.table,
        sheetOrder: [SHEET_ID],
        sheets: {
          [SHEET_ID]: {
            id: SHEET_ID,
            name: this.options.table,
            rowCount: Math.max(this.rowCount, 1),
            columnCount: Math.max(this.columns.length, 1),
            cellData,
            columnData,
            defaultRowHeight: 24,
          },
        },
        resources: dataValidation.length
          ? [{ name: 'SHEET_DATA_VALIDATION_PLUGIN', data: JSON.stringify({ [SHEET_ID]: dataValidation }) }]
          : [],
      });
    } finally {
      this.internal = false;
    }
    const workbook = this.api.getActiveWorkbook();
    workbook?.setEditable(this.canEdit);
    const pk = new Set(this.options.meta.primary_key);
    const columnsCfg: Record<number, string | { text: string; fontColor?: string }> = {};
    this.columns.forEach((col, c) => {
      columnsCfg[c] = pk.has(col.info.name) ? { text: col.info.name, fontColor: '#A78BFA' } : col.info.name;
    });
    this.applyHeaders(columnsCfg, this.unitId);
  }

  /** Column titles need the sheet renderer, which appears a few frames after creation. */
  private applyHeaders(columnsCfg: Record<number, string | { text: string; fontColor?: string }>, unitId: string, attempt = 0) {
    if (unitId !== this.unitId) return;
    try {
      this.sheet()?.customizeColumnHeader({ columnsCfg });
    } catch {
      if (attempt < 50) window.setTimeout(() => this.applyHeaders(columnsCfg, unitId, attempt + 1), 50);
    }
  }

  private rowCells(row: Text[], extra?: IStyleData): Record<number, ICellData> {
    const cells: Record<number, ICellData> = {};
    this.columns.forEach((col, c) => {
      cells[c] = this.cellFor(col, row[c] ?? null, extra);
    });
    return cells;
  }

  private cellFor(col: Column, text: Text, extra?: IStyleData): ICellData {
    const s = { ...col.base, ...extra };
    if (text === null || text === '') return { v: null, s } as ICellData;
    if (col.numeric && isSafeNumber(text)) return { v: Number(text), t: 2, s };
    return { v: text, t: 1, s };
  }

  private remember(r: number, row: Text[]): void {
    this.original.set(r, row);
    this.shown.set(
      r,
      this.columns.map((col, c) => display(this.cellFor(col, row[c] ?? null).v)),
    );
    const { meta } = this.options;
    this.keys.set(
      r,
      Object.fromEntries(meta.primary_key.map((name) => [name, row[meta.columns.findIndex((c) => c.name === name)] ?? null])),
    );
  }

  private keyOf(row: Text[]): string {
    const { meta } = this.options;
    return JSON.stringify(
      Object.fromEntries(meta.primary_key.map((name) => [name, row[meta.columns.findIndex((c) => c.name === name)] ?? null])),
    );
  }

  private async ensureVisible(): Promise<void> {
    const sheet = this.sheet();
    const range = sheet?.getVisibleRange();
    if (!range || this.total === 0) return;
    const from = Math.max(0, range.startRow - 100);
    // While the end of the table is unknown, keep probing the block after the estimate.
    const limit = this.totalExact ? this.total - 1 : this.total;
    const to = Math.min(limit, range.endRow + 200);
    const blocks = new Set<number>();
    for (let block = Math.floor(from / BLOCK); block <= Math.floor(to / BLOCK); block += 1) blocks.add(block);
    // Looking past an estimate that turned out too high: find where the rows really end.
    if (!this.totalExact && !this.seeking && from > limit) blocks.add(this.probeBlock());
    for (const block of blocks) {
      if (!this.loaded.has(block) && !this.pending.has(block)) void this.loadBlock(block);
    }
  }

  private async loadBlock(block: number): Promise<boolean> {
    const generation = this.generation;
    this.pending.add(block);
    try {
      const page = await this.fetch(block);
      if (generation !== this.generation) return false;
      this.loaded.add(block);
      const start = block * BLOCK;
      if (!this.totalExact) this.refineTotal(start, page.rows.length);
      const cellValue: Record<number, Record<number, ICellData>> = {};
      page.rows.forEach((row, i) => {
        const r = start + i;
        if (r >= this.total) return;
        cellValue[r] = this.rowCells(row);
        this.remember(r, row);
      });
      this.writeCells(cellValue);
      return true;
    } catch (error) {
      if (generation === this.generation) this.notice((error as Error).message, 'error');
      return false;
    } finally {
      this.pending.delete(block);
    }
  }

  /**
   * The row count is an estimate when counting timed out (it also ignores filters).
   * Each loaded block narrows it down: a partly filled block gives the exact end, a full
   * block proves rows up to its end exist, an empty block proves nothing starts there.
   */
  private refineTotal(start: number, rows: number): void {
    if (rows > 0 && rows < BLOCK) {
      this.knownRows = start + rows;
      this.emptyFrom = start + rows;
    } else if (rows === 0) {
      this.emptyFrom = Math.min(this.emptyFrom, start);
    } else {
      this.knownRows = Math.max(this.knownRows, start + BLOCK);
    }
    if (this.knownRows >= this.emptyFrom || this.knownRows >= MAX_ROWS) {
      this.total = Math.min(this.knownRows, MAX_ROWS);
      this.totalExact = true;
      // Drop blank rows left over from probing past the end.
      this.fitRowCount();
    } else {
      this.total = Math.min(Math.max(this.total, this.knownRows), this.emptyFrom);
      this.growNewRowsTo(this.options.meta.can_insert ? this.total : this.total - NEW_ROWS_BUFFER);
    }
    this.emit();
    // The visible window may now reach rows that were outside the estimate.
    if (!this.seeking) window.setTimeout(() => void this.ensureVisible(), 0);
  }

  /** Next block to load when looking for the end: double past the known rows, then bisect. */
  private probeBlock(): number {
    const row = Number.isFinite(this.emptyFrom)
      ? Math.floor((this.knownRows + this.emptyFrom) / 2)
      : Math.max(this.total, this.knownRows * 2);
    return Math.floor(Math.min(row, MAX_ROWS) / BLOCK);
  }

  /** Load blocks until the real end of the table is known. Returns false on failure. */
  private async seekEnd(): Promise<boolean> {
    if (this.seeking) return false;
    const generation = this.generation;
    this.seeking = true;
    try {
      while (!this.totalExact) {
        const block = this.probeBlock();
        if (this.pending.has(block) || this.loaded.has(block)) return false;
        if (!(await this.loadBlock(block)) || generation !== this.generation) return false;
      }
      return true;
    } finally {
      this.seeking = false;
    }
  }

  /** Shrink the sheet to the data plus the blank rows for new ones. */
  private fitRowCount(): void {
    const lastNew = Math.max(-1, ...this.added.keys());
    const wanted = Math.max(this.total, lastNew + 1) + (this.options.meta.can_insert ? NEW_ROWS_BUFFER : 0);
    if (wanted >= this.rowCount) return;
    this.rowCount = Math.max(wanted, 1);
    this.internal = true;
    try {
      this.api.syncExecuteCommand(SET_ROW_COUNT, { unitId: this.unitId, subUnitId: SHEET_ID, rowCount: this.rowCount });
    } finally {
      this.internal = false;
    }
  }

  // ------------------------------------------------------------------ editing

  private listen(): void {
    const { api } = this;
    let scrollTimer: number | undefined;
    // Univer's Scroll/SelectionChanged facade events are not wired for workbooks created
    // after the first render, so scrolling is detected from the operations themselves.
    const subscriptions = [
      api.addEvent(api.Event.CommandExecuted, (event) => {
        if (!SCROLL_OPERATIONS.has(event.id)) return;
        window.clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => void this.ensureVisible(), 120);
      }),
      api.addEvent(api.Event.BeforeSheetEditStart, (event) => {
        if (event.workbook.getId() !== this.unitId) return;
        const reason = this.lockReason(event.row, event.column);
        if (reason) {
          event.cancel = true;
          this.notice(reason);
        }
      }),
      api.addEvent(api.Event.BeforeCommandExecute, (event) => {
        if (this.internal || event.type !== CommandType.MUTATION) return;
        const params = (event.params ?? {}) as { unitId?: string; cellValue?: Record<string, Record<string, ICellData | null>> };
        if (params.unitId !== this.unitId) return;
        if (event.id.startsWith('formula.') || event.id.startsWith('doc.')) return;
        if (!ALLOWED_MUTATIONS.has(event.id)) {
          event.cancel = true;
          this.notice('Структуру таблицы базы данных здесь изменить нельзя.');
          return;
        }
        if (event.id === SET_RANGE_VALUES) {
          const reason = this.checkValues(params.cellValue ?? {});
          if (reason) {
            event.cancel = true;
            this.notice(reason);
          }
        }
      }),
      api.addEvent(api.Event.CommandExecuted, (event) => {
        if (this.internal || event.id !== SET_RANGE_VALUES) return;
        const params = (event.params ?? {}) as { unitId?: string; cellValue?: Record<string, Record<string, unknown>> };
        if (params.unitId !== this.unitId || !params.cellValue) return;
        const touched: Array<[number, number]> = [];
        for (const [row, cols] of Object.entries(params.cellValue)) {
          for (const col of Object.keys(cols ?? {})) touched.push([Number(row), Number(col)]);
        }
        // Run after Univer finished the command: restyling is a separate mutation.
        queueMicrotask(() => this.afterEdit(touched));
      }),
    ];
    this.disposers.push(() => {
      window.clearTimeout(scrollTimer);
      subscriptions.forEach((s) => s.dispose());
    });
  }

  private lockReason(r: number, c: number): string | null {
    const col = this.columns[c];
    if (!col) return 'Вне таблицы.';
    if (this.saving) return 'Идёт сохранение — подождите секунду.';
    if (this.stale) return 'Изменения сохранены, но таблицу не удалось перечитать. Нажмите «Обновить».';
    if (r >= this.total) {
      if (!this.totalExact) return 'Конец таблицы ещё загружается — прокрутите ниже.';
      if (!this.options.meta.can_insert) return 'В эту таблицу нельзя добавлять строки.';
      if (col.info.is_generated) return `Столбец «${col.info.name}» вычисляется базой данных.`;
      return null;
    }
    if (!this.loaded.has(Math.floor(r / BLOCK))) return 'Строки ещё загружаются.';
    if (this.deleted.has(r)) return 'Строка помечена на удаление.';
    if (col.locked) {
      if (!this.options.meta.can_update) return 'Таблицу нельзя редактировать.';
      if (col.info.is_generated) return `Столбец «${col.info.name}» вычисляется базой данных.`;
      return `Столбец «${col.info.name}» входит в первичный ключ и не редактируется.`;
    }
    return null;
  }

  private checkValues(cellValue: Record<string, Record<string, ICellData | null>>): string | null {
    for (const [row, cols] of Object.entries(cellValue)) {
      for (const [col, cell] of Object.entries(cols ?? {})) {
        const changesValue = cell === null || 'v' in cell || 'p' in cell || 'f' in cell || 'si' in cell;
        if (!changesValue) continue;
        if (cell && (cell.f || cell.si)) return 'Формулы в таблицах базы данных не поддерживаются.';
        const reason = this.lockReason(Number(row), Number(col));
        if (reason) return reason;
      }
    }
    return null;
  }

  private afterEdit(touched: Array<[number, number]>): void {
    const sheet = this.sheet();
    if (!sheet) return;
    const rows = new Set<number>();
    for (const [r, c] of touched) {
      if (!this.columns[c]) continue;
      const current = display(sheet.getRange(r, c).getValue());
      if (r < this.total) {
        const shown = this.shown.get(r)?.[c];
        if (shown === undefined) continue;
        const cells = this.edits.get(r) ?? new Map<number, string>();
        if (current === shown) cells.delete(c);
        else cells.set(c, current);
        if (cells.size) this.edits.set(r, cells);
        else this.edits.delete(r);
      } else {
        const cells = this.added.get(r) ?? new Map<number, string>();
        if (current === '') cells.delete(c);
        else cells.set(c, current);
        if (cells.size) this.added.set(r, cells);
        else this.added.delete(r);
      }
      rows.add(r);
    }
    this.growNewRows();
    this.restyle(rows);
    this.emit();
  }

  /** Keep blank rows available below the last new row. */
  private growNewRows(): void {
    if (!this.options.meta.can_insert) return;
    const last = Math.max(this.total - 1, ...this.added.keys());
    this.setRowCount(last + 1 + NEW_ROWS_BUFFER);
  }

  /** Grow the sheet; Univer clips validation ranges to the sheet size, so stretch them too. */
  private setRowCount(count: number): void {
    if (count <= this.rowCount) return;
    this.rowCount = count;
    this.internal = true;
    try {
      this.api.syncExecuteCommand(SET_ROW_COUNT, { unitId: this.unitId, subUnitId: SHEET_ID, rowCount: count });
      const sheet = this.sheet();
      for (const rule of sheet?.getDataValidations() ?? []) {
        // Rules are created per column with uid `dv-<column>` (see build()).
        const column = Number(/^dv-(\d+)$/.exec(rule.rule.uid)?.[1]);
        if (sheet && Number.isInteger(column)) rule.setRanges([sheet.getRange(0, column, count, 1)]);
      }
    } finally {
      this.internal = false;
    }
  }

  private styleFor(r: number, c: number): IStyleData {
    const base = this.columns[c].base;
    if (r >= this.total) return this.added.has(r) ? { ...base, ...INSERTED } : base;
    if (this.deleted.has(r)) return { ...base, ...DELETED };
    if (this.edits.get(r)?.has(c)) return { ...base, ...EDITED };
    return base;
  }

  private restyle(rows: Iterable<number>): void {
    const cellValue: Record<number, Record<number, ICellData>> = {};
    for (const r of rows) {
      cellValue[r] = {};
      this.columns.forEach((_, c) => {
        cellValue[r][c] = { s: this.styleFor(r, c) };
      });
    }
    this.writeCells(cellValue, true);
  }

  private writeCells(cellValue: Record<number, Record<number, ICellData>>, overrideStyle = false): void {
    if (!Object.keys(cellValue).length) return;
    this.internal = true;
    try {
      this.api.syncExecuteCommand(SET_RANGE_VALUES, {
        unitId: this.unitId,
        subUnitId: SHEET_ID,
        cellValue,
        isOverrideStyle: overrideStyle,
      });
    } finally {
      this.internal = false;
    }
  }

  /** Mark the selected rows for deletion, or unmark them if all are marked already. */
  toggleDeleteSelection(): void {
    const range = this.sheet()?.getActiveRange();
    if (!range) return;
    const blocked = this.saving || this.stale ? this.lockReason(range.getRow(), 0) : null;
    if (blocked) {
      this.notice(blocked);
      return;
    }
    const start = range.getRow();
    const end = range.getLastRow();
    const existing: number[] = [];
    const fresh: number[] = [];
    for (let r = start; r <= Math.min(end, this.rowCount - 1); r += 1) {
      if (r < this.total) {
        if (this.loaded.has(Math.floor(r / BLOCK))) existing.push(r);
      } else if (this.added.has(r)) {
        fresh.push(r);
      }
    }
    if (existing.length && !this.options.meta.can_delete) {
      this.notice('Из этой таблицы нельзя удалять строки.');
      return;
    }
    const unmark = existing.length > 0 && existing.every((r) => this.deleted.has(r));
    for (const r of existing) {
      if (unmark) this.deleted.delete(r);
      else this.deleted.add(r);
    }
    // New rows are simply cleared.
    const clear: Record<number, Record<number, ICellData>> = {};
    for (const r of fresh) {
      this.added.delete(r);
      clear[r] = this.rowCells([]);
    }
    this.writeCells(clear, true);
    this.restyle([...existing, ...fresh]);
    this.emit();
  }

  /** Select the first blank row below the data for typing a new row. */
  focusNewRow(): void {
    const sheet = this.sheet();
    if (!sheet || !this.options.meta.can_insert) return;
    if (!this.totalExact) {
      // New rows go after the real end; find it first, then come back here.
      this.notice('Ищу конец таблицы…');
      void this.seekEnd().then((found) => {
        if (found) this.focusNewRow();
      });
      return;
    }
    let r = this.total;
    while (this.added.has(r)) r += 1;
    this.growNewRowsTo(r);
    const c = Math.max(
      0,
      this.columns.findIndex((col) => !col.info.is_generated && !(col.info.is_identity || col.info.has_default)),
    );
    sheet.scrollToCell(r, 0);
    sheet.getRange(r, c).activate();
  }

  private growNewRowsTo(r: number): void {
    this.setRowCount(r + NEW_ROWS_BUFFER);
  }

  // ------------------------------------------------------------------ saving

  private normalize(col: Column, value: string): Text {
    return value === '' && !col.info.not_null ? null : value;
  }

  private collect(): { changes: DbChanges; updateRows: number[]; insertRows: number[]; deleteRows: number[] } {
    const changes: DbChanges = { updates: [], inserts: [], deletes: [] };
    const updateRows: number[] = [];
    const insertRows: number[] = [];
    const deleteRows: number[] = [];
    for (const [r, cells] of this.edits) {
      if (this.deleted.has(r)) continue;
      const values: Record<string, Text> = {};
      const expected: Record<string, Text> = {};
      for (const [c, value] of cells) {
        const col = this.columns[c];
        values[col.info.name] = this.normalize(col, value);
        expected[col.info.name] = this.original.get(r)?.[c] ?? null;
      }
      changes.updates.push({ pk: this.keys.get(r) ?? {}, values, expected });
      updateRows.push(r);
    }
    for (const r of [...this.deleted].sort((a, b) => a - b)) {
      // The whole row as loaded: it is deleted only if nobody changed it since.
      const row = this.original.get(r) ?? [];
      const expected = Object.fromEntries(this.columns.map((col, c) => [col.info.name, row[c] ?? null]));
      changes.deletes.push({ pk: this.keys.get(r) ?? {}, expected });
      deleteRows.push(r);
    }
    for (const r of [...this.added.keys()].sort((a, b) => a - b)) {
      const values: Record<string, Text> = {};
      for (const [c, value] of this.added.get(r) ?? []) values[this.columns[c].info.name] = value;
      changes.inserts.push({ values });
      insertRows.push(r);
    }
    return { changes, updateRows, insertRows, deleteRows };
  }

  get isSaving(): boolean {
    return this.saving;
  }

  async save(): Promise<boolean> {
    if (this.saving) return false;
    if (!this.dirty) return true;
    const { changes, updateRows, insertRows, deleteRows } = this.collect();
    const { connectionId, schema, table } = this.options;
    this.saving = true;
    let result;
    try {
      result = await http.applyChanges(connectionId, schema, table, changes);
    } catch (error) {
      this.saving = false;
      this.reportSaveError(error, updateRows, insertRows, deleteRows);
      return false;
    }
    this.saving = false;
    const parts = [
      updateRows.length && `изменено ${updateRows.length}`,
      insertRows.length && `добавлено ${insertRows.length}`,
      result.deleted && `удалено ${result.deleted}`,
    ].filter(Boolean);
    const summary = `Сохранено: ${parts.join(', ')}.`;
    if (insertRows.length || deleteRows.length) {
      // The changes are in the database now: forget them before re-reading, so a failed
      // reload can never send them twice. Row positions change, so reload the window.
      this.edits.clear();
      this.added.clear();
      this.deleted.clear();
      this.stale = true;
      this.emit();
      const top = this.sheet()?.getVisibleRange()?.startRow ?? 0;
      if (await this.load(this.query, top)) {
        this.notice(summary, 'success');
      } else {
        this.notice(`${summary} Таблицу не удалось перечитать — нажмите «Обновить».`, 'error');
      }
    } else {
      this.commitUpdates(updateRows, result.updated);
      this.notice(summary, 'success');
    }
    return true;
  }

  private commitUpdates(rows: number[], updated: Text[][]): void {
    const cellValue: Record<number, Record<number, ICellData>> = {};
    rows.forEach((r, i) => {
      const row = updated[i];
      if (!row) return;
      this.edits.delete(r);
      this.remember(r, row);
      cellValue[r] = this.rowCells(row);
    });
    this.writeCells(cellValue, true);
    this.emit();
  }

  private reportSaveError(error: unknown, updateRows: number[], insertRows: number[], deleteRows: number[]): void {
    if (!(error instanceof ApiError)) {
      this.notice(`Не удалось сохранить: ${(error as Error).message}`, 'error');
      return;
    }
    const detail = (typeof error.detail === 'object' && error.detail ? error.detail : {}) as DbChangeError;
    if (error.status === 409 && detail.pk) {
      const key = JSON.stringify(detail.pk);
      const sameKey = (row: number) => JSON.stringify(this.keys.get(row)) === key;
      const r = updateRows.find(sameKey) ?? deleteRows.find(sameKey);
      const wasDelete = r !== undefined && this.deleted.has(r);
      if (r !== undefined) {
        this.deleted.delete(r);
        this.dropRowEdits(r);
      }
      const where = r !== undefined ? `Строку ${r + 1}` : 'Строку';
      this.notice(
        `${where} изменили или удалили в базе после загрузки. Ничего не сохранено. ` +
          (wasDelete
            ? 'Пометка на удаление снята и показано текущее значение — проверьте и сохраните снова.'
            : 'Её правки сняты и показано текущее значение — проверьте и сохраните снова.'),
        'error',
      );
      return;
    }
    const rows = { update: updateRows, insert: insertRows, delete: deleteRows };
    const r = detail.op !== undefined && detail.index !== undefined ? rows[detail.op][detail.index] : undefined;
    if (r !== undefined) this.sheet()?.scrollToCell(r, 0);
    this.notice(
      `Ничего не сохранено${r !== undefined ? `: строка ${r + 1}` : ''} — ${detail.message ?? error.message}`,
      'error',
    );
  }

  /** Discard local edits of one row and show its current database values. */
  private dropRowEdits(r: number): void {
    this.edits.delete(r);
    const block = Math.floor(r / BLOCK);
    const generation = this.generation;
    void this.fetch(block).then((page) => {
      if (generation !== this.generation) return;
      const row = page.rows[r - block * BLOCK];
      const sameRow = row && this.keyOf(row) === JSON.stringify(this.keys.get(r));
      // If the row moved (sort or filter no longer match), show what was loaded before.
      const values = sameRow ? row : (this.original.get(r) ?? []);
      if (sameRow) this.remember(r, row);
      this.writeCells({ [r]: this.rowCells(values, this.deleted.has(r) ? DELETED : undefined) }, true);
      this.emit();
    });
    this.restyle([r]);
    this.emit();
  }

  // ------------------------------------------------------------------ helpers

  private sheet() {
    const workbook = this.unitId ? this.api.getActiveWorkbook() : null;
    return workbook && workbook.getId() === this.unitId ? workbook.getActiveSheet() : null;
  }

  private emit(): void {
    this.options.onState({
      loading: this.loading,
      total: this.total,
      totalExact: this.totalExact,
      truncated: this.truncated,
      edited: [...this.edits.keys()].filter((r) => !this.deleted.has(r)).length,
      inserted: this.added.size,
      deleted: this.deleted.size,
    });
  }

  private notice(message: string, kind?: 'error' | 'success'): void {
    const now = Date.now();
    if (message === this.lastNotice && now - this.lastNoticeAt < 2000) return;
    this.lastNotice = message;
    this.lastNoticeAt = now;
    this.options.onNotice(message, kind);
  }
}
