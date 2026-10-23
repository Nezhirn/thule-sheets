import { useQuery } from '@tanstack/react-query';
import type {
  CellValueChangedEvent,
  ColDef,
  GridApi,
  GridReadyEvent,
  IDatasource,
  IGetRowsParams,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { KeyRound, Lock, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { api, type DbColumn, type DbTableInfo, type FilterOp, type RowsRequest } from '../api/client';
import { Button, Dialog, Field, Input, Select, Spinner, useToast } from '../components/ui';
import { formatNumber } from '../lib/format';
import { gridTheme } from './grid';

type Row = Record<string, string | null>;

const READ_ONLY_REASONS: Record<NonNullable<DbTableInfo['read_only_reason']>, string> = {
  connection: 'Подключение только для чтения',
  not_a_table: 'Это представление — редактирование недоступно',
  no_primary_key: 'У таблицы нет первичного ключа — редактирование недоступно',
};

const NUMERIC = new Set(['N']);

const TEXT_OPS: Record<string, FilterOp> = {
  contains: 'contains',
  notContains: 'not_contains',
  equals: 'eq',
  notEqual: 'neq',
  startsWith: 'starts_with',
  endsWith: 'contains',
  blank: 'is_null',
  notBlank: 'not_null',
};
const NUMBER_OPS: Record<string, FilterOp> = {
  equals: 'eq',
  notEqual: 'neq',
  lessThan: 'lt',
  lessThanOrEqual: 'lte',
  greaterThan: 'gt',
  greaterThanOrEqual: 'gte',
  blank: 'is_null',
  notBlank: 'not_null',
};

function field(index: number) {
  return `c${index}`;
}

function toFilters(model: Record<string, Record<string, unknown>>, columns: DbColumn[]): RowsRequest['filters'] {
  const filters: RowsRequest['filters'] = [];
  for (const [key, spec] of Object.entries(model ?? {})) {
    const column = columns[Number(key.slice(1))];
    if (!column) continue;
    const type = String(spec.type);
    const numeric = spec.filterType === 'number';
    if (numeric && type === 'inRange') {
      filters.push({ column: column.name, op: 'gte', value: String(spec.filter) });
      filters.push({ column: column.name, op: 'lte', value: String(spec.filterTo) });
      continue;
    }
    const op = (numeric ? NUMBER_OPS : TEXT_OPS)[type];
    if (!op) continue;
    filters.push({ column: column.name, op, value: spec.filter === undefined ? null : String(spec.filter) });
  }
  return filters;
}

export function TableView({ connectionId, schema, table }: { connectionId: string; schema: string; table: string }) {
  const toast = useToast();
  const gridApi = useRef<GridApi<Row> | null>(null);
  const [total, setTotal] = useState<{ count: number; exact: boolean } | null>(null);
  const [selectedCount, setSelectedCount] = useState(0);
  const [adding, setAdding] = useState(false);

  const info = useQuery({
    queryKey: ['table', connectionId, schema, table],
    queryFn: () => api.table(connectionId, schema, table),
  });
  const meta = info.data;

  const columnDefs = useMemo<ColDef<Row>[]>(() => {
    if (!meta) return [];
    const pk = new Set(meta.primary_key);
    return meta.columns.map((column, index) => {
      const editable = meta.can_update && !pk.has(column.name) && !column.is_generated;
      const def: ColDef<Row> = {
        field: field(index),
        headerName: column.name,
        headerTooltip: `${column.type}${column.not_null ? ' NOT NULL' : ''}${column.comment ? ` — ${column.comment}` : ''}`,
        editable,
        sortable: true,
        resizable: true,
        filter: NUMERIC.has(column.category) ? 'agNumberColumnFilter' : 'agTextColumnFilter',
        filterParams: { maxNumConditions: 1, buttons: ['reset'] },
        minWidth: 90,
        cellClass: NUMERIC.has(column.category) ? 'tabular-nums text-right' : undefined,
        cellRenderer: (p: { value: string | null }) =>
          p.value === null || p.value === undefined ? <span className="text-fg-subtle italic">NULL</span> : p.value,
      };
      if (pk.has(column.name)) {
        def.headerComponentParams = {};
        def.headerClass = 'text-accent';
        def.pinned = 'left';
      }
      if (column.enum_values) {
        def.cellEditor = 'agSelectCellEditor';
        def.cellEditorParams = { values: column.not_null ? column.enum_values : ['', ...column.enum_values] };
      } else if (column.category === 'B') {
        def.cellEditor = 'agSelectCellEditor';
        def.cellEditorParams = { values: column.not_null ? ['true', 'false'] : ['', 'true', 'false'] };
      }
      return def;
    });
  }, [meta]);

  const datasource = useMemo<IDatasource | undefined>(() => {
    if (!meta) return undefined;
    return {
      getRows: (params: IGetRowsParams) => {
        const sort = params.sortModel.map((s) => ({
          column: meta.columns[Number(s.colId.slice(1))].name,
          desc: s.sort === 'desc',
        }));
        api
          .rows(connectionId, schema, table, {
            offset: params.startRow,
            limit: params.endRow - params.startRow,
            sort,
            filters: toFilters(params.filterModel as Record<string, Record<string, unknown>>, meta.columns),
          })
          .then((page) => {
            const rows = page.rows.map((values) => Object.fromEntries(values.map((v, i) => [field(i), v])));
            const lastRow = rows.length < params.endRow - params.startRow ? params.startRow + rows.length : -1;
            setTotal({ count: page.total, exact: page.total_exact });
            params.successCallback(rows, lastRow);
          })
          .catch((error: Error) => {
            toast(error.message, 'error');
            params.failCallback();
          });
      },
    };
  }, [meta, connectionId, schema, table, toast]);

  const keyOf = useCallback(
    (row: Row) => {
      if (!meta) return {};
      return Object.fromEntries(
        meta.primary_key.map((name) => [name, row[field(meta.columns.findIndex((c) => c.name === name))] ?? null]),
      );
    },
    [meta],
  );

  async function onCellValueChanged(event: CellValueChangedEvent<Row>) {
    if (!meta || event.oldValue === event.newValue) return;
    const index = Number(event.colDef.field!.slice(1));
    const column = meta.columns[index];
    const raw = event.newValue as string | null;
    const value = raw === '' && !column.not_null ? null : raw;
    try {
      const result = await api.updateRows(connectionId, schema, table, [
        { pk: keyOf(event.data), values: { [column.name]: value }, expected: { [column.name]: event.oldValue } },
      ]);
      const updated = result.rows[0];
      event.node.setData(Object.fromEntries(updated.map((v, i) => [field(i), v])));
    } catch (error) {
      event.node.setDataValue(event.colDef.field!, event.oldValue);
      toast((error as Error).message, 'error');
    }
  }

  async function deleteSelected() {
    const rows = gridApi.current?.getSelectedRows() ?? [];
    if (!rows.length || !meta) return;
    if (!window.confirm(`Удалить строк: ${rows.length}? Это изменит данные в базе.`)) return;
    try {
      const result = await api.deleteRows(connectionId, schema, table, rows.map(keyOf));
      toast(`Удалено строк: ${result.deleted}`, 'success');
      gridApi.current?.deselectAll();
      gridApi.current?.refreshInfiniteCache();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <div className="min-w-0">
          <span className="text-fg-muted">{schema}.</span>
          <span className="font-semibold">{table}</span>
        </div>
        <span className="text-[12px] text-fg-muted">
          {total ? `${total.exact ? '' : '≈ '}${formatNumber(total.count)} строк` : ''}
        </span>
        {meta.primary_key.length > 0 && (
          <span className="flex items-center gap-1 text-[12px] text-fg-subtle">
            <KeyRound className="size-3.5" /> {meta.primary_key.join(', ')}
          </span>
        )}
        {meta.read_only_reason && (
          <span className="flex items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-1 text-[12px] text-fg-muted">
            <Lock className="size-3.5" /> {READ_ONLY_REASONS[meta.read_only_reason]}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {meta.can_delete && selectedCount > 0 && (
            <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => void deleteSelected()}>
              Удалить ({selectedCount})
            </Button>
          )}
          {meta.can_insert && (
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
              Строка
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw className="size-3.5" />}
            onClick={() => gridApi.current?.refreshInfiniteCache()}
          >
            Обновить
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <AgGridReact<Row>
          theme={gridTheme}
          columnDefs={columnDefs}
          rowModelType="infinite"
          datasource={datasource}
          cacheBlockSize={200}
          maxBlocksInCache={20}
          getRowId={meta.primary_key.length ? (p) => JSON.stringify(keyOf(p.data)) : undefined}
          rowSelection={meta.can_delete ? { mode: 'multiRow', checkboxes: true, headerCheckbox: false } : undefined}
          onSelectionChanged={(e) => setSelectedCount(e.api.getSelectedRows().length)}
          onGridReady={(e: GridReadyEvent<Row>) => (gridApi.current = e.api)}
          onCellValueChanged={(e) => void onCellValueChanged(e)}
          defaultColDef={{ flex: 0, width: 160 }}
          stopEditingWhenCellsLoseFocus
          singleClickEdit={false}
          enableCellTextSelection
          ensureDomOrder
        />
      </div>
      {adding && (
        <InsertRowDialog
          meta={meta}
          onClose={() => setAdding(false)}
          onSubmit={async (values) => {
            try {
              await api.insertRow(connectionId, schema, table, values);
              toast('Строка добавлена', 'success');
              setAdding(false);
              gridApi.current?.refreshInfiniteCache();
            } catch (error) {
              toast((error as Error).message, 'error');
            }
          }}
        />
      )}
    </div>
  );
}

function InsertRowDialog({
  meta,
  onClose,
  onSubmit,
}: {
  meta: DbTableInfo;
  onClose: () => void;
  onSubmit: (values: Record<string, string | null>) => Promise<void>;
}) {
  const writable = meta.columns.filter((c) => !c.is_generated);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    // Columns left empty are omitted so the database default (or NULL) applies.
    const payload = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
    await onSubmit(payload);
    setBusy(false);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Новая строка"
      description="Пустые поля получат значение по умолчанию."
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Добавить
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {writable.map((column) => (
          <Field
            key={column.name}
            label={`${column.name}${column.not_null && !column.has_default && !column.is_identity ? ' *' : ''}`}
            hint={`${column.type}${column.has_default || column.is_identity ? ' · есть значение по умолчанию' : ''}`}
          >
            {column.enum_values || column.category === 'B' ? (
              <Select
                value={values[column.name] ?? ''}
                onChange={(e) => setValues({ ...values, [column.name]: e.target.value })}
              >
                <option value="">—</option>
                {(column.enum_values ?? ['true', 'false']).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                value={values[column.name] ?? ''}
                onChange={(e) => setValues({ ...values, [column.name]: e.target.value })}
              />
            )}
          </Field>
        ))}
      </div>
    </Dialog>
  );
}
