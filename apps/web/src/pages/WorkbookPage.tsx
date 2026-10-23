import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, Home, Moon, Plus, Star, Sun, UserRound, UsersRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { api } from '../api/client';
import {
  Avatar,
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
  Tooltip,
  useToast,
} from '../components/ui';
import { commands, EMPTY_SELECTION, readSelection, type SelectionState } from '../editor/actions';
import { InsertFromDbDialog, ShareDialog, VersionsDialog } from '../editor/dialogs';
import { FormulaBar } from '../editor/FormulaBar';
import { SheetTabs, type SheetInfo } from '../editor/SheetTabs';
import { WorkbookSync, type Peer, type SyncStatus } from '../editor/sync';
import { Toolbar } from '../editor/Toolbar';
import { bootUniver, createWorkbook, type FUniver, type UniverHandle } from '../editor/univer';
import { useAuth } from '../lib/auth';
import { downloadBlob } from '../lib/download';

type SaveState = 'saved' | 'saving' | 'unsaved' | 'error';

const SAVE_LABELS: Record<SaveState, { text: string; color: string }> = {
  saved: { text: 'Сохранено', color: 'bg-ok' },
  saving: { text: 'Сохранение…', color: 'bg-warn' },
  unsaved: { text: 'Есть изменения', color: 'bg-warn' },
  error: { text: 'Ошибка сохранения', color: 'bg-bad' },
};

export function WorkbookPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ['workbook', id],
    queryFn: () => api.workbook(id),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<UniverHandle | null>(null);
  const sync = useRef<WorkbookSync | null>(null);
  const [univer, setUniver] = useState<FUniver | null>(null);
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [sheets, setSheets] = useState<SheetInfo[]>([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [zoom, setZoom] = useState(1);
  const [lightSheet, setLightSheet] = useState(
    () => localStorage.getItem('thule.sheet-light') === '1',
  );
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [status, setStatus] = useState<SyncStatus>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<string>('');
  const [dialog, setDialog] = useState<null | 'share' | 'versions' | 'rename' | 'db'>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [rebuilding, setRebuilding] = useState(false);

  const readOnly = role === 'viewer';

  const refreshUi = useCallback((api: FUniver) => {
    const workbook = api.getActiveWorkbook();
    if (!workbook) return;
    setSelection(readSelection(api));
    setSheets(workbook.getSheets().map((s) => ({ id: s.getSheetId(), name: s.getSheetName() })));
    const sheet = workbook.getActiveSheet();
    setActiveSheet(sheet.getSheetId());
    try {
      setZoom(sheet.getZoom());
    } catch {
      // zoom facade is part of sheets-ui
    }
  }, []);

  // ------------------------------------------------------------ editor lifecycle
  useEffect(() => {
    const data = detail.data;
    if (!data || !container.current) return;
    let cancelled = false;
    const h = bootUniver(container.current, !lightSheet);
    handle.current = h;
    const univerApi = h.api;
    createWorkbook(univerApi, data.snapshot);
    setTitle(data.title);
    setRole(data.role);
    univerApi.getActiveWorkbook()?.setEditable(data.role !== 'viewer');

    let uiTimer: number | undefined;
    const scheduleUi = () => {
      window.clearTimeout(uiTimer);
      uiTimer = window.setTimeout(() => {
        refreshUi(univerApi);
      }, 60);
    };

    let presenceTimer: number | undefined;
    let lastPresence = '';
    const subscriptions = [
      univerApi.addEvent(univerApi.Event.SelectionChanged, () => {
        setSelection(readSelection(univerApi));
        const range = univerApi.getActiveWorkbook()?.getActiveRange();
        if (!range) return;
        const next = { sheet: range.getSheetName(), range: range.getA1Notation() };
        const key = `${next.sheet}!${next.range}`;
        if (key === lastPresence) return;
        lastPresence = key;
        // Drag-selection fires per frame; one presence message per 120 ms is enough.
        window.clearTimeout(presenceTimer);
        presenceTimer = window.setTimeout(() => sync.current?.sendSelection(next), 120);
      }),
      univerApi.addEvent(univerApi.Event.CommandExecuted, scheduleUi),
      univerApi.addEvent(univerApi.Event.ActiveSheetChanged, scheduleUi),
    ];

    const engine = new WorkbookSync(univerApi, data.id, data.snapshot_rev, data.role !== 'viewer', {
      onStatus: setStatus,
      onSaved: setSaveState,
      onPeers: setPeers,
      onTitle: setTitle,
      onRole: (next) => {
        setRole(next);
        engine.setCanEdit(next !== 'viewer');
        univerApi.getActiveWorkbook()?.setEditable(next !== 'viewer');
      },
      onRebuild: async (reason) => {
        setRebuilding(true);
        try {
          const fresh = await api.workbook(data.id);
          const current = univerApi.getActiveWorkbook();
          if (current) univerApi.disposeUnit(current.getId());
          createWorkbook(univerApi, fresh.snapshot);
          univerApi.getActiveWorkbook()?.setEditable(fresh.role !== 'viewer');
          engine.resetTo(fresh.snapshot_rev);
          await engine.catchUp();
          refreshUi(univerApi);
          toast(`Таблица обновлена: ${reason.toLowerCase()}`);
        } catch (error) {
          // Rethrow: the sync engine keeps the rebuild pending and retries with backoff.
          toast(`Не удалось обновить таблицу: ${(error as Error).message}`, 'error');
          throw error;
        } finally {
          setRebuilding(false);
        }
      },
    });
    sync.current = engine;
    void engine.start().then(() => {
      if (cancelled) return;
      setUniver(univerApi);
      refreshUi(univerApi);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(uiTimer);
      window.clearTimeout(presenceTimer);
      subscriptions.forEach((s) => s.dispose());
      engine.dispose();
      sync.current = null;
      setUniver(null);
      // Univer schedules work after dispose in StrictMode remounts; defer the teardown.
      window.setTimeout(() => h.dispose(), 0);
      handle.current = null;
    };
    // Re-boot only when another workbook is opened. Depending on the whole query
    // object would tear down the editor on unrelated updates such as a favourite
    // toggle (new object identity, same workbook).
  }, [detail.data?.id, refreshUi, toast]);

  // The engine starts in the saved mode; subsequent switches are applied in place.
  useEffect(() => {
    univer?.toggleDarkMode(!lightSheet);
  }, [univer, lightSheet]);

  useEffect(() => {
    if (title) document.title = `${title} — Thule Sheets`;
    return () => {
      document.title = 'Thule Sheets';
    };
  }, [title]);

  // ------------------------------------------------------------ actions
  function setZoomLevel(value: number) {
    const sheet = univer?.getActiveWorkbook()?.getActiveSheet();
    if (!sheet) return;
    sheet.zoom(value);
    setZoom(value);
  }

  function toggleSheetLight() {
    setLightSheet((previous) => {
      const next = !previous;
      localStorage.setItem('thule.sheet-light', next ? '1' : '0');
      return next;
    });
  }

  async function exportAs(format: 'xlsx' | 'csv') {
    const workbook = univer?.getActiveWorkbook();
    if (!workbook) return;
    try {
      const blob = await api.exportFile(id, format, workbook.save(), workbook.getActiveSheet().getSheetId());
      downloadBlob(blob, `${title}.${format}`);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  async function rename() {
    const next = renameDraft.trim();
    if (!next) return;
    try {
      await api.updateWorkbook(id, { title: next });
      setTitle(next);
      setDialog(null);
      void queryClient.invalidateQueries({ queryKey: ['workbooks'] });
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  async function toggleFavorite() {
    const favorite = !(detail.data?.favorite ?? false);
    await api.setFavorite(id, favorite);
    queryClient.setQueryData(['workbook', id], { ...detail.data, favorite });
    void queryClient.invalidateQueries({ queryKey: ['workbooks'] });
  }

  async function remove() {
    if (!window.confirm(`Удалить таблицу «${title}»? Это действие необратимо.`)) return;
    await api.deleteWorkbook(id);
    void queryClient.invalidateQueries({ queryKey: ['workbooks'] });
    navigate('/');
  }

  async function newWorkbook() {
    const workspaceId = detail.data?.workspace_id;
    if (!workspaceId) return;
    const wb = await api.createWorkbook(workspaceId, 'Новая таблица', 'blank');
    navigate(`/book/${wb.id}`);
  }

  const peerList = useMemo(() => {
    const byUser = new Map<string, Peer>();
    for (const peer of peers) if (peer.userId !== user?.id) byUser.set(peer.userId, peer);
    return [...byUser.values()];
  }, [peers, user?.id]);

  // ------------------------------------------------------------ render
  if (detail.isError) {
    return (
      <main className="window relative z-10 flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-fg-muted">Таблица не найдена или нет доступа.</p>
        <Button onClick={() => navigate('/')}>На главную</Button>
      </main>
    );
  }

  const run = (fn: (api: FUniver) => void) => () => univer && fn(univer);
  const save = SAVE_LABELS[status === 'offline' && saveState !== 'saved' ? 'unsaved' : saveState];

  return (
    <main className="window relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden p-3">
      {/* Header */}
      <header className="flex items-start gap-4 px-3 pb-3 pt-2">
        <div className="min-w-0 flex-1">
          <nav className="flex items-center gap-2 text-[14px] text-fg-muted">
            <Link to="/" className="hover:text-fg" aria-label="Главная">
              <Home className="size-4" strokeWidth={1.75} />
            </Link>
            <Link to={detail.data ? `/w/${detail.data.workspace_id}` : '/'} className="hover:text-fg">
              {detail.data?.workspace_name ?? 'Мои таблицы'}
            </Link>
            <span className="text-fg-subtle">/</span>
            <span className="truncate text-fg">{title}</span>
          </nav>
          <div className="mt-2 flex items-center gap-3">
            <Menu>
              <MenuTrigger asChild>
                <button className="flex min-w-0 items-center gap-2 rounded-lg text-left">
                  <h1 className="truncate text-[30px] font-bold leading-tight tracking-tight">{title || ' '}</h1>
                  <ChevronDown className="size-5 shrink-0 text-fg-muted" />
                </button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem icon={<Star className="size-4" />} onSelect={() => void toggleFavorite()}>
                  {detail.data?.favorite ? 'Убрать из избранного' : 'Добавить в избранное'}
                </MenuItem>
                <MenuItem
                  disabled={readOnly}
                  onSelect={() => {
                    setRenameDraft(title);
                    setDialog('rename');
                  }}
                >
                  Переименовать
                </MenuItem>
                <MenuItem onSelect={() => setDialog('versions')}>История версий</MenuItem>
                <MenuSeparator />
                <MenuItem danger disabled={readOnly} onSelect={() => void remove()}>
                  Удалить
                </MenuItem>
              </MenuContent>
            </Menu>
            <span className="ml-2 flex shrink-0 items-center gap-2 text-[14px] text-ok/90">
              <span className={clsx('size-2 rounded-full', status === 'offline' ? 'bg-bad' : save.color)} />
              <span className={clsx(status === 'offline' ? 'text-bad' : saveState === 'saved' ? 'text-ok' : 'text-warn')}>
                {status === 'offline' ? 'Нет соединения' : readOnly ? 'Только просмотр' : save.text}
              </span>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-6">
          <div className="flex items-center -space-x-2">
            {peerList.slice(0, 4).map((peer) => (
              <Tooltip
                key={peer.userId}
                label={`${peer.name}${peer.selection?.range ? ` — ${peer.selection.sheet}!${peer.selection.range}` : ''}`}
              >
                <span>
                  <Avatar name={peer.name} color={peer.color} size={32} />
                </span>
              </Tooltip>
            ))}
            <button
              aria-label="Пригласить"
              onClick={() => setDialog('share')}
              className="relative flex size-8 items-center justify-center rounded-full bg-raised text-fg-muted ring-2 ring-panel hover:text-fg"
            >
              <Plus className="size-4" />
            </button>
          </div>
          <Button variant="primary" size="lg" icon={<UsersRound className="size-[18px]" />} onClick={() => setDialog('share')}>
            Поделиться
          </Button>
          <span className="flex size-11 items-center justify-center rounded-full bg-raised hairline">
            <UserRound className="size-5 text-fg-muted" />
          </span>
        </div>
      </header>

      {/* Menu bar + toolbar */}
      <div className="rounded-2xl bg-white/[0.02] hairline">
        <nav className="flex h-11 items-center gap-1 border-b border-line px-3 text-[15px]">
          <TopMenu label="Файл">
            <MenuItem disabled={readOnly} onSelect={() => void newWorkbook()}>
              Новая таблица
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => void exportAs('xlsx')} shortcut=".xlsx">
              Скачать как Excel
            </MenuItem>
            <MenuItem onSelect={() => void exportAs('csv')} shortcut=".csv">
              Скачать лист как CSV
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => setDialog('versions')}>История версий</MenuItem>
            <MenuItem
              disabled={readOnly}
              onSelect={() => {
                setRenameDraft(title);
                setDialog('rename');
              }}
            >
              Переименовать
            </MenuItem>
          </TopMenu>
          <TopMenu label="Правка">
            <MenuItem disabled={readOnly} onSelect={run(commands.undo)} shortcut="Ctrl+Z">
              Отменить
            </MenuItem>
            <MenuItem disabled={readOnly} onSelect={run(commands.redo)} shortcut="Ctrl+Y">
              Повторить
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={run(commands.find)} shortcut="Ctrl+F">
              Найти и заменить
            </MenuItem>
            <MenuItem disabled={readOnly} onSelect={run(commands.clearContent)} shortcut="Del">
              Очистить содержимое
            </MenuItem>
          </TopMenu>
          <TopMenu label="Вид">
            <MenuItem onSelect={run((a) => commands.freezeRows(a, 1))}>Закрепить первую строку</MenuItem>
            <MenuItem onSelect={run(commands.freezeToSelection)}>Закрепить до выделенной ячейки</MenuItem>
            <MenuItem onSelect={run(commands.unfreeze)}>Снять закрепление</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={run(commands.toggleGridlines)}>Показать / скрыть сетку</MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={lightSheet ? <Moon className="size-4" /> : <Sun className="size-4" />}
              onSelect={toggleSheetLight}
            >
              {lightSheet ? 'Тёмная таблица' : 'Белая таблица'}
            </MenuItem>
          </TopMenu>
          <TopMenu label="Вставка">
            <MenuItem disabled={readOnly} onSelect={run(commands.insertRowBefore)}>
              Строку выше
            </MenuItem>
            <MenuItem disabled={readOnly} onSelect={run(commands.insertRowAfter)}>
              Строку ниже
            </MenuItem>
            <MenuItem disabled={readOnly} onSelect={run(commands.insertColBefore)}>
              Столбец слева
            </MenuItem>
            <MenuItem disabled={readOnly} onSelect={run(commands.insertColAfter)}>
              Столбец справа
            </MenuItem>
            <MenuSeparator />
            <MenuItem disabled={readOnly} onSelect={run(commands.hyperlink)}>
              Ссылку
            </MenuItem>
            <MenuItem disabled={readOnly} onSelect={run(commands.note)}>
              Заметку
            </MenuItem>
          </TopMenu>
          <TopMenu label="Формат">
            <MenuItem disabled={readOnly} onSelect={run((a) => commands.numberFormat(a, '#,##0 "₽"'))}>
              Рубли
            </MenuItem>
            <MenuItem disabled={readOnly} onSelect={run((a) => commands.numberFormat(a, '0%'))}>
              Процент
            </MenuItem>
            <MenuItem disabled={readOnly} onSelect={run((a) => commands.numberFormat(a, 'dd.mm.yyyy'))}>
              Дата
            </MenuItem>
            <MenuSeparator />
            <MenuItem disabled={readOnly} onSelect={run(commands.merge)}>
              Объединить ячейки
            </MenuItem>
            <MenuItem disabled={readOnly} onSelect={run((a) => commands.wrap(a, true))}>
              Переносить текст
            </MenuItem>
            <MenuItem disabled={readOnly} onSelect={run(commands.conditionalFormatting)}>
              Условное форматирование…
            </MenuItem>
            <MenuSeparator />
            <MenuItem disabled={readOnly} onSelect={run(commands.clearFormat)}>
              Очистить форматирование
            </MenuItem>
          </TopMenu>
          <TopMenu label="Данные">
            <MenuItem disabled={readOnly} onSelect={run(commands.sortAsc)}>
              Сортировка А → Я
            </MenuItem>
            <MenuItem disabled={readOnly} onSelect={run(commands.sortDesc)}>
              Сортировка Я → А
            </MenuItem>
            <MenuSeparator />
            <MenuItem disabled={readOnly} onSelect={run(commands.toggleFilter)}>
              Создать / убрать фильтр
            </MenuItem>
            <MenuItem disabled={readOnly} onSelect={run(commands.clearFilter)}>
              Сбросить условия фильтра
            </MenuItem>
            <MenuItem disabled={readOnly} onSelect={run(commands.dataValidation)}>
              Проверка данных…
            </MenuItem>
            <MenuSeparator />
            <MenuItem disabled={readOnly} onSelect={() => setDialog('db')}>
              Вставить из PostgreSQL…
            </MenuItem>
          </TopMenu>
          <TopMenu label="Инструменты">
            <MenuItem onSelect={() => navigate('/db')}>Подключения к базам данных</MenuItem>
            <MenuItem onSelect={() => setDialog('versions')}>История версий</MenuItem>
          </TopMenu>
        </nav>
        <Toolbar
          api={univer}
          selection={selection}
          readOnly={readOnly}
          zoom={zoom}
          onZoom={setZoomLevel}
          darkCanvas={!lightSheet}
        />
      </div>

      <div className="pt-2">
        <FormulaBar api={univer} selection={selection} readOnly={readOnly} />
      </div>


      {/* Sheet */}
      <section
        className={clsx(
          'relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl',
          lightSheet ? 'border border-black/10 bg-white' : 'bg-[#101016] hairline',
        )}
      >
        <div ref={container} className="univer-host min-h-0 flex-1" />
        {(!univer || rebuilding) && (
          <div
            className={clsx(
              'absolute inset-0 flex items-center justify-center',
              lightSheet ? 'bg-white/70' : 'bg-[#101016]/70',
            )}
          >
            <Spinner className="size-6" />
          </div>
        )}
        <SheetTabs
          api={univer}
          sheets={sheets}
          activeId={activeSheet}
          readOnly={readOnly}
          zoom={zoom}
          onZoom={setZoomLevel}
          light={lightSheet}
        />
      </section>

      <ShareDialog
        workbookId={id}
        open={dialog === 'share'}
        onOpenChange={(open) => setDialog(open ? 'share' : null)}
        canManage={!readOnly}
      />
      <VersionsDialog
        workbookId={id}
        open={dialog === 'versions'}
        onOpenChange={(open) => setDialog(open ? 'versions' : null)}
        canRestore={!readOnly}
        onRestored={() => toast('Версия восстановлена', 'success')}
      />
      <InsertFromDbDialog univer={univer} open={dialog === 'db'} onOpenChange={(open) => setDialog(open ? 'db' : null)} />
      <Dialog
        open={dialog === 'rename'}
        onOpenChange={(open) => setDialog(open ? 'rename' : null)}
        title="Переименовать таблицу"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Отмена
            </Button>
            <Button variant="primary" onClick={() => void rename()} disabled={!renameDraft.trim()}>
              Сохранить
            </Button>
          </>
        }
      >
        <Field label="Название">
          <Input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void rename()}
          />
        </Field>
      </Dialog>
    </main>
  );
}

function TopMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="h-8 rounded-lg px-3 text-fg/90 transition hover:bg-hover hover:text-fg data-[state=open]:bg-hover">
          {label}
        </button>
      </MenuTrigger>
      <MenuContent>{children}</MenuContent>
    </Menu>
  );
}
