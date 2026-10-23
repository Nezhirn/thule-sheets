import { Bell, ChevronRight, Lock, Search, Share2 } from 'lucide-react';

const AVATARS = [
  { initials: 'А', color: '#8B5CF6' },
  { initials: 'М', color: '#22D3EE' },
  { initials: 'К', color: '#F59E0B' },
];

export function TopBar() {
  return (
    <header className="topbar">
      <div className="breadcrumbs">
        <span>Рабочие пространства</span>
        <ChevronRight size={13} />
        <span>Финансы</span>
        <ChevronRight size={13} />
        <strong>Финансы 2026</strong>
      </div>

      <div className="topbar-right">
        <label className="search-field">
          <Search size={14} />
          <input placeholder="Поиск по таблице" aria-label="Поиск по таблице" />
          <kbd>⌘K</kbd>
        </label>

        <div className="avatar-stack" title="Сейчас в документе: 3 человека">
          {AVATARS.map((avatar) => (
            <span key={avatar.initials} className="avatar" style={{ background: avatar.color }}>
              {avatar.initials}
            </span>
          ))}
        </div>

        <button className="icon-btn" title="Уведомления">
          <Bell size={16} />
        </button>

        <button className="btn btn-ghost">
          <Lock size={14} />
          Доступ
        </button>
        <button className="btn btn-primary">
          <Share2 size={14} />
          Поделиться
        </button>
      </div>
    </header>
  );
}
