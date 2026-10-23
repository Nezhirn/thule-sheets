import { LocaleType, type IStyleData, type IWorkbookData } from '@univerjs/core';

/**
 * Univer renders the sheet canvas in dark mode by inverting every color
 * (`CanvasColorService`). Snapshot colors are therefore authored as light
 * palette values: inversion turns them into the dark theme we actually want.
 */
function invertHexColor(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16) / 255;
  const g = Number.parseInt(value.slice(2, 4), 16) / 255;
  const b = Number.parseInt(value.slice(4, 6), 16) / 255;
  const toChannel = (normalized: number) =>
    Math.max(0, Math.min(255, Math.round(normalized * 255)))
      .toString(16)
      .padStart(2, '0');

  const inverted = [
    1 + 0.333 * r - 0.667 * g - 0.667 * b,
    1 - 0.667 * r + 0.333 * g - 0.667 * b,
    1 - 0.667 * r - 0.667 * g + 0.333 * b,
  ];

  return `#${inverted.map(toChannel).join('')}`;
}

function invertStyleColors(styles: Record<string, IStyleData>): Record<string, IStyleData> {
  const convert = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return /^#[0-9a-f]{6}$/i.test(value) ? invertHexColor(value) : value;
    }
    if (Array.isArray(value)) {
      return value.map(convert);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert(item)]));
    }
    return value;
  };

  return convert(styles) as Record<string, IStyleData>;
}

const HEADER_BG = '#1B1D26';
const HEADER_TEXT = '#A6ABBA';
const TEXT = '#D8DAE3';
const MUTED = '#8B90A0';
const GREEN = '#4ADE80';
const RED = '#F87171';
const AMBER = '#FBBF24';
const PURPLE = '#A78BFA';
const BORDER = '#2A2D38';

interface Operation {
  date: string;
  title: string;
  category: string;
  kind: 'Доход' | 'Расход';
  amount: number;
  status: 'Выполнено' | 'В процессе' | 'Запланировано';
  plan: number;
}

const OPERATIONS: Operation[] = [
  { date: '01.10.2026', title: 'Аренда офиса', category: 'Инфраструктура', kind: 'Расход', amount: -180000, status: 'Выполнено', plan: -180000 },
  { date: '03.10.2026', title: 'Подписка Figma', category: 'Софт', kind: 'Расход', amount: -45000, status: 'Выполнено', plan: -42000 },
  { date: '05.10.2026', title: 'Оплата клиента «Норд»', category: 'Выручка', kind: 'Доход', amount: 620000, status: 'Выполнено', plan: 600000 },
  { date: '07.10.2026', title: 'Зарплаты за октябрь', category: 'Команда', kind: 'Расход', amount: -410000, status: 'В процессе', plan: -410000 },
  { date: '08.10.2026', title: 'Хостинг и CDN', category: 'Инфраструктура', kind: 'Расход', amount: -32000, status: 'Выполнено', plan: -30000 },
  { date: '10.10.2026', title: 'Оплата клиента «Вектор»', category: 'Выручка', kind: 'Доход', amount: 480000, status: 'Выполнено', plan: 450000 },
  { date: '12.10.2026', title: 'Консультация по миграции PG', category: 'Выручка', kind: 'Доход', amount: 150000, status: 'В процессе', plan: 120000 },
  { date: '14.10.2026', title: 'Реклама за октябрь', category: 'Маркетинг', kind: 'Расход', amount: -96000, status: 'Выполнено', plan: -80000 },
  { date: '16.10.2026', title: 'Серверы БД, две штуки', category: 'Инфраструктура', kind: 'Расход', amount: -58000, status: 'В процессе', plan: -60000 },
  { date: '18.10.2026', title: 'Подряд: дизайн интерфейса', category: 'Подряд', kind: 'Расход', amount: -120000, status: 'Выполнено', plan: -120000 },
  { date: '20.10.2026', title: 'Продление домена', category: 'Инфраструктура', kind: 'Расход', amount: -12000, status: 'Выполнено', plan: -12000 },
  { date: '22.10.2026', title: 'Оплата клиента «Орион»', category: 'Выручка', kind: 'Доход', amount: 240000, status: 'Запланировано', plan: 300000 },
  { date: '24.10.2026', title: 'Курс по asyncpg', category: 'Обучение', kind: 'Расход', amount: -18000, status: 'Запланировано', plan: -20000 },
];

const STATUS_STYLE: Record<Operation['status'], string> = {
  'Выполнено': 'status-done',
  'В процессе': 'status-progress',
  'Запланировано': 'status-plan',
};

const MONEY = '#,##0 ₽';

const styles = {
  header: {
    bl: 1,
    fs: 11,
    cl: { rgb: HEADER_TEXT },
    bg: { rgb: HEADER_BG },
    ht: 2,
    vt: 2,
    bd: { b: { s: 1, cl: { rgb: BORDER } } },
  },
  'header-left': {
    bl: 1,
    fs: 11,
    cl: { rgb: HEADER_TEXT },
    bg: { rgb: HEADER_BG },
    ht: 1,
    vt: 2,
    bd: { b: { s: 1, cl: { rgb: BORDER } } },
  },
  'header-right': {
    bl: 1,
    fs: 11,
    cl: { rgb: HEADER_TEXT },
    bg: { rgb: HEADER_BG },
    ht: 3,
    vt: 2,
    bd: { b: { s: 1, cl: { rgb: BORDER } } },
  },
  text: { fs: 11, cl: { rgb: TEXT }, vt: 2 },
  muted: { fs: 11, cl: { rgb: MUTED }, vt: 2 },
  money: { fs: 11, cl: { rgb: TEXT }, ht: 3, vt: 2, n: { pattern: MONEY } },
  'money-income': { fs: 11, cl: { rgb: GREEN }, ht: 3, vt: 2, n: { pattern: MONEY } },
  'money-expense': { fs: 11, cl: { rgb: RED }, ht: 3, vt: 2, n: { pattern: MONEY } },
  'money-total': { bl: 1, fs: 11, cl: { rgb: TEXT }, ht: 3, vt: 2, n: { pattern: MONEY } },
  'status-done': { fs: 10, cl: { rgb: GREEN }, bg: { rgb: '#12291F' }, ht: 2, vt: 2 },
  'status-progress': { fs: 10, cl: { rgb: AMBER }, bg: { rgb: '#2C2413' }, ht: 2, vt: 2 },
  'status-plan': { fs: 10, cl: { rgb: PURPLE }, bg: { rgb: '#241D38' }, ht: 2, vt: 2 },
  'total-label': { bl: 1, fs: 11, cl: { rgb: TEXT }, bg: { rgb: '#1A1C25' }, vt: 2 },
  'total-text': { bl: 1, fs: 11, cl: { rgb: TEXT }, bg: { rgb: '#1A1C25' }, vt: 2 },
  percent: { fs: 11, cl: { rgb: TEXT }, ht: 3, vt: 2, n: { pattern: '0%' } },
  'percent-warn': { fs: 11, cl: { rgb: AMBER }, ht: 3, vt: 2, n: { pattern: '0%' } },
};

function buildFinanceSheet() {
  const cellData: Record<number, Record<number, unknown>> = {};

  const header = ['Дата', 'Операция', 'Категория', 'Тип', 'Сумма', 'Статус', 'План', 'Разница'];
  cellData[0] = {};
  header.forEach((value, column) => {
    const style = column === 0 || column === 1 || column === 2
      ? 'header-left'
      : column === 5 || column === 3
        ? 'header'
        : 'header-right';
    cellData[0][column] = { v: value, s: style };
  });

  OPERATIONS.forEach((operation, index) => {
    const row = index + 1;
    const sheetRow = row + 1;
    const difference = operation.amount - operation.plan;
    cellData[row] = {
      0: { v: operation.date, s: 'muted' },
      1: { v: operation.title, s: 'text' },
      2: { v: operation.category, s: 'muted' },
      3: { v: operation.kind, s: 'muted' },
      4: { v: operation.amount, s: operation.kind === 'Доход' ? 'money-income' : 'money' },
      5: { v: operation.status, s: STATUS_STYLE[operation.status] },
      6: { v: operation.plan, s: 'money' },
      7: {
        v: difference,
        f: `=Финансы!E${sheetRow}-Финансы!G${sheetRow}`,
        s: difference > 0 ? 'money-income' : difference < 0 ? 'money-expense' : 'money',
      },
    };
  });

  const totalRow = OPERATIONS.length + 1;
  cellData[totalRow] = {
    0: { v: 'Итого за октябрь', s: 'total-label' },
    1: { s: 'total-text' },
    2: { s: 'total-text' },
    3: { s: 'total-text' },
    4: {
      v: OPERATIONS.reduce((sum, operation) => sum + operation.amount, 0),
      f: `=SUM(Финансы!E2:E${totalRow})`,
      s: 'money-total',
    },
    5: { s: 'total-text' },
    6: {
      v: OPERATIONS.reduce((sum, operation) => sum + operation.plan, 0),
      f: `=SUM(Финансы!G2:G${totalRow})`,
      s: 'money-total',
    },
    7: {
      v: OPERATIONS.reduce((sum, operation) => sum + operation.amount - operation.plan, 0),
      f: `=Финансы!E${totalRow + 1}-Финансы!G${totalRow + 1}`,
      s: 'money-total',
    },
  };

  return {
    id: 'finance',
    name: 'Финансы',
    tabColor: '#8B5CF6',
    rowCount: 200,
    columnCount: 10,
    defaultRowHeight: 28,
    defaultColumnWidth: 110,
    freeze: { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 },
    mergeData: [{ startRow: totalRow, startColumn: 0, endRow: totalRow, endColumn: 3 }],
    cellData,
    rowData: {
      0: { h: 34 },
      [totalRow]: { h: 36 },
    },
    columnData: {
      0: { w: 106 },
      1: { w: 232 },
      2: { w: 142 },
      3: { w: 94 },
      4: { w: 128 },
      5: { w: 130 },
      6: { w: 126 },
      7: { w: 120 },
    },
  };
}

function buildBudgetSheet() {
  const cellData: Record<number, Record<number, unknown>> = {
    0: {
      0: { v: 'Категория', s: 'header-left' },
      1: { v: 'План', s: 'header-right' },
      2: { v: 'Факт', s: 'header-right' },
      3: { v: 'Отклонение', s: 'header-right' },
      4: { v: 'Исполнение', s: 'header-right' },
    },
  };

  const rows: Array<[string, number, number]> = [
    ['Инфраструктура', 282000, 282000],
    ['Команда', 410000, 410000],
    ['Софт', 42000, 45000],
    ['Маркетинг', 80000, 96000],
    ['Подряд', 120000, 120000],
    ['Обучение', 20000, 18000],
  ];

  rows.forEach(([category, plan, fact], index) => {
    const row = index + 1;
    const sheetRow = row + 1;
    const deviation = fact - plan;
    cellData[row] = {
      0: { v: category, s: 'text' },
      1: { v: plan, s: 'money' },
      2: {
        v: fact,
        f: `=-SUMIF(Финансы!$C$2:$C$14,Бюджет!$A${sheetRow},Финансы!$E$2:$E$14)`,
        s: 'money',
      },
      3: {
        v: deviation,
        f: `=Бюджет!C${sheetRow}-Бюджет!B${sheetRow}`,
        s: deviation > 0 ? 'money-expense' : deviation < 0 ? 'money-income' : 'money',
      },
      4: {
        v: plan === 0 ? 0 : fact / plan,
        f: `=IFERROR(Бюджет!C${sheetRow}/Бюджет!B${sheetRow},0)`,
        s: deviation > 0 ? 'percent-warn' : 'percent',
      },
    };
  });

  const totalRow = rows.length + 1;
  cellData[totalRow] = {
    0: { v: 'Итого', s: 'total-label' },
    1: { v: rows.reduce((sum, [, plan]) => sum + plan, 0), f: `=SUM(Бюджет!B2:B${totalRow})`, s: 'money-total' },
    2: { v: rows.reduce((sum, [, , fact]) => sum + fact, 0), f: `=SUM(Бюджет!C2:C${totalRow})`, s: 'money-total' },
    3: { v: 0, f: `=Бюджет!C${totalRow + 1}-Бюджет!B${totalRow + 1}`, s: 'money-total' },
    4: { v: 0, s: 'total-text' },
  };

  return {
    id: 'budget',
    name: 'Бюджет',
    tabColor: '#22D3EE',
    rowCount: 100,
    columnCount: 8,
    defaultRowHeight: 30,
    defaultColumnWidth: 140,
    freeze: { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 },
    mergeData: [],
    cellData,
    rowData: { 0: { h: 34 }, [totalRow]: { h: 36 } },
    columnData: {
      0: { w: 186 },
      1: { w: 138 },
      2: { w: 138 },
      3: { w: 138 },
      4: { w: 128 },
    },
  };
}

export const DEMO_WORKBOOK_ID = 'thule-finance-2026';

export function createDemoWorkbook(): IWorkbookData {
  return {
    id: DEMO_WORKBOOK_ID,
    name: 'Финансы 2026',
    appVersion: '1.2.0',
    locale: LocaleType.RU_RU,
    styles: invertStyleColors(styles),
    sheetOrder: ['finance', 'budget'],
    sheets: {
      finance: buildFinanceSheet(),
      budget: buildBudgetSheet(),
    },
  } as IWorkbookData;
}
