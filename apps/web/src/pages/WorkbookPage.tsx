import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ChevronDown, Home, Save, Star, UserRound, UsersRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { api, ApiError, type SaveConflict } from '../api/client';
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
  Tooltip,
  useToast,
} from '../components/ui';
import { commands, EMPTY_SELECTION, readSelection, type SelectionState } from '../editor/actions';
import { trackChanges } from '../editor/changes';
import { InsertFromDbDialog, ShareDialog, VersionsDialog } from '../editor/dialogs';
import { FormulaBar } from '../editor/FormulaBar';
import { useInversion } from '../editor/inversion';
import { SheetTabs, type SheetInfo } from '../editor/SheetTabs';
import { Toolbar } from '../editor/Toolbar';
import { bootUniver, createWorkbook, type FUniver, type UniverHandle } from '../editor/univer';
import { useAuth } from '../lib/auth';
import { downloadBlob } from '../lib/download';
import { formatDateTime, formatWhen } from '../lib/format';
import { useSaveShortcut, useUnsavedGuard } from '../lib/unsaved';

export function WorkbookPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ['workbook', id],
    queryFn: () => api.workbook(id),
    // The editor boots from this data once and then owns the content: the query must not
    // change while the page is open (a new object would rebuild the editor and drop unsaved
    // edits), and must not outlive it (reopening would show the snapshot from before saves).
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<UniverHandle | null>(null);
  // Revision the local copy is based on; sent with every save to detect concurrent saves.
  const baseRev = useRef(0);
  // Bumped on every local edit, so a save does not clear edits made while it was in flight.
  const changeSeq = useRef(0);
  const savingRef = useRef(false);
  const [univer, setUniver] = useState<FUniver | null>(null);
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [sheets, setSheets] = useState<SheetInfo[]>([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [zoom, setZoom] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ at: string; by: string | null } | null>(null);
  const [conflict, setConflict] = useState<SaveConflict | null>(null);
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<string>('');
  const [dialog, setDialog] = useState<null | 'share' | 'versions' | 'rename' | 'db'>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // Kept apart from the query data, which must stay unchanged while the editor is open.
  const [favorite, setFavorite] = useState<boolean | null>(null);
  useEffect(() => setFavorite(null), [id]);
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
    const h = bootUniver(container.current);
    handle.current = h;
    const univerApi = h.api;
    createWorkbook(univerApi, data.snapshot);
    setTitle(data.title);
    setRole(data.role);
    univerApi.getActiveWorkbook()?.setEditable(data.role !== 'viewer');
    baseRev.current = data.rev;
    setSaved({ at: data.saved_at, by: data.saved_by });
    setDirty(false);

    let uiTimer: number | undefined;
    const scheduleUi = () => {
      window.clearTimeout(uiTimer);
      uiTimer = window.setTimeout(() => {
        refreshUi(univerApi);
      }, 60);
    };

    const subscriptions = [
      univerApi.addEvent(univerApi.Event.SelectionChanged, () => setSelection(readSelection(univerApi))),
      univerApi.addEvent(univerApi.Event.CommandExecuted, scheduleUi),
      univerApi.addEvent(univerApi.Event.ActiveSheetChanged, scheduleUi),
    ];
    const stopTracking =
      data.role === 'viewer'
        ? () => undefined
        : trackChanges(univerApi, () => {
            changeSeq.current += 1;
            setDirty(true);
          });

    setUniver(univerApi);
    refreshUi(univerApi);

    return () => {
      window.clearTimeout(uiTimer);
      subscriptions.forEach((s) => s.dispose());
      stopTracking();
      setUniver(null);
      // Univer schedules work after dispose in StrictMode remounts; defer the teardown.
      window.setTimeout(() => h.dispose(), 0);
      handle.current = null;
    };
  }, [detail.data, refreshUi]);

  useEffect(() => {
    if (title) document.title = `${title} — Thule Sheets`;
    return () => {
      document.title = 'Thule Sheets';
    };
  }, [title]);

  // ------------------------------------------------------------ saving
  const save = useCallback(
    async (force = false): Promise<boolean> => {
      const workbook = univer?.getActiveWorkbook();
      if (!workbook || readOnly || savingRef.current) return false;
      savingRef.current = true;
      setSaving(true);
      const seq = changeSeq.current;
      try {
        const result = await api.saveSnapshot(id, baseRev.current, workbook.save(), force);
        baseRev.current = result.rev;
        setSaved({ at: result.saved_at, by: user?.name ?? null });
        setConflict(null);
        if (changeSeq.current === seq) setDirty(false);
        void queryClient.invalidateQueries({ queryKey: ['workbooks'] });
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) setConflict(error.detail as SaveConflict);
        else toast(`Не удалось сохранить: ${(error as Error).message}`, 'error');
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [univer, readOnly, id, user?.name, queryClient, toast],
  );

  /** Replace the local copy with the latest saved one, discarding unsaved edits. */
  const reload = useCallback(async () => {
    if (!univer) return;
    setRebuilding(true);
    try {
      const fresh = await api.workbook(id);
      const current = univer.getActiveWorkbook();
      if (current) univer.disposeUnit(current.getId());
      createWorkbook(univer, fresh.snapshot);
      univer.getActiveWorkbook()?.setEditable(fresh.role !== 'viewer');
      baseRev.current = fresh.rev;
      setSaved({ at: fresh.saved_at, by: fresh.saved_by });
      setRole(fresh.role);
      setConflict(null);
      setDirty(false);
      refreshUi(univer);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setRebuilding(false);
    }
  }, [univer, id, refreshUi, toast]);

  const [inverted, toggleInverted] = useInversion(univer);

  const saveShortcut = useCallback(() => {
    if (dirty) void save();
  }, [dirty, save]);
  useSaveShortcut(saveShortcut, !readOnly);
  const guard = useUnsavedGuard(dirty && !readOnly, save);

  // ------------------------------------------------------------ actions
  function setZoomLevel(value: number) {
    const sheet = univer?.getActiveWorkbook()?.getActiveSheet();
    if (!sheet) return;
    sheet.zoom(value);
    setZoom(value);
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
    const next = !(favorite ?? detail.data?.favorite ?? false);
    try {
      await api.setFavorite(id, next);
      setFavorite(next);
      void queryClient.invalidateQueries({ queryKey: ['workbooks'] });
    } catch (error) {
      toast((error as Error).message, 'error');
    }
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

  return (
    <main className="window relative z-10 flex min-w-0 flex-1 flex-col gap-2 overflow-hidden p-2">
      {/* Header */}
      <header className="flex items-start gap-4 px-3 pt-2">
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
                  {(favorite ?? detail.data?.favorite) ? 'Убрать из избранного' : 'Добавить в избранное'}
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
            <SaveStatus readOnly={readOnly} dirty={dirty} saving={saving} saved={saved} loaded={!!univer} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-6">
          {!readOnly && (
            <Tooltip label="Сохранить (Ctrl+S)">
              <Button
                size="lg"
                icon={<Save className="size-[18px]" />}
                loading={saving}
                disabled={!univer || !dirty}
                onClick={() => void save()}
                className={clsx(dirty && 'ring-1 ring-accent/70')}
              >
                Сохранить
              </Button>
            </Tooltip>
          )}
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
            <MenuItem disabled={readOnly || !dirty} onSelect={() => void save()} shortcut="Ctrl+S">
              Сохранить
            </MenuItem>
            <MenuSeparator />
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
            <MenuItem onSelect={toggleInverted}>
              {inverted ? 'Показать исходные цвета таблицы' : 'Инвертировать цвета таблицы'}
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
          inverted={inverted}
          onToggleInverted={toggleInverted}
        />
      </div>

      <FormulaBar api={univer} selection={selection} readOnly={readOnly} />

      {/* Sheet */}
      <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[#101016] hairline">
        <div ref={container} className="univer-host min-h-0 flex-1" />
        {(!univer || rebuilding) && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#101016]/70">
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
        hasUnsavedChanges={dirty}
        onBeforeCreate={() => (dirty ? save() : Promise.resolve(true))}
        onRestored={() => {
          void reload().then(() => toast('Версия восстановлена', 'success'));
        }}
      />
      <InsertFromDbDialog univer={univer} open={dialog === 'db'} onOpenChange={(open) => setDialog(open ? 'db' : null)} />
      <Dialog
        open={conflict !== null}
        onOpenChange={(open) => !open && setConflict(null)}
        title="Таблицу уже сохранили"
        description={conflict ? conflictText(conflict, user?.id) : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConflict(null)}>
              Отмена
            </Button>
            <Button variant="danger" onClick={() => void reload()}>
              Загрузить их версию
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void save(true)}>
              Перезаписать
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-fg-muted">
          «Перезаписать» сохранит вашу копию поверх их изменений. «Загрузить их версию» отбросит ваши
          изменения и откроет сохранённую версию.
        </p>
      </Dialog>
      {guard}
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

function conflictText(conflict: SaveConflict, userId: string | undefined): string {
  const when = formatDateTime(conflict.saved_at);
  const who =
    conflict.saved_by_id && conflict.saved_by_id === userId
      ? `Вы сохранили её в другой вкладке ${when}`
      : `${conflict.saved_by ?? 'Другой пользователь'} сохранил(а) её ${when}`;
  return `${who}, после того как эта копия была открыта. Изменения в этой вкладке пока не сохранены.`;
}

function SaveStatus({
  readOnly,
  dirty,
  saving,
  saved,
  loaded,
}: {
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  saved: { at: string; by: string | null } | null;
  loaded: boolean;
}) {
  // Re-render periodically so "saved N minutes ago" stays current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!loaded) return null;
  let dot = 'bg-ok';
  let text = saved ? `Сохранено ${formatWhen(saved.at)}` : 'Сохранено';
  let tone = 'text-ok';
  if (readOnly) {
    dot = 'bg-fg-subtle';
    text = 'Только просмотр';
    tone = 'text-fg-muted';
  } else if (saving) {
    dot = 'bg-warn';
    text = 'Сохранение…';
    tone = 'text-warn';
  } else if (dirty) {
    dot = 'bg-warn';
    text = 'Есть несохранённые изменения';
    tone = 'text-warn';
  }
  const hint = saved ? `Последнее сохранение: ${formatDateTime(saved.at)}${saved.by ? `, ${saved.by}` : ''}` : '';
  return (
    <span title={hint} className={clsx('ml-2 flex shrink-0 items-center gap-2 text-[14px]', tone)}>
      <span className={clsx('size-2 rounded-full', dot)} />
      {text}
    </span>
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
