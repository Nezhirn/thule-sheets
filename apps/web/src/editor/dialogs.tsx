import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Play, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { api, type QueryResult } from '../api/client';
import { Avatar, Button, Dialog, Field, Input, Select, Spinner, useToast } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { activeRange } from './actions';
import type { FUniver } from './univer';

const ROLE_LABELS = { owner: 'Владелец', editor: 'Редактор', viewer: 'Читатель' } as const;

export function ShareDialog({
  workbookId,
  open,
  onOpenChange,
  canManage,
}: {
  workbookId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canManage: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const shares = useQuery({ queryKey: ['shares', workbookId], queryFn: () => api.shares(workbookId), enabled: open });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor'>('editor');
  const [busy, setBusy] = useState(false);

  async function invite() {
    setBusy(true);
    try {
      await api.share(workbookId, email.trim(), role);
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: ['shares', workbookId] });
      toast('Доступ открыт', 'success');
    } catch (error) {
      toast((error as { status?: number }).status === 404 ? 'Пользователь с таким email не найден' : (error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(userId: string) {
    await api.unshare(workbookId, userId);
    await queryClient.invalidateQueries({ queryKey: ['shares', workbookId] });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Поделиться таблицей" width={520}>
      {canManage && (
        <div className="mb-5 flex gap-2">
          <Input
            placeholder="email коллеги"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && email && void invite()}
          />
          <Select value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')} className="w-36">
            <option value="editor">Редактор</option>
            <option value="viewer">Читатель</option>
          </Select>
          <Button variant="primary" loading={busy} disabled={!email} onClick={() => void invite()}>
            Пригласить
          </Button>
        </div>
      )}
      <div className="text-[12px] font-medium uppercase tracking-wider text-fg-subtle">Есть доступ</div>
      <ul className="mt-2 flex flex-col">
        {shares.isLoading && <Spinner className="m-4" />}
        {shares.data?.map((share) => (
          <li key={`${share.source}-${share.user_id}`} className="flex items-center gap-3 rounded-lg px-1 py-2">
            <Avatar name={share.name} size={30} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px]">{share.name}</div>
              <div className="truncate text-[12px] text-fg-muted">{share.email}</div>
            </div>
            <span className="text-[12px] text-fg-muted">
              {ROLE_LABELS[share.role]}
              {share.source === 'workspace' && ' · пространство'}
            </span>
            {canManage && share.source === 'share' && (
              <button
                aria-label="Закрыть доступ"
                onClick={() => void revoke(share.user_id)}
                className="rounded-md p-1 text-fg-subtle hover:bg-hover hover:text-bad"
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export function VersionsDialog({
  workbookId,
  open,
  onOpenChange,
  canRestore,
  onRestored,
}: {
  workbookId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canRestore: boolean;
  onRestored: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const versions = useQuery({
    queryKey: ['versions', workbookId],
    queryFn: () => api.versions(workbookId),
    enabled: open,
  });
  const [label, setLabel] = useState('');

  async function save() {
    await api.createVersion(workbookId, label.trim() || null);
    setLabel('');
    await queryClient.invalidateQueries({ queryKey: ['versions', workbookId] });
    toast('Версия сохранена', 'success');
  }

  async function restore(id: string) {
    if (!window.confirm('Восстановить эту версию? Текущее состояние сохранится как отдельная версия.')) return;
    try {
      await api.restoreVersion(workbookId, id);
      onRestored();
      onOpenChange(false);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="История версий"
      description="Автоматическая версия сохраняется не чаще раза в 30 минут."
      width={520}
    >
      {canRestore && (
        <div className="mb-4 flex gap-2">
          <Input placeholder="Название версии" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button icon={<History className="size-4" />} onClick={() => void save()}>
            Сохранить версию
          </Button>
        </div>
      )}
      {versions.isLoading && <Spinner />}
      <ul className="flex flex-col gap-1">
        {versions.data?.map((version) => (
          <li key={version.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/[0.03]">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px]">{version.label ?? formatDateTime(version.created_at)}</div>
              <div className="text-[12px] text-fg-muted">
                {version.label ? `${formatDateTime(version.created_at)} · ` : ''}
                {version.author ?? 'неизвестно'} · ревизия {version.rev}
              </div>
            </div>
            {canRestore && (
              <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => void restore(version.id)}>
                Восстановить
              </Button>
            )}
          </li>
        ))}
        {versions.data?.length === 0 && <li className="text-[13px] text-fg-muted">Версий пока нет.</li>}
      </ul>
    </Dialog>
  );
}

/** Run a read-only SQL query and write the result into the sheet at the active cell. */
export function InsertFromDbDialog({
  univer,
  open,
  onOpenChange,
}: {
  univer: FUniver | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const connections = useQuery({ queryKey: ['connections'], queryFn: () => api.connections(), enabled: open });
  const [connectionId, setConnectionId] = useState('');
  const [sql, setSql] = useState('SELECT * FROM ');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = connectionId || connections.data?.[0]?.id || '';

  async function runQuery() {
    setBusy(true);
    try {
      setResult(await api.query(selected, sql, 5000));
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function insert() {
    if (!univer || !result) return;
    const range = activeRange(univer);
    const sheet = univer.getActiveWorkbook()?.getActiveSheet();
    if (!range || !sheet) return;
    const { startRow, startColumn } = range.getRange();
    const values = [
      result.columns.map((c) => c.name),
      ...result.rows.map((row) => row.map((v) => (v === null ? '' : (v as string | number | boolean)))),
    ];
    const needRows = startRow + values.length - sheet.getMaxRows();
    if (needRows > 0) sheet.insertRowsAfter(sheet.getMaxRows() - 1, needRows);
    const needCols = startColumn + values[0].length - sheet.getMaxColumns();
    if (needCols > 0) sheet.insertColumnsAfter(sheet.getMaxColumns() - 1, needCols);
    sheet.getRange(startRow, startColumn, values.length, values[0].length).setValues(values);
    sheet.getRange(startRow, startColumn, 1, values[0].length).setFontWeight('bold');
    toast(`Вставлено строк: ${result.rows.length}`, 'success');
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Данные из PostgreSQL"
      description="Результат запроса вставится, начиная с выделенной ячейки. Запрос выполняется только на чтение."
      width={680}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button variant="primary" disabled={!result?.rows.length} onClick={insert}>
            Вставить {result ? `(${result.rows.length})` : ''}
          </Button>
        </>
      }
    >
      {connections.data?.length === 0 ? (
        <p className="text-[13px] text-fg-muted">Сначала добавьте подключение в разделе «Базы данных».</p>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="Подключение">
            <Select value={selected} onChange={(e) => setConnectionId(e.target.value)}>
              {connections.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.database}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="SQL">
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              spellCheck={false}
              rows={5}
              className="w-full rounded-[10px] bg-app/60 p-3 font-mono text-[13px] outline-none hairline focus:border-accent/60"
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button icon={<Play className="size-4" />} loading={busy} disabled={!selected} onClick={() => void runQuery()}>
              Выполнить
            </Button>
            {result && (
              <span className="text-[12px] text-fg-muted">
                {result.rows.length} строк × {result.columns.length} столбцов
                {result.truncated && ' (результат обрезан)'}
              </span>
            )}
          </div>
          {result && (
            <div className="max-h-56 overflow-auto rounded-lg hairline">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-raised">
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c.name} className="px-2 py-1.5 text-left font-medium text-fg-muted">
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, 50).map((row, i) => (
                    <tr key={i} className="border-t border-line">
                      {row.map((v, j) => (
                        <td key={j} className="max-w-48 truncate px-2 py-1">
                          {v === null ? <span className="text-fg-subtle">NULL</span> : String(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
