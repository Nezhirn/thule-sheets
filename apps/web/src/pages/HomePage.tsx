import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  FileSpreadsheet,
  FileUp,
  LayoutTemplate,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Sheet,
  Star,
  Trash2,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { api, type WorkbookItem } from '../api/client';
import {
  Button,
  Dialog,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Spinner,
  useToast,
} from '../components/ui';
import { formatWhen } from '../lib/format';

type View = 'all' | 'recent' | 'favorites' | 'shared';

const TITLES: Record<View, { title: string; empty: string }> = {
  all: { title: 'Главная', empty: 'Создайте первую таблицу или импортируйте файл XLSX / CSV.' },
  recent: { title: 'Недавние', empty: 'Здесь появятся таблицы, которые вы открывали.' },
  favorites: { title: 'Избранное', empty: 'Отмечайте таблицы звёздочкой, чтобы они были под рукой.' },
  shared: { title: 'Общий доступ', empty: 'Таблицы, которыми с вами поделились, появятся здесь.' },
};

export function HomePage({ view = 'all' }: { view?: View }) {
  const { workspaceId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [renaming, setRenaming] = useState<WorkbookItem | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.workspaces });
  const workspace = workspaces.data?.find((w) => w.id === workspaceId);
  const targetWorkspace = workspace ?? workspaces.data?.find((w) => w.is_personal);
  const canCreate = !workspace || workspace.role !== 'viewer';

  const listKey = ['workbooks', view, workspaceId ?? null, q];
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => api.workbooks({ view, workspace_id: workspaceId, q }),
  });

  const heading = workspace ? workspace.name : TITLES[view].title;

  async function refreshList() {
    await queryClient.invalidateQueries({ queryKey: ['workbooks'] });
  }

  async function create(template: 'blank' | 'finance') {
    if (!targetWorkspace) return;
    setBusy(true);
    try {
      const title = template === 'finance' ? 'Финансы 2026' : 'Новая таблица';
      const wb = await api.createWorkbook(targetWorkspace.id, title, template);
      navigate(`/book/${wb.id}`);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    if (!targetWorkspace) return;
    setBusy(true);
    try {
      const result = await api.importFile(targetWorkspace.id, file);
      navigate(`/book/${result.id}`);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function toggleFavorite(item: WorkbookItem) {
    await api.setFavorite(item.id, !item.favorite);
    await refreshList();
  }

  async function remove(item: WorkbookItem) {
    if (!window.confirm(`Удалить таблицу «${item.title}»? Это действие необратимо.`)) return;
    try {
      await api.deleteWorkbook(item.id);
      await refreshList();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  async function rename() {
    if (!renaming) return;
    try {
      await api.updateWorkbook(renaming.id, { title: newTitle.trim() });
      setRenaming(null);
      await refreshList();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  return (
    <main className="window relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center gap-4 px-8 pb-4 pt-7">
        <h1 className="text-[28px] font-bold tracking-tight">{heading}</h1>
        <div className="ml-auto flex items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск таблиц"
              className="w-64 pl-9"
            />
          </div>
          {canCreate && (
            <Menu>
              <MenuTrigger asChild>
                <Button variant="primary" loading={busy} icon={<Plus className="size-4" />}>
                  Создать
                </Button>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuItem icon={<Sheet className="size-4" />} onSelect={() => void create('blank')}>
                  Пустая таблица
                </MenuItem>
                <MenuItem icon={<LayoutTemplate className="size-4" />} onSelect={() => void create('finance')}>
                  Шаблон «Личные финансы»
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<FileUp className="size-4" />} onSelect={() => fileInput.current?.click()}>
                  Импорт XLSX / CSV…
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xlsm,.csv,.tsv,.txt"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8">
        {list.isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : list.data?.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {list.data.map((item) => (
              <article
                key={item.id}
                onClick={() => navigate(`/book/${item.id}`)}
                className="group cursor-default overflow-hidden rounded-2xl bg-panel-2 hairline transition hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[0_18px_40px_-20px_rgba(0,0,0,0.8)]"
              >
                <div className="relative h-28 overflow-hidden bg-gradient-to-br from-[#1c1830] to-[#121218]">
                  <SheetPreview />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleFavorite(item);
                    }}
                    aria-label={item.favorite ? 'Убрать из избранного' : 'В избранное'}
                    className={clsx(
                      'absolute right-2.5 top-2.5 rounded-lg p-1.5 transition',
                      item.favorite ? 'text-warn' : 'text-fg-subtle opacity-0 hover:text-fg group-hover:opacity-100',
                    )}
                  >
                    <Star className="size-4" fill={item.favorite ? 'currentColor' : 'none'} />
                  </button>
                </div>
                <div className="flex items-start gap-3 p-4">
                  <FileSpreadsheet className="mt-0.5 size-5 shrink-0 text-accent" strokeWidth={1.75} />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[15px] font-medium">{item.title}</h3>
                    <p className="mt-0.5 truncate text-[12px] text-fg-muted">
                      {item.workspace_name} · {formatWhen(view === 'recent' && item.viewed_at ? item.viewed_at : item.updated_at)}
                    </p>
                  </div>
                  <Menu>
                    <MenuTrigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Действия"
                        className="rounded-md p-1 text-fg-subtle hover:bg-hover hover:text-fg"
                      >
                        <MoreHorizontal className="size-4" />
                      </button>
                    </MenuTrigger>
                    <MenuContent align="end">
                      <MenuItem
                        icon={<Pencil className="size-4" />}
                        disabled={item.role === 'viewer'}
                        onSelect={() => {
                          setRenaming(item);
                          setNewTitle(item.title);
                        }}
                      >
                        Переименовать
                      </MenuItem>
                      <MenuItem icon={<Star className="size-4" />} onSelect={() => void toggleFavorite(item)}>
                        {item.favorite ? 'Убрать из избранного' : 'В избранное'}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        danger
                        disabled={item.role === 'viewer'}
                        icon={<Trash2 className="size-4" />}
                        onSelect={() => void remove(item)}
                      >
                        Удалить
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
            <FileSpreadsheet className="size-10 text-fg-subtle" strokeWidth={1.25} />
            <p className="max-w-sm text-[14px] text-fg-muted">{q ? 'Ничего не найдено.' : TITLES[view].empty}</p>
          </div>
        )}
      </div>

      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title="Переименовать таблицу"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Отмена
            </Button>
            <Button variant="primary" disabled={!newTitle.trim()} onClick={() => void rename()}>
              Сохранить
            </Button>
          </>
        }
      >
        <Field label="Название">
          <Input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void rename()}
          />
        </Field>
      </Dialog>
    </main>
  );
}

function SheetPreview() {
  return (
    <svg className="absolute inset-x-4 top-4 h-28 w-[calc(100%-32px)] opacity-70" aria-hidden>
      {Array.from({ length: 6 }, (_, row) => (
        <g key={row}>
          {Array.from({ length: 5 }, (_, col) => (
            <rect
              key={col}
              x={`${col * 20}%`}
              y={row * 16}
              width="19%"
              height="12"
              rx="3"
              fill={row === 0 ? 'rgba(167,139,250,0.35)' : 'rgba(255,255,255,0.06)'}
            />
          ))}
        </g>
      ))}
    </svg>
  );
}
