import { Check, Clock3, MessageSquare, MoreHorizontal, Star } from 'lucide-react';
import { plural } from '../lib/plural';

interface DocumentHeaderProps {
  saveState: 'saved' | 'saving';
  sheetCount: number;
}

const MENU_ITEMS = ['Файл', 'Правка', 'Вид', 'Вставка', 'Формат', 'Данные', 'Инструменты', 'Справка'];

export function DocumentHeader({ saveState, sheetCount }: DocumentHeaderProps) {
  return (
    <div className="doc-header">
      <div className="doc-title-row">
        <h1 className="doc-title">Финансы 2026</h1>
        <button className="icon-btn ghost" title="В избранное">
          <Star size={15} />
        </button>
        <span className={`save-state ${saveState}`}>
          {saveState === 'saved' ? <Check size={13} /> : <Clock3 size={13} />}
          {saveState === 'saved' ? 'Сохранено' : 'Сохранение…'}
        </span>
      </div>

      <div className="doc-meta">
        <span>
          {sheetCount} {plural(sheetCount, ['лист', 'листа', 'листов'])}
        </span>
        <span className="dot-sep" />
        <span>Обновлено только что</span>
        <span className="dot-sep" />
        <span>PostgreSQL · ai_base</span>
      </div>

      <div className="doc-actions">
        <button className="icon-btn" title="Комментарии">
          <MessageSquare size={16} />
        </button>
        <button className="icon-btn" title="История версий">
          <Clock3 size={16} />
        </button>
        <button className="icon-btn" title="Ещё">
          <MoreHorizontal size={17} />
        </button>
      </div>
    </div>
  );
}

export function MenuBar() {
  return (
    <div className="menubar" role="menubar">
      {MENU_ITEMS.map((item) => (
        <button key={item} className="menu-item" role="menuitem">
          {item}
        </button>
      ))}
    </div>
  );
}
