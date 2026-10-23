import clsx from 'clsx';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  ChevronDown,
  Filter,
  Grid3x3,
  Italic,
  MoreHorizontal,
  PaintBucket,
  Paintbrush,
  Redo2,
  Search,
  Strikethrough,
  Underline,
  Undo2,
  WrapText,
} from 'lucide-react';
import { Popover } from 'radix-ui';
import type { ReactNode } from 'react';

import { IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../components/ui';
import {
  commands,
  displayColor,
  FONT_FAMILIES,
  FONT_SIZES,
  NUMBER_FORMATS,
  PALETTE,
  type SelectionState,
} from './actions';
import type { FUniver } from './univer';

function Divider() {
  return <span className="mx-1.5 h-5 w-px shrink-0 bg-line-strong" />;
}

function Dropdown({
  value,
  width,
  children,
  label,
}: {
  value: ReactNode;
  width: number;
  children: ReactNode;
  label: string;
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          aria-label={label}
          style={{ width }}
          className="flex h-8 shrink-0 items-center justify-between gap-2 rounded-lg bg-white/[0.03] px-2.5 text-[13px] text-fg hairline transition hover:bg-hover"
        >
          <span className="truncate">{value}</span>
          <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" />
        </button>
      </MenuTrigger>
      <MenuContent>{children}</MenuContent>
    </Menu>
  );
}

function ColorPicker({
  label,
  icon,
  current,
  onPick,
  onReset,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  current: string | null;
  onPick: (color: string) => void;
  onReset: () => void;
  disabled?: boolean;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton label={label} disabled={disabled}>
          <span className="flex flex-col items-center">
            {icon}
            <span
              className="-mt-0.5 h-[3px] w-4 rounded-full"
              style={{ background: current ? displayColor(current) : 'transparent' }}
            />
          </span>
          <ChevronDown className="size-3 text-fg-subtle" />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className="glass z-50 rounded-xl p-3 shadow-2xl hairline">
          <button
            onClick={onReset}
            className="mb-2 w-full rounded-md px-2 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
          >
            Сбросить
          </button>
          <div className="grid grid-cols-8 gap-1.5">
            {PALETTE.map((color) => (
              <Popover.Close key={color} asChild>
                <button
                  aria-label={color}
                  title={color}
                  onClick={() => onPick(color)}
                  className={clsx(
                    'size-5 rounded-full ring-1 ring-white/10 transition hover:scale-110',
                    current?.toUpperCase() === color && 'ring-2 ring-accent',
                  )}
                  style={{ background: displayColor(color) }}
                />
              </Popover.Close>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function Toolbar({
  api,
  selection,
  readOnly,
  zoom,
  onZoom,
}: {
  api: FUniver | null;
  selection: SelectionState;
  readOnly: boolean;
  zoom: number;
  onZoom: (value: number) => void;
}) {
  const disabled = !api || readOnly;
  const call = (fn: (api: FUniver) => void) => () => api && fn(api);
  const format = NUMBER_FORMATS.find((f) => f.pattern === selection.numberFormat);

  return (
    <div className="flex h-12 min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden px-3 [scrollbar-width:none]">
      <IconButton label="Отменить (Ctrl+Z)" disabled={disabled} onClick={call(commands.undo)}>
        <Undo2 className="size-[17px]" />
      </IconButton>
      <IconButton label="Повторить (Ctrl+Y)" disabled={disabled} onClick={call(commands.redo)}>
        <Redo2 className="size-[17px]" />
      </IconButton>
      <Divider />
      <IconButton label="Копировать форматирование" disabled={disabled} onClick={call(commands.formatPainter)}>
        <Paintbrush className="size-[17px]" />
      </IconButton>
      <IconButton label="Найти и заменить (Ctrl+F)" disabled={!api} onClick={call(commands.find)}>
        <Search className="size-[17px]" />
      </IconButton>
      <Divider />

      <Dropdown label="Масштаб" width={84} value={`${Math.round(zoom * 100)}%`}>
        {[0.5, 0.75, 0.9, 1, 1.25, 1.5, 2].map((value) => (
          <MenuItem key={value} onSelect={() => onZoom(value)}>
            {Math.round(value * 100)}%
          </MenuItem>
        ))}
      </Dropdown>
      <Divider />

      <Dropdown label="Шрифт" width={128} value={selection.fontFamily}>
        {FONT_FAMILIES.map((font) => (
          <MenuItem key={font} disabled={disabled} onSelect={() => api && commands.fontFamily(api, font)}>
            <span style={{ fontFamily: font }}>{font}</span>
          </MenuItem>
        ))}
      </Dropdown>
      <span className="w-1.5" />
      <Dropdown label="Размер шрифта" width={64} value={selection.fontSize}>
        {FONT_SIZES.map((size) => (
          <MenuItem key={size} disabled={disabled} onSelect={() => api && commands.fontSize(api, size)}>
            {size}
          </MenuItem>
        ))}
      </Dropdown>
      <Divider />

      <IconButton label="Жирный (Ctrl+B)" active={selection.bold} disabled={disabled} onClick={call(commands.bold)}>
        <Bold className="size-[17px]" strokeWidth={2.4} />
      </IconButton>
      <IconButton label="Курсив (Ctrl+I)" active={selection.italic} disabled={disabled} onClick={call(commands.italic)}>
        <Italic className="size-[17px]" />
      </IconButton>
      <IconButton
        label="Подчёркнутый (Ctrl+U)"
        active={selection.underline}
        disabled={disabled}
        onClick={call(commands.underline)}
      >
        <Underline className="size-[17px]" />
      </IconButton>
      <IconButton
        label="Зачёркнутый"
        active={selection.strike}
        disabled={disabled}
        onClick={() => api && commands.strike(api, !selection.strike)}
      >
        <Strikethrough className="size-[17px]" />
      </IconButton>
      <ColorPicker
        label="Цвет текста"
        icon={<Baseline className="size-[17px]" />}
        current={selection.color}
        disabled={disabled}
        onPick={(color) => api && commands.textColor(api, color)}
        onReset={call(commands.resetTextColor)}
      />
      <ColorPicker
        label="Цвет заливки"
        icon={<PaintBucket className="size-[17px]" />}
        current={selection.background}
        disabled={disabled}
        onPick={(color) => api && commands.background(api, color)}
        onReset={call(commands.resetBackground)}
      />
      <Divider />

      <Menu>
        <MenuTrigger asChild>
          <IconButton label="Границы" disabled={disabled}>
            <Grid3x3 className="size-[17px]" />
            <ChevronDown className="size-3 text-fg-subtle" />
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          {[
            ['all', 'Все границы'],
            ['outside', 'Внешние'],
            ['inside', 'Внутренние'],
            ['top', 'Сверху'],
            ['bottom', 'Снизу'],
            ['left', 'Слева'],
            ['right', 'Справа'],
          ].map(([type, label]) => (
            <MenuItem key={type} onSelect={() => api && commands.border(api, type)}>
              {label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => api && commands.border(api, 'none')}>Без границ</MenuItem>
        </MenuContent>
      </Menu>
      <Divider />

      <IconButton
        label="По левому краю"
        active={selection.hAlign === 'left'}
        disabled={disabled}
        onClick={() => api && commands.hAlign(api, 'left')}
      >
        <AlignLeft className="size-[17px]" />
      </IconButton>
      <IconButton
        label="По центру"
        active={selection.hAlign === 'center'}
        disabled={disabled}
        onClick={() => api && commands.hAlign(api, 'center')}
      >
        <AlignCenter className="size-[17px]" />
      </IconButton>
      <IconButton
        label="По правому краю"
        active={selection.hAlign === 'right'}
        disabled={disabled}
        onClick={() => api && commands.hAlign(api, 'right')}
      >
        <AlignRight className="size-[17px]" />
      </IconButton>
      <IconButton
        label="Переносить текст"
        active={selection.wrap}
        disabled={disabled}
        onClick={() => api && commands.wrap(api, !selection.wrap)}
      >
        <WrapText className="size-[17px]" />
      </IconButton>
      <Divider />

      <Dropdown label="Числовой формат" width={150} value={format?.label ?? selection.numberFormat}>
        {NUMBER_FORMATS.map((option) => (
          <MenuItem
            key={option.id}
            disabled={disabled}
            onSelect={() => api && commands.numberFormat(api, option.pattern)}
            shortcut={option.example}
          >
            {option.label}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem disabled={disabled} onSelect={() => api && commands.addDecimal(api)}>
          Добавить знак после запятой
        </MenuItem>
        <MenuItem disabled={disabled} onSelect={() => api && commands.subtractDecimal(api)}>
          Убрать знак после запятой
        </MenuItem>
      </Dropdown>
      <Divider />

      <IconButton label="Фильтр" disabled={disabled} onClick={call(commands.toggleFilter)}>
        <Filter className="size-[17px]" />
      </IconButton>
      <Menu>
        <MenuTrigger asChild>
          <IconButton label="Ещё" disabled={!api}>
            <MoreHorizontal className="size-[17px]" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem disabled={disabled} onSelect={call(commands.merge)}>
            Объединить ячейки
          </MenuItem>
          <MenuItem disabled={disabled} onSelect={call(commands.unmerge)}>
            Разъединить ячейки
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={disabled} onSelect={() => api && commands.vAlign(api, 'top')}>
            По верхнему краю
          </MenuItem>
          <MenuItem disabled={disabled} onSelect={() => api && commands.vAlign(api, 'middle')}>
            По середине
          </MenuItem>
          <MenuItem disabled={disabled} onSelect={() => api && commands.vAlign(api, 'bottom')}>
            По нижнему краю
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={disabled} onSelect={call(commands.conditionalFormatting)}>
            Условное форматирование…
          </MenuItem>
          <MenuItem disabled={disabled} onSelect={call(commands.dataValidation)}>
            Проверка данных…
          </MenuItem>
          <MenuItem disabled={disabled} onSelect={call(commands.clearFormat)}>
            Очистить форматирование
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
