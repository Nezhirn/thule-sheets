const money = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 0 });
const relative = new Intl.RelativeTimeFormat('ru-RU', { numeric: 'auto' });
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function formatNumber(value: number): string {
  return money.format(value);
}

export function formatMoney(value: number): string {
  return `${money.format(value)} ₽`;
}

export function formatPercent(value: number): string {
  return percent.format(value);
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  const diff = (date.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return 'только что';
  if (abs < 3600) return relative.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return relative.format(Math.round(diff / 86400), 'day');
  return dateFmt.format(date);
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${dateFmt.format(date)}, ${timeFmt.format(date)}`;
}
