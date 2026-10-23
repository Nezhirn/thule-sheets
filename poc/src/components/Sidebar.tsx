import {
  Clock3,
  Database,
  Home,
  Plus,
  Settings2,
  Share2,
  Star,
  Table2,
  Users,
} from 'lucide-react';

const NAV_ITEMS = [
  { label: 'Главная', icon: Home, active: true },
  { label: 'Недавние', icon: Clock3 },
  { label: 'Избранное', icon: Star },
  { label: 'Общий доступ', icon: Users },
];

const WORKSPACES = [
  { label: 'Личное', color: '#8B5CF6', count: 4 },
  { label: 'Работа', color: '#22D3EE', count: 9 },
  { label: 'Проекты', color: '#FBBF24', count: 3 },
];

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <Table2 size={16} strokeWidth={2.2} />
        </span>
        <span className="brand-name">Thule Sheets</span>
        <span className="brand-beta">beta</span>
      </div>

      <button className="new-sheet-btn">
        <Plus size={15} strokeWidth={2.4} />
        Новая таблица
        <kbd>⌘N</kbd>
      </button>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map(({ label, icon: Icon, active }) => (
          <button key={label} className={`nav-item ${active ? 'is-active' : ''}`}>
            <Icon size={15} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="section-label">Рабочие пространства</div>
      <div className="workspace-list">
        {WORKSPACES.map((workspace) => (
          <button key={workspace.label} className="workspace-item">
            <span className="workspace-dot" style={{ background: workspace.color }} />
            <span>{workspace.label}</span>
            <span className="workspace-count">{workspace.count}</span>
          </button>
        ))}
        <button className="workspace-item workspace-add">
          <Plus size={13} />
          <span>Добавить</span>
        </button>
      </div>

      <div className="section-label">Подключения</div>
      <div className="connection-card">
        <div className="connection-head">
          <span className="connection-icon">
            <Database size={14} />
          </span>
          <span className="connection-name">ai_base</span>
          <span className="connection-status" title="Подключение активно" />
        </div>
        <div className="connection-meta">localhost:5432 · 12 таблиц</div>
        <div className="connection-tag">только чтение</div>
      </div>

      <div className="sidebar-footer">
        <div className="user-card">
          <span className="avatar avatar-user">А</span>
          <span className="user-text">
            <span className="user-name">Андрей</span>
            <span className="user-role">self-hosted</span>
          </span>
          <button className="icon-btn ghost" title="Настройки">
            <Settings2 size={15} />
          </button>
        </div>
        <div className="sidebar-hint">
          <Share2 size={12} />
          Локальная установка · без облака
        </div>
      </div>
    </aside>
  );
}
