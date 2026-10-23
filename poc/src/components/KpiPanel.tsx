import { Activity, ArrowDownRight, ArrowUpRight, PieChart, Wallet } from 'lucide-react';
import type { KpiSnapshot } from '../univer/actions';
import { formatMoney, formatPercent } from '../univer/actions';

interface KpiPanelProps {
  kpi: KpiSnapshot | null;
}

export function KpiPanel({ kpi }: KpiPanelProps) {
  const execution = kpi && kpi.planExpense > 0 ? kpi.expense / kpi.planExpense : 0;
  const coverage = kpi && kpi.expense > 0 ? kpi.balance / kpi.income : 0;
  const categories = kpi?.categories.slice(0, 3) ?? [];

  return (
    <section className="kpi-panel" aria-label="Показатели периода">
      <article className="kpi-card">
        <header className="kpi-head">
          <span className="kpi-label">Доходы</span>
          <span className="kpi-icon income"><ArrowUpRight size={14} /></span>
        </header>
        <div className="kpi-value">{kpi ? formatMoney(kpi.income) : '—'}</div>
        <footer className="kpi-foot">
          <span className="kpi-pill income">{kpi ? kpi.incomeCount : 0} поступления</span>
          <span className="kpi-note">план {kpi ? formatMoney(kpi.planIncome) : '—'}</span>
        </footer>
      </article>

      <article className="kpi-card">
        <header className="kpi-head">
          <span className="kpi-label">Расходы</span>
          <span className="kpi-icon expense"><ArrowDownRight size={14} /></span>
        </header>
        <div className="kpi-value">{kpi ? formatMoney(kpi.expense) : '—'}</div>
        <footer className="kpi-foot">
          <span className="kpi-pill expense">{kpi ? formatPercent(execution) : '—'} плана</span>
          <span className="kpi-note">план {kpi ? formatMoney(kpi.planExpense) : '—'}</span>
        </footer>
      </article>

      <article className="kpi-card">
        <header className="kpi-head">
          <span className="kpi-label">Остаток</span>
          <span className="kpi-icon balance"><Wallet size={14} /></span>
        </header>
        <div className={`kpi-value ${kpi && kpi.balance < 0 ? 'negative' : ''}`}>
          {kpi ? formatMoney(kpi.balance) : '—'}
        </div>
        <footer className="kpi-foot kpi-foot-column">
          <div className="kpi-progress" aria-hidden="true">
            <span style={{ width: `${Math.min(100, Math.max(0, coverage * 100))}%` }} />
          </div>
          <span className="kpi-note">
            {kpi ? formatPercent(coverage) : '—'} доходов остаётся после расходов
          </span>
        </footer>
      </article>

      <article className="kpi-card kpi-card-structure">
        <header className="kpi-head">
          <span className="kpi-label">Структура расходов</span>
          <span className="kpi-icon structure"><PieChart size={14} /></span>
        </header>
        <div className="structure-list">
          {categories.length === 0 && <span className="kpi-note">Нет данных за период</span>}
          {categories.map((category) => (
            <div key={category.name} className="structure-row">
              <span className="structure-name">{category.name}</span>
              <span className="structure-track">
                <span style={{ width: `${Math.max(2, category.share * 100)}%` }} />
              </span>
              <span className="structure-share">{formatPercent(category.share)}</span>
            </div>
          ))}
        </div>
        <footer className="kpi-foot">
          <span className="kpi-live">
            <Activity size={12} />
            пересчёт по листу
          </span>
        </footer>
      </article>
    </section>
  );
}
