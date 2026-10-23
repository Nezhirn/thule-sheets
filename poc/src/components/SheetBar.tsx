import { ChevronDown, Plus } from 'lucide-react';
import { plural } from '../lib/plural';

export interface SheetTab {
  id: string;
  name: string;
  color?: string;
  active: boolean;
}

interface SheetBarProps {
  tabs: SheetTab[];
  onSelect: (sheetId: string) => void;
  onAdd: () => void;
}

export function SheetBar({ tabs, onSelect, onAdd }: SheetBarProps) {
  return (
    <div className="sheet-bar">
      <div className="sheet-tabs">
        <button className="add-sheet-btn" title="Добавить лист" onClick={onAdd}>
          <Plus size={15} />
        </button>
        <span className="sheet-bar-sep" />
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`sheet-tab ${tab.active ? 'is-active' : ''}`}
            onClick={() => onSelect(tab.id)}
            title={tab.name}
          >
            <span className="sheet-tab-dot" style={{ background: tab.color ?? '#8B5CF6' }} />
            {tab.name}
          </button>
        ))}
      </div>

      <div className="sheet-bar-right">
        <span className="sheet-count">
          {tabs.length} {plural(tabs.length, ['лист', 'листа', 'листов'])}
        </span>
        <span className="sheet-bar-sep" />
        <button className="sheet-zoom" title="Масштаб">
          100%
          <ChevronDown size={12} />
        </button>
      </div>
    </div>
  );
}
