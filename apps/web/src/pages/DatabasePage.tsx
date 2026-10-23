import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ChevronRight,
  Database,
  Eye,
  Lock,
  Pencil,
  Plus,
  SquareTerminal,
  Table2,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { api, type DbConnection } from '../api/client';
import { Button, Spinner, useToast } from '../components/ui';
import { ConnectionDialog } from '../db/ConnectionDialog';
import { SqlConsole } from '../db/SqlConsole';
import { TableView } from '../db/TableView';

export function DatabasePage() {
  const { connectionId, schema, table } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: ['connections'], queryFn: () => api.connections() });
  const [editing, setEditing] = useState<DbConnection | null>(null);
  const creating = search.get('new') === '1';
  const isSql = search.get('view') === 'sql';
  const connection = connections.data?.find((c) => c.id === connectionId);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['connections'] });
  }

  async function remove(target: DbConnection) {
    if (!window.confirm(`Удалить подключение «${target.name}»? Данные в базе не изменятся.`)) return;
    try {
      await api.deleteConnection(target.id);
      await refresh();
      navigate('/db');
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  return (
    <main className="window relative z-10 flex min-w-0 flex-1 overflow-hidden">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-line">
        <div className="flex items-center justify-between px-5 pb-3 pt-6">
          <h1 className="text-[20px] font-bold tracking-tight">Базы данных</h1>
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setSearch({ new: '1' })}>
            Добавить
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {connections.isLoading && <Spinner className="m-4" />}
          {connections.data?.map((c) => (
            <ConnectionTree key={c.id} connection={c} active={c.id === connectionId} schema={schema} table={table} />
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {connection ? (
          <>
            <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
              <Database className="size-4 text-accent" />
              <span className="font-semibold">{connection.name}</span>
              <span className="truncate text-[12px] text-fg-muted">
                {connection.username}@{connection.host}:{connection.port}/{connection.database}
              </span>
              {connection.read_only && (
                <span className="flex items-center gap-1 rounded-md bg-white/[0.04] px-2 py-0.5 text-[12px] text-fg-muted">
                  <Lock className="size-3" /> только чтение
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                <Button
                  size="sm"
                  variant={isSql ? 'secondary' : 'ghost'}
                  icon={<SquareTerminal className="size-4" />}
                  onClick={() => navigate(`/db/${connection.id}?view=sql`)}
                >
                  SQL-консоль
                </Button>
                <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(connection)}>
                  Изменить
                </Button>
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => void remove(connection)}>
                  Удалить
                </Button>
              </div>
            </header>
            {isSql ? (
              <SqlConsole key={connection.id} connectionId={connection.id} workspaceId={connection.workspace_id} />
            ) : schema && table ? (
              <TableView key={`${connection.id}/${schema}/${table}`} connectionId={connection.id} schema={schema} table={table} />
            ) : (
              <EmptyState text="Выберите таблицу слева или откройте SQL-консоль." />
            )}
          </>
        ) : (
          <EmptyState
            text={
              connections.data?.length
                ? 'Выберите подключение слева.'
                : 'Подключите базу PostgreSQL, чтобы просматривать и редактировать таблицы, выполнять запросы и вставлять данные в листы.'
            }
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setSearch({ new: '1' })}>
                Новое подключение
              </Button>
            }
          />
        )}
      </section>

      {(creating || editing) && (
        <ConnectionDialog
          open
          existing={editing}
          onOpenChange={(open) => {
            if (!open) {
              setEditing(null);
              if (creating) setSearch({});
            }
          }}
          onSaved={(saved) => {
            void refresh();
            navigate(`/db/${saved.id}`);
          }}
        />
      )}
    </main>
  );
}

function EmptyState({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <Database className="size-10 text-fg-subtle" strokeWidth={1.25} />
      <p className="max-w-md text-[14px] text-fg-muted">{text}</p>
      {action}
    </div>
  );
}

function ConnectionTree({
  connection,
  active,
  schema,
  table,
}: {
  connection: DbConnection;
  active: boolean;
  schema?: string;
  table?: string;
}) {
  const [open, setOpen] = useState(active);
  const schemas = useQuery({
    queryKey: ['schemas', connection.id],
    queryFn: () => api.schemas(connection.id),
    enabled: open,
    retry: false,
  });
  return (
    <div className="mb-1">
      <div
        className={clsx(
          'flex h-9 items-center gap-1 rounded-lg px-2 text-[14px]',
          active ? 'bg-white/[0.06] text-fg' : 'text-fg/85 hover:bg-white/[0.04]',
        )}
      >
        <button
          onClick={() => setOpen(!open)}
          aria-label={open ? 'Свернуть' : 'Развернуть'}
          className="rounded p-0.5 text-fg-subtle hover:text-fg"
        >
          <ChevronRight className={clsx('size-3.5 transition', open && 'rotate-90')} />
        </button>
        <Link to={`/db/${connection.id}`} onClick={() => setOpen(true)} className="flex min-w-0 flex-1 items-center gap-2">
          <Database className="size-4 shrink-0 text-accent" strokeWidth={1.75} />
          <span className="truncate">{connection.name}</span>
        </Link>
      </div>
      {open && (
        <div className="ml-4 border-l border-line pl-1.5">
          {schemas.isLoading && <Spinner className="m-2" />}
          {schemas.isError && <p className="px-2 py-1 text-[12px] text-bad">{(schemas.error as Error).message}</p>}
          {schemas.data?.map((name) => (
            <SchemaNode
              key={name}
              connectionId={connection.id}
              schema={name}
              initiallyOpen={name === schema || (name === 'public' && !schema)}
              activeTable={name === schema ? table : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SchemaNode({
  connectionId,
  schema,
  initiallyOpen,
  activeTable,
}: {
  connectionId: string;
  schema: string;
  initiallyOpen: boolean;
  activeTable?: string;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const tables = useQuery({
    queryKey: ['tables', connectionId, schema],
    queryFn: () => api.tables(connectionId, schema),
    enabled: open,
  });
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex h-8 w-full items-center gap-1.5 rounded-md px-1.5 text-[13px] text-fg-muted hover:bg-white/[0.04] hover:text-fg"
      >
        <ChevronRight className={clsx('size-3.5 transition', open && 'rotate-90')} />
        {schema}
      </button>
      {open && (
        <div className="ml-3">
          {tables.isLoading && <Spinner className="m-2" />}
          {tables.data?.map((t) => (
            <Link
              key={t.name}
              to={`/db/${connectionId}/t/${encodeURIComponent(schema)}/${encodeURIComponent(t.name)}`}
              title={t.comment ?? undefined}
              className={clsx(
                'flex h-8 items-center gap-2 rounded-md px-2 text-[13px]',
                t.name === activeTable ? 'bg-accent-soft text-fg' : 'text-fg/80 hover:bg-white/[0.04]',
              )}
            >
              {t.kind === 'view' || t.kind === 'materialized_view' ? (
                <Eye className="size-3.5 shrink-0 text-fg-subtle" />
              ) : (
                <Table2 className="size-3.5 shrink-0 text-fg-subtle" />
              )}
              <span className="truncate">{t.name}</span>
            </Link>
          ))}
          {tables.data?.length === 0 && <p className="px-2 py-1 text-[12px] text-fg-subtle">Нет таблиц</p>}
        </div>
      )}
    </div>
  );
}
