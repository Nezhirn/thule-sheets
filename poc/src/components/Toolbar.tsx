import type { FUniver } from '@univerjs/presets';
import type { SelectionStyle } from '../univer/actions';
import { applyToSelection } from '../univer/actions';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  Italic,
  Merge,
  Percent,
  Redo2,
  RussianRuble,
  Type,
  Underline,
  Undo2,
} from 'lucide-react';

interface ToolbarProps {
  api: FUniver | null;
  style: SelectionStyle | null;
  onChanged: () => void;
}

const FONT_FAMILIES = ['Inter Variable', 'Arial', 'Georgia', 'Courier New'];
const FONT_SIZES = [9, 10, 11, 12, 14, 16, 18, 24, 32];

export function Toolbar({ api, style, onChanged }: ToolbarProps) {
  const run = (apply: Parameters<typeof applyToSelection>[1]) => {
    if (!api) {
      return;
    }
    if (applyToSelection(api, apply)) {
      onChanged();
    }
  };

  const align = style?.align ?? 'left';

  return (
    <div className="toolbar" role="toolbar" aria-label="Форматирование">
      <button className="icon-btn" title="Отменить (⌘Z)" disabled={!api} onClick={() => api?.undo().then(onChanged)}>
        <Undo2 size={16} />
      </button>
      <button className="icon-btn" title="Повторить (⇧⌘Z)" disabled={!api} onClick={() => api?.redo().then(onChanged)}>
        <Redo2 size={16} />
      </button>

      <span className="toolbar-sep" />

      <label className="select-wrap select-font">
        <select
          value={style?.fontFamily ?? 'Inter Variable'}
          onChange={(event) => run((range) => range.setFontFamily(event.target.value))}
          title="Шрифт"
        >
          {FONT_FAMILIES.map((family) => (
            <option key={family} value={family}>{family}</option>
          ))}
        </select>
        <ChevronDown size={13} className="select-chevron" />
      </label>

      <label className="select-wrap select-size">
        <select
          value={style?.fontSize ?? 11}
          onChange={(event) => run((range) => range.setFontSize(Number(event.target.value)))}
          title="Размер шрифта"
        >
          {FONT_SIZES.map((size) => (
            <option key={size} value={size}>{size}</option>
          ))}
        </select>
        <ChevronDown size={13} className="select-chevron" />
      </label>

      <span className="toolbar-sep" />

      <button
        className={`icon-btn ${style?.bold ? 'is-active' : ''}`}
        title="Полужирный (⌘B)"
        onClick={() => run((range) => range.setFontWeight(style?.bold ? 'normal' : 'bold'))}
      >
        <Bold size={16} />
      </button>
      <button
        className={`icon-btn ${style?.italic ? 'is-active' : ''}`}
        title="Курсив (⌘I)"
        onClick={() => run((range) => range.setFontStyle(style?.italic ? 'normal' : 'italic'))}
      >
        <Italic size={16} />
      </button>
      <button
        className={`icon-btn ${style?.underline ? 'is-active' : ''}`}
        title="Подчёркнутый (⌘U)"
        onClick={() => run((range) => range.setFontLine(style?.underline ? 'none' : 'underline'))}
      >
        <Underline size={16} />
      </button>

      <span className="toolbar-sep" />

      <label className="color-btn" title="Цвет текста">
        <Type size={15} />
        <span className="color-swatch" style={{ background: style?.color ?? '#ECEDF2' }} />
        <input
          type="color"
          value={style?.color ?? '#ECEDF2'}
          onChange={(event) => run((range) => range.setFontColor(event.target.value))}
        />
      </label>
      <label className="color-btn" title="Заливка ячейки">
        <span className="fill-glyph" />
        <span className="color-swatch" style={{ background: style?.background ?? '#101218' }} />
        <input
          type="color"
          value={style?.background ?? '#101218'}
          onChange={(event) => run((range) => range.setBackgroundColor(event.target.value))}
        />
      </label>

      <span className="toolbar-sep" />

      <button
        className={`icon-btn ${align === 'left' ? 'is-active' : ''}`}
        title="По левому краю"
        onClick={() => run((range) => range.setHorizontalAlignment('left'))}
      >
        <AlignLeft size={16} />
      </button>
      <button
        className={`icon-btn ${align === 'center' ? 'is-active' : ''}`}
        title="По центру"
        onClick={() => run((range) => range.setHorizontalAlignment('center'))}
      >
        <AlignCenter size={16} />
      </button>
      <button
        className={`icon-btn ${align === 'right' ? 'is-active' : ''}`}
        title="По правому краю"
        onClick={() => run((range) => range.setHorizontalAlignment('normal'))}
      >
        <AlignRight size={16} />
      </button>

      <span className="toolbar-sep" />

      <button className="icon-btn" title="Объединить ячейки" onClick={() => run((range) => { range.merge(); })}>
        <Merge size={16} />
      </button>
      <button
        className="icon-btn"
        title="Формат валюты"
        onClick={() => run((range) => range.setNumberFormat('#,##0 ₽'))}
      >
        <RussianRuble size={16} />
      </button>
      <button
        className="icon-btn"
        title="Процентный формат"
        onClick={() => run((range) => range.setNumberFormat('0%'))}
      >
        <Percent size={16} />
      </button>

      <span className="toolbar-spacer" />
      <button className="toolbar-zoom" title="Масштаб">
        100%
        <ChevronDown size={13} />
      </button>
    </div>
  );
}
