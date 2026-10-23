import type { FRange } from '@univerjs/sheets/facade';
import type { FUniver } from '@univerjs/presets';

export function getSelection(api: FUniver): FRange | null {
  return api.getActiveWorkbook()?.getActiveRange() ?? null;
}

export function applyToSelection(api: FUniver, apply: (range: FRange) => void): boolean {
  const range = getSelection(api);
  if (!range) {
    return false;
  }
  apply(range);
  return true;
}

export interface SelectionStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  fontSize: number;
  fontFamily: string;
  align: 'left' | 'center' | 'right';
  color: string;
  background: string;
}

export function readSelectionStyle(api: FUniver): SelectionStyle | null {
  const range = getSelection(api);
  const style = range?.getCellStyleData();
  if (!style) {
    return null;
  }

  const align = style.ht === 2 ? 'center' : style.ht === 3 ? 'right' : 'left';

  return {
    bold: style.bl === 1,
    italic: style.it === 1,
    underline: style.ul?.s === 1,
    fontSize: style.fs ?? 11,
    fontFamily: style.ff ?? 'Inter Variable',
    align,
    color: style.cl?.rgb ?? '#D8DAE3',
    background: style.bg?.rgb ?? '#101218',
  };
}

export interface KpiCategory {
  name: string;
  value: number;
  share: number;
}

export interface KpiSnapshot {
  income: number;
  expense: number;
  balance: number;
  planIncome: number;
  planExpense: number;
  operations: number;
  incomeCount: number;
  categories: KpiCategory[];
}

export function readKpi(api: FUniver): KpiSnapshot | null {
  const sheet = api.getActiveWorkbook()?.getSheetByName('Финансы');
  if (!sheet) {
    return null;
  }

  const values = sheet.getRange('C2:G14').getRawValues();
  let income = 0;
  let expense = 0;
  let planIncome = 0;
  let planExpense = 0;
  let operations = 0;
  let incomeCount = 0;
  const byCategory = new Map<string, number>();

  for (const row of values) {
    const category = typeof row[0] === 'string' ? row[0] : '';
    const kind = typeof row[1] === 'string' ? row[1] : '';
    const amount = typeof row[2] === 'number' ? row[2] : Number(row[2]);
    const plan = typeof row[4] === 'number' ? row[4] : Number(row[4]);

    if (!category || Number.isNaN(amount)) {
      continue;
    }

    operations += 1;

    if (kind === 'Доход') {
      income += amount;
      planIncome += Number.isNaN(plan) ? 0 : plan;
      incomeCount += 1;
    } else {
      expense += -amount;
      planExpense += Number.isNaN(plan) ? 0 : -plan;
      byCategory.set(category, (byCategory.get(category) ?? 0) - amount);
    }
  }

  const categories = [...byCategory.entries()]
    .map(([name, value]) => ({ name, value, share: expense > 0 ? value / expense : 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 4);

  return {
    income,
    expense,
    balance: income - expense,
    planIncome,
    planExpense,
    operations,
    incomeCount,
    categories,
  };
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPercent(value: number): string {
  return new Intl.NumberFormat('ru-RU', {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(value);
}
