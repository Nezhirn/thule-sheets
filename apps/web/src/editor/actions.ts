import type { IStyleData } from '@univerjs/core';

import type { FUniver } from './univer';

export const H_ALIGN = { left: 1, center: 2, right: 3 } as const;
export const V_ALIGN = { top: 1, middle: 2, bottom: 3 } as const;
const WRAP = 3;
const OVERFLOW = 1;

export const FONT_FAMILIES = ['Inter', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana'];
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36];

export interface NumberFormatOption {
  id: string;
  label: string;
  pattern: string;
  example: string;
}

export const NUMBER_FORMATS: NumberFormatOption[] = [
  { id: 'general', label: 'Общий', pattern: 'General', example: '1234.5' },
  { id: 'number', label: 'Числовой', pattern: '#,##0.00', example: '1 234,50' },
  { id: 'integer', label: 'Целое', pattern: '#,##0', example: '1 235' },
  { id: 'rub', label: 'Рубли', pattern: '#,##0 "₽"', example: '1 235 ₽' },
  { id: 'rub2', label: 'Рубли с копейками', pattern: '#,##0.00 "₽"', example: '1 234,50 ₽' },
  { id: 'usd', label: 'Доллары', pattern: '"$"#,##0.00', example: '$1,234.50' },
  { id: 'percent', label: 'Процент', pattern: '0%', example: '12%' },
  { id: 'percent2', label: 'Процент, 2 знака', pattern: '0.00%', example: '12,35%' },
  { id: 'date', label: 'Дата', pattern: 'dd.mm.yyyy', example: '01.10.2026' },
  { id: 'datetime', label: 'Дата и время', pattern: 'dd.mm.yyyy hh:mm', example: '01.10.2026 14:30' },
  { id: 'time', label: 'Время', pattern: 'hh:mm', example: '14:30' },
  { id: 'text', label: 'Текст', pattern: '@', example: 'abc' },
];

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function activeRange(api: FUniver) {
  return api.getActiveWorkbook()?.getActiveRange() ?? null;
}

export interface SelectionState {
  address: string;
  sheetName: string;
  input: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fontFamily: string;
  fontSize: number;
  color: string | null;
  background: string | null;
  hAlign: 'left' | 'center' | 'right' | null;
  vAlign: 'top' | 'middle' | 'bottom' | null;
  wrap: boolean;
  merged: boolean;
  numberFormat: string;
}

export const EMPTY_SELECTION: SelectionState = {
  address: '',
  sheetName: '',
  input: '',
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  fontFamily: 'Inter',
  fontSize: 11,
  color: null,
  background: null,
  hAlign: null,
  vAlign: null,
  wrap: false,
  merged: false,
  numberFormat: 'General',
};

function cellInput(range: NonNullable<ReturnType<typeof activeRange>>): string {
  const formula = range.getFormula();
  if (formula) return formula;
  const value = range.getRawValue();
  return value === null || value === undefined ? '' : String(value);
}

export function readSelection(api: FUniver): SelectionState {
  const range = activeRange(api);
  if (!range) return EMPTY_SELECTION;
  const style: IStyleData = range.getCellStyleData() ?? {};
  const h = style.ht === 2 ? 'center' : style.ht === 3 ? 'right' : style.ht === 1 ? 'left' : null;
  const v = style.vt === 1 ? 'top' : style.vt === 2 ? 'middle' : style.vt === 3 ? 'bottom' : null;
  const { startRow, startColumn } = range.getRange();
  let numberFormat = 'General';
  try {
    numberFormat = range.getNumberFormat() || 'General';
  } catch {
    // numfmt facade is optional
  }
  return {
    address: `${columnLetter(startColumn)}${startRow + 1}`,
    sheetName: range.getSheetName(),
    input: cellInput(range),
    bold: style.bl === 1,
    italic: style.it === 1,
    underline: style.ul?.s === 1,
    strike: style.st?.s === 1,
    fontFamily: style.ff ?? 'Inter',
    fontSize: style.fs ?? 11,
    color: style.cl?.rgb ?? null,
    background: style.bg?.rgb ?? null,
    hAlign: h,
    vAlign: v,
    wrap: style.tb === WRAP,
    merged: range.isMerged(),
    numberFormat,
  };
}

export function run(api: FUniver, id: string, params?: object): void {
  void api.executeCommand(id, params);
}

export const commands = {
  undo: (api: FUniver) => void api.undo(),
  redo: (api: FUniver) => void api.redo(),
  bold: (api: FUniver) => run(api, 'sheet.command.set-bold'),
  italic: (api: FUniver) => run(api, 'sheet.command.set-italic'),
  underline: (api: FUniver) => run(api, 'sheet.command.set-underline'),
  strike: (api: FUniver, on: boolean) =>
    run(api, 'sheet.command.set-style', { style: { type: 'st', value: { s: on ? 1 : 0 } } }),
  fontFamily: (api: FUniver, value: string) => run(api, 'sheet.command.set-font-family', { value }),
  fontSize: (api: FUniver, value: number) => run(api, 'sheet.command.set-font-size', { value }),
  textColor: (api: FUniver, value: string) => run(api, 'sheet.command.set-text-color', { value }),
  resetTextColor: (api: FUniver) => run(api, 'sheet.command.reset-text-color'),
  background: (api: FUniver, value: string) => run(api, 'sheet.command.set-background-color', { value }),
  resetBackground: (api: FUniver) => run(api, 'sheet.command.reset-background-color'),
  hAlign: (api: FUniver, value: keyof typeof H_ALIGN) =>
    run(api, 'sheet.command.set-horizontal-text-align', { value: H_ALIGN[value] }),
  vAlign: (api: FUniver, value: keyof typeof V_ALIGN) =>
    run(api, 'sheet.command.set-vertical-text-align', { value: V_ALIGN[value] }),
  wrap: (api: FUniver, on: boolean) => run(api, 'sheet.command.set-text-wrap', { value: on ? WRAP : OVERFLOW }),
  border: (api: FUniver, type: string) =>
    run(api, 'sheet.command.set-border-basic', { value: { type, style: 1, color: '#000000' } }),
  merge: (api: FUniver) => run(api, 'sheet.command.add-worksheet-merge-all'),
  unmerge: (api: FUniver) => run(api, 'sheet.command.remove-worksheet-merge'),
  clearFormat: (api: FUniver) => run(api, 'sheet.command.clear-selection-format'),
  clearContent: (api: FUniver) => run(api, 'sheet.command.clear-selection-content'),
  formatPainter: (api: FUniver) => run(api, 'sheet.command.set-once-format-painter'),
  numberFormat: (api: FUniver, pattern: string) => activeRange(api)?.setNumberFormat(pattern),
  addDecimal: (api: FUniver) => run(api, 'sheet.command.numfmt.add.decimal.command'),
  subtractDecimal: (api: FUniver) => run(api, 'sheet.command.numfmt.subtract.decimal.command'),
  // The "before" commands require an explicit count; the "after" commands derive
  // it from the selection.
  insertRowBefore: (api: FUniver) => run(api, 'sheet.command.insert-row-before', { value: 1 }),
  insertRowAfter: (api: FUniver) => run(api, 'sheet.command.insert-row-after'),
  insertColBefore: (api: FUniver) => run(api, 'sheet.command.insert-col-before', { value: 1 }),
  insertColAfter: (api: FUniver) => run(api, 'sheet.command.insert-col-after'),
  removeRows: (api: FUniver) => run(api, 'sheet.command.remove-row-by-range'),
  removeCols: (api: FUniver) => run(api, 'sheet.command.remove-col-by-range'),
  sortAsc: (api: FUniver) => run(api, 'sheet.command.sort-range-asc'),
  sortDesc: (api: FUniver) => run(api, 'sheet.command.sort-range-desc'),
  toggleFilter: (api: FUniver) => run(api, 'sheet.command.smart-toggle-filter'),
  clearFilter: (api: FUniver) => run(api, 'sheet.command.clear-filter-criteria'),
  dataValidation: (api: FUniver) => run(api, 'data-validation.operation.open-validation-panel'),
  conditionalFormatting: (api: FUniver) => run(api, 'sheet.operation.open.conditional.formatting.panel'),
  find: (api: FUniver) => run(api, 'ui.operation.open-find-dialog'),
  hyperlink: (api: FUniver) => run(api, 'sheet.operation.insert-hyper-link-toolbar'),
  note: (api: FUniver) => run(api, 'sheet.operation.add-note-popup'),
  freezeToSelection: (api: FUniver) => {
    const range = activeRange(api);
    const sheet = api.getActiveWorkbook()?.getActiveSheet();
    if (!range || !sheet) return;
    const { startRow, startColumn } = range.getRange();
    sheet.setFrozenRows(startRow);
    sheet.setFrozenColumns(startColumn);
  },
  freezeRows: (api: FUniver, rows: number) => api.getActiveWorkbook()?.getActiveSheet().setFrozenRows(rows),
  unfreeze: (api: FUniver) => api.getActiveWorkbook()?.getActiveSheet().cancelFreeze(),
  toggleGridlines: (api: FUniver) => {
    const sheet = api.getActiveWorkbook()?.getActiveSheet();
    if (sheet) sheet.setHiddenGridlines(!sheet.hasHiddenGridLines());
  },
};

/** Write user input into the active cell: formulas start with "=", numbers are parsed. */
export function commitInput(api: FUniver, text: string): void {
  const range = activeRange(api);
  const sheet = api.getActiveWorkbook()?.getActiveSheet();
  if (!range || !sheet) return;
  const { startRow, startColumn } = range.getRange();
  const target = sheet.getRange(startRow, startColumn);
  if (text.startsWith('=') && text.length > 1) {
    target.setFormula(text);
    return;
  }
  const normalized = text.replace(/\s/g, '').replace(',', '.');
  target.setValue(normalized !== '' && /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : text);
}

/** Parse "Sheet!A1:B5" (sheet optional, quotes allowed) and return raw values. */
export function readRef(api: FUniver, ref: string): unknown[][] | null {
  const workbook = api.getActiveWorkbook();
  if (!workbook) return null;
  const match = /^(?:'?(.+?)'?!)?([A-Za-z]+\d+(?::[A-Za-z]+\d+)?)$/.exec(ref.trim());
  if (!match) return null;
  const sheet = match[1] ? workbook.getSheetByName(match[1]) : workbook.getActiveSheet();
  if (!sheet) return null;
  try {
    return sheet.getRange(match[2]).getRawValues() as unknown[][];
  } catch {
    return null;
  }
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Univer dark mode inverts canvas colors; show swatches the way they will be rendered. */
export function displayColor(hex: string): string {
  const value = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return hex;
  const r = Number.parseInt(value.slice(0, 2), 16) / 255;
  const g = Number.parseInt(value.slice(2, 4), 16) / 255;
  const b = Number.parseInt(value.slice(4, 6), 16) / 255;
  const channel = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(1 + 0.333 * r - 0.667 * g - 0.667 * b)}${channel(1 - 0.667 * r + 0.333 * g - 0.667 * b)}${channel(1 - 0.667 * r - 0.667 * g + 0.333 * b)}`;
}

/** Light palette (stored in the document, exported to XLSX as-is). */
export const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#B7B7B7', '#D9D9D9', '#EFEFEF', '#FFFFFF',
  '#980000', '#FF0000', '#FF9900', '#FFFF00', '#00FF00', '#00FFFF', '#4A86E8', '#9900FF',
  '#E6B8AF', '#F4CCCC', '#FCE5CD', '#FFF2CC', '#D9EAD3', '#D0E0E3', '#C9DAF8', '#D9D2E9',
  '#DD7E6B', '#EA9999', '#F9CB9C', '#FFE599', '#B6D7A8', '#A2C4C9', '#A4C2F4', '#B4A7D6',
  '#A61C00', '#CC0000', '#E69138', '#F1C232', '#6AA84F', '#45818E', '#3C78D8', '#674EA7',
];
