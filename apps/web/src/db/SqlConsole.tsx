import { PostgreSQL, sql } from '@codemirror/lang-sql';
import CodeMirror, { keymap, Prec } from '@uiw/react-codemirror';
import type { ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { FileSpreadsheet, Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { api, type QueryResult } from '../api/client';
import { Button, useToast } from '../components/ui';
import { gridTheme } from './grid';

function resultToSnapshot(result: QueryResult, title: string): Record<string, unknown> {
  const sheetId = `s${crypto.randomUUID().slice(0, 8)}`;
  const cellData: Record<number, Record<number, { v: string | number | boolean; t: number; s?: string }>> = {};
  cellData[0] = Object.fromEntries(result.columns.map((c, i) => [i, { v: c.name, t: 1, s: 'h' }]));
  result.rows.forEach((row, r) => {
    const cells: Record<number, { v: string | number | boolean; t: number }> = {};
    row.forEach((value, c) => {
      if (value === null || value === undefined) return;
      if (typeof value === 'number') cells[c] = { v: value, t: 2 };
      else if (typeof value === 'boolean') cells[c] = { v: value ? 1 : 0, t: 3 };
      else cells[c] = { v: String(value), t: 1 };
    });
    cellData[r + 1] = cells;
  });
  return {
    id: crypto.randomUUID(),
    name: title,
    appVersion: '1.2.0',
    locale: 'ruRU',
    styles: { h: { bl: 1, bg: { rgb: '#F1F2F6' } } },
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: 'Результат',
        rowCount: Math.max(result.rows.length + 50, 200),
        columnCount: Math.max(result.columns.length + 5, 26),
        cellData,
        freeze: { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 },
        defaultColumnWidth: 120,
        defaultRowHeight: 26,
      },
    },
    resources: [],
  };
}

export function SqlConsole({ connectionId, workspaceId }: { connectionId: string; workspaceId: string }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [text, setText] = useState('SELECT now();');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);

  async function run(query = text) {
    setBusy(true);
    setError(null);
    const started = performance.now();
    try {
      setResult(await api.query(connectionId, query));
      setElapsed(performance.now() - started);
    } catch (err) {
      setResult(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openAsWorkbook() {
    if (!result) return;
    try {
      const title = 'Результат запроса';
      const wb = await api.createWorkbook(workspaceId, title, 'blank');
      await api.saveSnapshot(wb.id, 0, resultToSnapshot(result, title));
      navigate(`/book/${wb.id}`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  const extensions = useMemo(
    () => [
      sql({ dialect: PostgreSQL }),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              void run(view.state.doc.toString());
              return true;
            },
          },
        ]),
      ),
    ],
    [connectionId],
  );

  const columnDefs = useMemo<ColDef[]>(
    () =>
      result?.columns.map((c, i) => ({
        field: String(i),
        headerName: c.name,
        headerTooltip: c.type,
        valueGetter: (p) => (p.data as unknown[])[i],
        sortable: true,
        resizable: true,
        filter: true,
        cellRenderer: (p: { value: unknown }) =>
          p.value === null ? <span className="text-fg-subtle italic">NULL</span> : String(p.value),
      })) ?? [],
    [result],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line">
        <CodeMirror
          value={text}
          onChange={setText}
          height="180px"
          theme="dark"
          extensions={extensions}
          basicSetup={{ foldGutter: false, highlightActiveLine: false }}
          className="text-[13px] [&_.cm-editor]:!bg-transparent [&_.cm-gutters]:!bg-transparent"
        />
        <div className="flex items-center gap-3 px-4 py-2.5">
          <Button variant="primary" size="sm" icon={<Play className="size-3.5" />} loading={busy} onClick={() => void run()}>
            Выполнить
          </Button>
          <span className="text-[12px] text-fg-subtle">Ctrl+Enter · только чтение</span>
          {result && (
            <span className="text-[12px] text-fg-muted">
              {result.rows.length} строк{result.truncated ? ' (обрезано)' : ''}
              {elapsed !== null && ` · ${Math.round(elapsed)} мс`}
            </span>
          )}
          {result && result.rows.length > 0 && (
            <Button size="sm" className="ml-auto" icon={<FileSpreadsheet className="size-3.5" />} onClick={() => void openAsWorkbook()}>
              Открыть как таблицу
            </Button>
          )}
        </div>
      </div>
      {error && <pre className="m-4 whitespace-pre-wrap rounded-lg bg-bad/10 p-3 text-[13px] text-bad">{error}</pre>}
      {result && (
        <div className="min-h-0 flex-1">
          <AgGridReact theme={gridTheme} rowData={result.rows} columnDefs={columnDefs} enableCellTextSelection />
        </div>
      )}
    </div>
  );
}
