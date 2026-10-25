import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Lock, Pencil, Plus, SquareTerminal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { api, type DbConnection } from '../api/client';
import { Button, Spinner, useToast } from '../components/ui';
import { ConnectionDialog } from '../db/ConnectionDialog';
import { SqlConsole } from '../db/SqlConsole';
import { DbSheet } from '../db/DbSheet';

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
      <section className="flex min-w-0 flex-1 flex-col">
        {connections.isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-6" />
          </div>
        ) : connection ? (
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
              <DbSheet key={`${connection.id}/${schema}/${table}`} connectionId={connection.id} schema={schema} table={table} />
            ) : (
              <EmptyState text="Выберите таблицу слева или откройте SQL-консоль." />
            )}
          </>
        ) : (
          <EmptyState
            text={
              connections.data?.length
                ? 'Выберите подключение в боковой панели.'
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
