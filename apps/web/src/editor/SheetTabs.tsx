import clsx from 'clsx';
import { Copy, List, Minus, Pencil, Plus, Trash2 } from 'lucide-react';
import { ContextMenu } from 'radix-ui';
import { useState } from 'react';

import { IconButton, Menu, MenuContent, MenuItem, MenuTrigger } from '../components/ui';
import type { FUniver } from './univer';

export interface SheetInfo {
  id: string;
  name: string;
}

export function SheetTabs({
  api,
  sheets,
  activeId,
  readOnly,
  zoom,
  onZoom,
}: {
  api: FUniver | null;
  sheets: SheetInfo[];
  activeId: string;
  readOnly: boolean;
  zoom: number;
  onZoom: (value: number) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const workbook = api?.getActiveWorkbook();
  const sheetById = (id: string) => workbook?.getSheetBySheetId(id) ?? null;

  function activate(id: string) {
    const sheet = sheetById(id);
    if (sheet && workbook) workbook.setActiveSheet(sheet);
  }

  function add() {
    if (!workbook) return;
    const used = new Set(sheets.map((s) => s.name));
    let n = sheets.length + 1;
    while (used.has(`Лист${n}`)) n += 1;
    const sheet = workbook.insertSheet(`Лист${n}`);
    workbook.setActiveSheet(sheet);
  }

  function commitRename() {
    const sheet = renaming ? sheetById(renaming) : null;
    const name = draft.trim();
    if (sheet && name && !sheets.some((s) => s.name === name && s.id !== renaming)) sheet.setName(name);
    setRenaming(null);
  }

  function remove(id: string) {
    const sheet = sheetById(id);
    if (!sheet || !workbook || sheets.length < 2) return;
    if (!window.confirm(`Удалить лист «${sheet.getSheetName()}»?`)) return;
    workbook.deleteSheet(sheet);
  }

  function duplicate(id: string) {
    const sheet = sheetById(id);
    if (sheet && workbook) workbook.duplicateSheet(sheet);
  }

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-t border-line px-3">
      <IconButton label="Добавить лист" disabled={readOnly || !api} onClick={add}>
        <Plus className="size-[17px]" />
      </IconButton>
      <Menu>
        <MenuTrigger asChild>
          <IconButton label="Все листы">
            <List className="size-[17px]" />
          </IconButton>
        </MenuTrigger>
        <MenuContent>
          {sheets.map((sheet) => (
            <MenuItem key={sheet.id} onSelect={() => activate(sheet.id)}>
              <span className={clsx(sheet.id === activeId && 'font-semibold text-accent')}>{sheet.name}</span>
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>

      <div className="ml-2 flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {sheets.map((sheet) =>
          renaming === sheet.id ? (
            <input
              key={sheet.id}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenaming(null);
              }}
              className="h-9 w-32 rounded-lg bg-app px-3 text-[14px] outline-none ring-2 ring-accent/60"
            />
          ) : (
            <ContextMenu.Root key={sheet.id}>
              <ContextMenu.Trigger asChild>
                <button
                  onClick={() => activate(sheet.id)}
                  onDoubleClick={() => {
                    if (readOnly) return;
                    setRenaming(sheet.id);
                    setDraft(sheet.name);
                  }}
                  className={clsx(
                    'relative h-9 shrink-0 rounded-lg px-5 text-[14px] transition',
                    sheet.id === activeId
                      ? 'bg-accent-soft font-semibold text-fg after:absolute after:inset-x-3 after:-bottom-[7px] after:h-[2px] after:rounded-full after:bg-accent'
                      : 'text-fg-muted hover:bg-hover hover:text-fg',
                  )}
                >
                  {sheet.name}
                </button>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="glass z-50 min-w-[200px] rounded-xl p-1.5 text-[13px] shadow-2xl hairline">
                  {[
                    { label: 'Переименовать', icon: Pencil, action: () => (setRenaming(sheet.id), setDraft(sheet.name)) },
                    { label: 'Дублировать', icon: Copy, action: () => duplicate(sheet.id) },
                    { label: 'Удалить', icon: Trash2, action: () => remove(sheet.id), danger: true },
                  ].map(({ label, icon: Icon, action, danger }) => (
                    <ContextMenu.Item
                      key={label}
                      disabled={readOnly || (label === 'Удалить' && sheets.length < 2)}
                      onSelect={action}
                      className={clsx(
                        'flex h-8 items-center gap-2.5 rounded-lg px-2.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent data-[highlighted]:text-white',
                        danger && 'text-bad',
                      )}
                    >
                      <Icon className="size-4 opacity-80" />
                      {label}
                    </ContextMenu.Item>
                  ))}
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ),
        )}
        <IconButton label="Новый лист" disabled={readOnly || !api} onClick={add}>
          <Plus className="size-[17px]" />
        </IconButton>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1 text-[14px]">
        <IconButton label="Уменьшить" onClick={() => onZoom(Math.max(0.5, Math.round((zoom - 0.1) * 10) / 10))}>
          <Minus className="size-4" />
        </IconButton>
        <span className="w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <IconButton label="Увеличить" onClick={() => onZoom(Math.min(2, Math.round((zoom + 0.1) * 10) / 10))}>
          <Plus className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}
