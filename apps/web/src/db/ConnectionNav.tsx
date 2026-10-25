/**
 * Database connections in the main sidebar: each connection expands into its schemas and
 * tables. In the collapsed sidebar a connection opens a menu with the same tree.
 */
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronRight, Database, Eye, SquareTerminal, Table2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useMatch, useNavigate } from 'react-router';

import { api, type DbConnection, type DbTable } from '../api/client';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Spinner, Tooltip } from '../components/ui';

function tablePath(connectionId: string, schema: string, table: string) {
  return `/db/${connectionId}/t/${encodeURIComponent(schema)}/${encodeURIComponent(table)}`;
}

/** Connection, schema and table currently open in the database page. */
function useActiveTarget() {
  const tableMatch = useMatch('/db/:connectionId/t/:schema/:table');
  const connectionMatch = useMatch('/db/:connectionId');
  const params = tableMatch?.params ?? connectionMatch?.params;
  return {
    connectionId: params?.connectionId,
    schema: tableMatch?.params.schema,
    table: tableMatch?.params.table,
  };
}

function TableIcon({ kind }: { kind: DbTable['kind'] }) {
  return kind === 'view' || kind === 'materialized_view' ? (
    <Eye className="size-3.5 shrink-0 text-fg-subtle" />
  ) : (
    <Table2 className="size-3.5 shrink-0 text-fg-subtle" />
  );
}

export function ConnectionNav({ connections, collapsed }: { connections: DbConnection[]; collapsed: boolean }) {
  const active = useActiveTarget();
  return (
    <>
      {connections.map((connection) =>
        collapsed ? (
          <CollapsedConnection key={connection.id} connection={connection} active={connection.id === active.connectionId} />
        ) : (
          <ConnectionNode
            key={connection.id}
            connection={connection}
            active={connection.id === active.connectionId}
            schema={connection.id === active.connectionId ? active.schema : undefined}
            table={connection.id === active.connectionId ? active.table : undefined}
          />
        ),
      )}
    </>
  );
}

function ConnectionNode({
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
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  const schemas = useQuery({
    queryKey: ['schemas', connection.id],
    queryFn: () => api.schemas(connection.id),
    enabled: open,
    retry: false,
  });

  return (
    <div>
      <div
        className={clsx(
          'group flex h-10 items-center rounded-xl pr-1 text-[15px] transition',
          active && !table ? 'bg-white/[0.07] text-fg' : 'text-fg/80 hover:bg-white/[0.04] hover:text-fg',
        )}
      >
        <Link
          to={`/db/${connection.id}`}
          onClick={() => setOpen(true)}
          className="flex h-full min-w-0 flex-1 items-center gap-3 pl-3"
        >
          <Database className="size-[18px] shrink-0 opacity-80" strokeWidth={1.75} />
          <span className="truncate">{connection.name}</span>
        </Link>
        <button
          onClick={() => setOpen(!open)}
          aria-label={open ? 'Свернуть' : 'Развернуть'}
          aria-expanded={open}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition hover:bg-white/[0.06] hover:text-fg"
        >
          <ChevronRight className={clsx('size-4 transition', open && 'rotate-90')} />
        </button>
      </div>
      {open && (
        <div className="mb-1 ml-[21px] border-l border-line pl-1.5">
          {schemas.isLoading && <Spinner className="m-2" />}
          {schemas.isError && <p className="px-2 py-1 text-[12px] text-bad">{(schemas.error as Error).message}</p>}
          {schemas.data?.map((name) => (
            <SchemaNode
              key={name}
              connectionId={connection.id}
              schema={name}
              initiallyOpen={name === schema || (name === 'public' && !schema) || schemas.data.length === 1}
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
  useEffect(() => {
    if (activeTable) setOpen(true);
  }, [activeTable]);
  const tables = useQuery({
    queryKey: ['tables', connectionId, schema],
    queryFn: () => api.tables(connectionId, schema),
    enabled: open,
  });
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex h-8 w-full items-center gap-1.5 rounded-md px-1.5 text-[13px] text-fg-muted hover:bg-white/[0.04] hover:text-fg"
      >
        <ChevronRight className={clsx('size-3.5 shrink-0 transition', open && 'rotate-90')} />
        <span className="truncate">{schema}</span>
      </button>
      {open && (
        <div className="ml-3">
          {tables.isLoading && <Spinner className="m-2" />}
          {tables.data?.map((t) => (
            <Link
              key={t.name}
              to={tablePath(connectionId, schema, t.name)}
              title={t.comment ?? t.name}
              className={clsx(
                'flex h-8 items-center gap-2 rounded-md px-2 text-[13px]',
                t.name === activeTable ? 'bg-accent-soft text-fg' : 'text-fg/80 hover:bg-white/[0.04] hover:text-fg',
              )}
            >
              <TableIcon kind={t.kind} />
              <span className="truncate">{t.name}</span>
            </Link>
          ))}
          {tables.data?.length === 0 && <p className="px-2 py-1 text-[12px] text-fg-subtle">Нет таблиц</p>}
        </div>
      )}
    </div>
  );
}

/** Collapsed sidebar: the connection icon opens a menu with its tables. */
function CollapsedConnection({ connection, active }: { connection: DbConnection; active: boolean }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip label={connection.name} side="right" delay={150}>
        <MenuTrigger asChild>
          <button
            aria-label={connection.name}
            className={clsx(
              'flex h-10 items-center justify-center rounded-xl transition',
              active ? 'bg-white/[0.07] text-fg' : 'text-fg/80 hover:bg-white/[0.04] hover:text-fg',
            )}
          >
            <Database className="size-[18px] shrink-0 opacity-80" strokeWidth={1.75} />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent side="right">
        <MenuLabel>{connection.name}</MenuLabel>
        <MenuItem
          icon={<SquareTerminal className="size-4" />}
          onSelect={() => navigate(`/db/${connection.id}?view=sql`)}
        >
          SQL-консоль
        </MenuItem>
        {open && <CollapsedTables connectionId={connection.id} />}
      </MenuContent>
    </Menu>
  );
}

function CollapsedTables({ connectionId }: { connectionId: string }) {
  const schemas = useQuery({
    queryKey: ['schemas', connectionId],
    queryFn: () => api.schemas(connectionId),
    retry: false,
  });
  if (schemas.isLoading) return <Spinner className="m-2" />;
  if (schemas.isError) return <p className="px-2.5 py-1 text-[12px] text-bad">{(schemas.error as Error).message}</p>;
  return (
    <>
      {schemas.data?.map((schema) => (
        <CollapsedSchema key={schema} connectionId={connectionId} schema={schema} />
      ))}
    </>
  );
}

function CollapsedSchema({ connectionId, schema }: { connectionId: string; schema: string }) {
  const navigate = useNavigate();
  const tables = useQuery({
    queryKey: ['tables', connectionId, schema],
    queryFn: () => api.tables(connectionId, schema),
  });
  return (
    <>
      <MenuSeparator />
      <MenuLabel>{schema}</MenuLabel>
      {tables.isLoading && <Spinner className="m-2" />}
      {tables.data?.map((t) => (
        <MenuItem
          key={t.name}
          icon={<TableIcon kind={t.kind} />}
          onSelect={() => navigate(tablePath(connectionId, schema, t.name))}
        >
          {t.name}
        </MenuItem>
      ))}
      {tables.data?.length === 0 && <p className="px-2.5 py-1 text-[12px] text-fg-subtle">Нет таблиц</p>}
    </>
  );
}
