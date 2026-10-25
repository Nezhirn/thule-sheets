import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Filter,
  KeyRound,
  ListPlus,
  Lock,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { Popover } from 'radix-ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type DbTableInfo, type FilterOp, type RowsRequest } from '../api/client';
import { Button, Input, Select, Spinner, Tooltip, useToast } from '../components/ui';
import { EMPTY_SELECTION, readSelection, type SelectionState } from '../editor/actions';
import { FormulaBar } from '../editor/FormulaBar';
import { useInversion } from '../editor/inversion';
import { InvertButton } from '../editor/Toolbar';
import { bootUniver, type FUniver } from '../editor/univer';
import { formatNumber } from '../lib/format';
import { useSaveShortcut, useUnsavedGuard } from '../lib/unsaved';
import { DbSheetController, type Query, type SheetState } from './sheetController';

const READ_ONLY_REASONS: Record<NonNullable<DbTableInfo['read_only_reason']>, string> = {
  connection: 'Подключение только для чтения',
  not_a_table: 'Это представление — редактирование недоступно',
  no_primary_key: 'У таблицы нет первичного ключа — редактирование недоступно',
};

const FILTER_OPS: Array<{ op: FilterOp; label: string; noValue?: boolean }> = [
  { op: 'eq', label: '=' },
  { op: 'neq', label: '≠' },
  { op: 'lt', label: '<' },
  { op: 'lte', label: '≤' },
  { op: 'gt', label: '>' },
  { op: 'gte', label: '≥' },
  { op: 'contains', label: 'содержит' },
  { op: 'not_contains', label: 'не содержит' },
  { op: 'starts_with', label: 'начинается с' },
  { op: 'is_null', label: 'пусто (NULL)', noValue: true },
  { op: 'not_null', label: 'не пусто', noValue: true },
];

const EMPTY_STATE: SheetState = {
  loading: true,
  total: 0,
  totalExact: true,
  truncated: false,
  edited: 0,
  inserted: 0,
  deleted: 0,
};

export function DbSheet({ connectionId, schema, table }: { connectionId: string; schema: string; table: string }) {
  const toast = useToast();
  const info = useQuery({
    queryKey: ['table', connectionId, schema, table],
    queryFn: () => api.table(connectionId, schema, table),
  });
  const meta = info.data;

  const container = useRef<HTMLDivElement>(null);
  const controller = useRef<DbSheetController | null>(null);
  const [univer, setUniver] = useState<FUniver | null>(null);
  const [state, setState] = useState<SheetState>(EMPTY_STATE);
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [query, setQuery] = useState<Query>({ sort: [], filters: [] });
  const [saving, setSaving] = useState(false);

  const dirty = state.edited + state.inserted + state.deleted > 0;
  const [inverted, toggleInverted] = useInversion(univer);

  useEffect(() => {
    if (!meta || !container.current) return;
    const handle = bootUniver(container.current, { contextMenu: false, textFormatMarks: false });
    const ctrl = new DbSheetController(handle.api, {
      connectionId,
      schema,
      table,
      meta,
      onState: setState,
      onNotice: (message, kind) => toast(message, kind),
    });
    controller.current = ctrl;
    // SelectionChanged is not wired for workbooks created after the first render (Univer 1.2),
    // so follow the selection operation instead.
    const selectionSub = handle.api.addEvent(handle.api.Event.CommandExecuted, (event) => {
      if (event.id === 'sheet.operation.set-selections') setSelection(readSelection(handle.api));
    });
    void ctrl.load({ sort: [], filters: [] }).then(() => setSelection(readSelection(handle.api)));
    setUniver(handle.api);
    return () => {
      selectionSub.dispose();
      ctrl.dispose();
      controller.current = null;
      setUniver(null);
      // Univer schedules work after dispose in StrictMode remounts; defer the teardown.
      window.setTimeout(() => handle.dispose(), 0);
    };
  }, [meta, connectionId, schema, table, toast]);

  const save = useCallback(async (): Promise<boolean> => {
    const ctrl = controller.current;
    // One save at a time: a second Ctrl+S would send the same new rows again.
    if (!ctrl || ctrl.isSaving) return false;
    setSaving(true);
    try {
      return await ctrl.save();
    } finally {
      setSaving(false);
    }
  }, []);

  const saveShortcut = useCallback(() => {
    if (controller.current?.dirty) void save();
  }, [save]);
  useSaveShortcut(saveShortcut, !!meta && (meta.can_update || meta.can_insert || meta.can_delete));
  const guard = useUnsavedGuard(dirty, save);

  /** Return keyboard focus to the sheet after a toolbar action. */
  function focusSheet() {
    requestAnimationFrame(() => {
      const host = container.current;
      // Univer reads keystrokes from its hidden cell editor element.
      const editor =
        host?.querySelector<HTMLElement>('[data-u-comp="editor"][id*="INTERNAL_EDITOR"]') ??
        host?.querySelector<HTMLElement>('[data-u-comp="editor"]');
      editor?.focus();
    });
  }

  function reload(next: Query = query) {
    if (dirty && !window.confirm('Несохранённые изменения будут потеряны. Продолжить?')) return false;
    setQuery(next);
    void controller.current?.load(next);
    return true;
  }

  if (info.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (info.isError || !meta) {
    return <div className="p-6 text-[13px] text-bad">{(info.error as Error)?.message ?? 'Таблица недоступна'}</div>;
  }

  const editable = meta.can_update || meta.can_insert || meta.can_delete;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <div className="flex h-10 shrink-0 items-center gap-2 px-2">
        <div className="min-w-0 truncate">
          <span className="text-fg-muted">{schema}.</span>
          <span className="font-semibold">{table}</span>
        </div>
        <span className="shrink-0 text-[12px] text-fg-muted">
          {state.loading
            ? 'загрузка…'
            : `${state.totalExact ? '' : '≈ '}${formatNumber(state.total)} строк${state.truncated ? ' (показан первый миллион)' : ''}`}
        </span>
        {meta.primary_key.length > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-fg-subtle">
            <KeyRound className="size-3.5" /> {meta.primary_key.join(', ')}
          </span>
        )}
        {meta.read_only_reason && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-1 text-[12px] text-fg-muted">
            <Lock className="size-3.5" /> {READ_ONLY_REASONS[meta.read_only_reason]}
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <SortControl meta={meta} query={query} onApply={(sort) => reload({ ...query, sort })} />
          <FilterControl meta={meta} query={query} onApply={(filters) => reload({ ...query, filters })} />
          {meta.can_insert && (
            <Tooltip label="Новые строки вводятся под последней строкой таблицы">
              <Button size="sm" variant="ghost" icon={<ListPlus className="size-4" />} onClick={() => {
                  controller.current?.focusNewRow();
                  focusSheet();
                }}>
                Строка
              </Button>
            </Tooltip>
          )}
          {meta.can_delete && (
            <Tooltip label="Пометить выделенные строки на удаление (повторно — снять пометку)">
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="size-4" />}
                onClick={() => {
                  controller.current?.toggleDeleteSelection();
                  focusSheet();
                }}
              >
                Удалить строки
              </Button>
            </Tooltip>
          )}
          <Tooltip label="Перечитать таблицу из базы">
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} disabled={saving} onClick={() => reload()}>
              Обновить
            </Button>
          </Tooltip>
          <InvertButton
            inverted={inverted}
            disabled={!univer}
            onToggle={() => {
              toggleInverted();
              focusSheet();
            }}
          />
        </div>
      </div>

      {editable && (
        <div className="flex shrink-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <FormulaBar api={univer} selection={selection} readOnly={!editable} />
          </div>
          <div className={clsx('flex shrink-0 items-center gap-2', !dirty && 'invisible')}>
            <span className="text-[12px] text-warn">
              {[
                state.edited && `изменено: ${state.edited}`,
                state.inserted && `новых: ${state.inserted}`,
                state.deleted && `к удалению: ${state.deleted}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} disabled={saving} onClick={() => reload()}>
              Отменить
            </Button>
            <Button size="sm" variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => void save()}>
              Сохранить
            </Button>
          </div>
        </div>
      )}

      <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[#101016] hairline">
        <div ref={container} className="univer-host min-h-0 flex-1" />
        {state.loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#101016]/60">
            <Spinner className="size-6" />
          </div>
        )}
      </section>
      {guard}
    </div>
  );
}

function SortControl({
  meta,
  query,
  onApply,
}: {
  meta: DbTableInfo;
  query: Query;
  onApply: (sort: RowsRequest['sort']) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = query.sort[0];
  const [column, setColumn] = useState(current?.column ?? meta.columns[0]?.name ?? '');

  function apply(desc: boolean | null) {
    if (onApply(desc === null ? [] : [{ column, desc }])) setOpen(false);
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          size="sm"
          variant={current ? 'secondary' : 'ghost'}
          icon={current?.desc ? <ArrowUpAZ className="size-4" /> : <ArrowDownAZ className="size-4" />}
        >
          {current ? `${current.column} ${current.desc ? '↓' : '↑'}` : 'Сортировка'}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="glass z-50 w-[280px] rounded-xl p-3 shadow-2xl hairline">
          <div className="mb-2 text-[12px] text-fg-muted">Сортировать по столбцу</div>
          <Select value={column} onChange={(e) => setColumn(e.target.value)}>
            {meta.columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
          <div className="mt-3 flex gap-2">
            <Button size="sm" className="flex-1" icon={<ArrowDownAZ className="size-4" />} onClick={() => apply(false)}>
              По возрастанию
            </Button>
            <Button size="sm" className="flex-1" icon={<ArrowUpAZ className="size-4" />} onClick={() => apply(true)}>
              По убыванию
            </Button>
          </div>
          {current && (
            <Button size="sm" variant="ghost" className="mt-2 w-full" onClick={() => apply(null)}>
              Сбросить сортировку
            </Button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

type Condition = { column: string; op: FilterOp; value: string };

function FilterControl({
  meta,
  query,
  onApply,
}: {
  meta: DbTableInfo;
  query: Query;
  onApply: (filters: RowsRequest['filters']) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Condition[]>([]);

  useEffect(() => {
    if (!open) return;
    const existing = query.filters.map((f) => ({ column: f.column, op: f.op, value: f.value ?? '' }));
    setRows(existing.length ? existing : [{ column: meta.columns[0]?.name ?? '', op: 'eq', value: '' }]);
  }, [open, query.filters, meta.columns]);

  function update(index: number, patch: Partial<Condition>) {
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function apply(next: Condition[]) {
    const filters = next
      .filter((row) => row.column)
      .map((row) => {
        const noValue = FILTER_OPS.find((o) => o.op === row.op)?.noValue;
        return { column: row.column, op: row.op, value: noValue ? null : row.value };
      });
    if (onApply(filters)) setOpen(false);
  }

  const active = query.filters.length;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button size="sm" variant={active ? 'secondary' : 'ghost'} icon={<Filter className="size-4" />}>
          {active ? `Фильтры: ${active}` : 'Фильтр'}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="glass z-50 w-[520px] rounded-xl p-3 shadow-2xl hairline">
          <div className="mb-2 text-[12px] text-fg-muted">Показывать строки, где выполняются все условия</div>
          <div className="flex flex-col gap-2">
            {rows.map((row, index) => {
              const noValue = FILTER_OPS.find((o) => o.op === row.op)?.noValue;
              return (
                <div key={index} className="flex items-center gap-2">
                  <Select className="w-[150px]" value={row.column} onChange={(e) => update(index, { column: e.target.value })}>
                    {meta.columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                  <Select className="w-[140px]" value={row.op} onChange={(e) => update(index, { op: e.target.value as FilterOp })}>
                    {FILTER_OPS.map((o) => (
                      <option key={o.op} value={o.op}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  <Input
                    className={clsx('flex-1', noValue && 'invisible')}
                    value={row.value}
                    placeholder="значение"
                    onChange={(e) => update(index, { value: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && apply(rows)}
                  />
                  <button
                    aria-label="Убрать условие"
                    className="rounded-md p-1 text-fg-subtle hover:bg-hover hover:text-fg"
                    onClick={() => setRows(rows.filter((_, i) => i !== index))}
                  >
                    <X className="size-4" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-4" />}
              onClick={() => setRows([...rows, { column: meta.columns[0]?.name ?? '', op: 'eq', value: '' }])}
            >
              Условие
            </Button>
            <div className="ml-auto flex gap-2">
              {active > 0 && (
                <Button size="sm" variant="ghost" onClick={() => apply([])}>
                  Сбросить
                </Button>
              )}
              <Button size="sm" variant="primary" onClick={() => apply(rows)}>
                Применить
              </Button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
