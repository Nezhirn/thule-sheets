import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  BarChart3,
  Briefcase,
  Clock3,
  Database,
  Folder,
  GraduationCap,
  Grid2x2,
  Home,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Star,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';

import { api } from '../api/client';
import { ConnectionNav } from '../db/ConnectionNav';
import { useAuth } from '../lib/auth';
import {
  Avatar,
  Button,
  Dialog,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Select,
  Tooltip,
  useToast,
} from './ui';

const COLLAPSED_KEY = 'thule.sidebar.collapsed';

/** Collapsed state of the sidebar, persisted per browser. Toggled by Ctrl+\ / Cmd+\. */
function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1');
  const toggle = useCallback(() => {
    setCollapsed((value) => {
      localStorage.setItem(COLLAPSED_KEY, value ? '0' : '1');
      return !value;
    });
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.code === 'Backslash') {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [toggle]);
  return [collapsed, toggle];
}

export const WORKSPACE_ICONS: Record<string, LucideIcon> = {
  home: Home,
  briefcase: Briefcase,
  folder: Folder,
  chart: BarChart3,
  education: GraduationCap,
};

function NavItem({
  to,
  icon: Icon,
  label,
  end,
  collapsed,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  end?: boolean;
  collapsed: boolean;
}) {
  const link = (
    <NavLink
      to={to}
      end={end}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) =>
        clsx(
          'flex h-10 items-center rounded-xl text-[15px] transition',
          collapsed ? 'justify-center' : 'gap-3 px-3',
          isActive ? 'bg-white/[0.07] text-fg' : 'text-fg/80 hover:bg-white/[0.04] hover:text-fg',
        )
      }
    >
      <Icon className="size-[18px] shrink-0 opacity-80" strokeWidth={1.75} />
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );
  return collapsed ? (
    // NavLink takes className as a function; Radix Slot would stringify it, so wrap the link.
    <Tooltip label={label} side="right" delay={150}>
      <span className="block">{link}</span>
    </Tooltip>
  ) : (
    link
  );
}

function SectionTitle({
  children,
  onAdd,
  addLabel,
  collapsed,
}: {
  children: string;
  onAdd?: () => void;
  addLabel?: string;
  collapsed: boolean;
}) {
  if (collapsed) return <div className="mx-2 my-3 h-px bg-line" />;
  return (
    <div className="mb-1 mt-6 flex items-center justify-between px-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-subtle">{children}</span>
      {onAdd && (
        <button
          onClick={onAdd}
          aria-label={addLabel}
          className="rounded-md p-1 text-fg-subtle transition hover:bg-hover hover:text-fg"
        >
          <Plus className="size-4" />
        </button>
      )}
    </div>
  );
}

export function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.workspaces });
  const connections = useQuery({ queryKey: ['connections'], queryFn: () => api.connections() });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('folder');
  const [collapsed, toggleCollapsed] = useCollapsed();

  async function createWorkspace() {
    try {
      const workspace = await api.createWorkspace(name.trim(), icon);
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      setCreating(false);
      setName('');
      navigate(`/w/${workspace.id}`);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  return (
    <aside
      className={clsx(
        'window relative z-10 flex shrink-0 flex-col overflow-hidden transition-[width] duration-200',
        collapsed ? 'w-[60px] p-2' : 'w-[264px] p-3',
      )}
    >
      {collapsed ? (
        <div className="flex justify-center pb-4 pt-1">
          <Tooltip label={"Развернуть панель (Ctrl+\\)"} side="right" delay={150}>
            <button
              onClick={toggleCollapsed}
              aria-label="Развернуть панель"
              className="flex size-10 items-center justify-center rounded-xl text-fg-muted transition hover:bg-white/[0.06] hover:text-fg"
            >
              <PanelLeftOpen className="size-[18px]" strokeWidth={1.75} />
            </button>
          </Tooltip>
        </div>
      ) : (
        <div className="flex items-center gap-3 px-2 pb-6 pt-2">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-[#a78bfa] to-[#7c3aed] shadow-[0_6px_18px_-6px_rgba(139,92,246,0.9)]">
            <Grid2x2 className="size-5 text-white" strokeWidth={2} />
          </div>
          <span className="min-w-0 flex-1 truncate text-[19px] font-semibold tracking-tight">Thule Sheets</span>
          <Tooltip label={"Свернуть панель (Ctrl+\\)"}>
            <button
              onClick={toggleCollapsed}
              aria-label="Свернуть панель"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition hover:bg-white/[0.06] hover:text-fg"
            >
              <PanelLeftClose className="size-[18px]" strokeWidth={1.75} />
            </button>
          </Tooltip>
        </div>
      )}

      <nav className="flex flex-col gap-0.5">
        <NavItem to="/" end icon={Home} label="Главная" collapsed={collapsed} />
        <NavItem to="/recent" icon={Clock3} label="Недавние" collapsed={collapsed} />
        <NavItem to="/favorites" icon={Star} label="Избранное" collapsed={collapsed} />
        <NavItem to="/shared" icon={Users} label="Общий доступ" collapsed={collapsed} />
      </nav>

      {!collapsed && <div className="mx-3 mt-5 h-px bg-line" />}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:none]">
        <SectionTitle collapsed={collapsed} onAdd={() => setCreating(true)} addLabel="Новое пространство">
          Рабочие пространства
        </SectionTitle>
        <nav className="flex flex-col gap-0.5">
          {workspaces.data?.map((workspace) => (
            <NavItem
              key={workspace.id}
              to={`/w/${workspace.id}`}
              icon={WORKSPACE_ICONS[workspace.icon] ?? Folder}
              label={workspace.name}
              collapsed={collapsed}
            />
          ))}
        </nav>

        <SectionTitle collapsed={collapsed} onAdd={() => navigate('/db?new=1')} addLabel="Новое подключение">
          Базы данных
        </SectionTitle>
        <nav className="flex flex-col gap-0.5">
          {connections.data && <ConnectionNav connections={connections.data} collapsed={collapsed} />}
          {connections.data?.length === 0 && (
            <NavItem to="/db" end icon={Database} label="PostgreSQL" collapsed={collapsed} />
          )}
        </nav>
      </div>

      <Menu>
        <MenuTrigger asChild>
          <button
            aria-label="Настройки"
            className={clsx(
              'mt-3 flex h-11 items-center rounded-xl text-[15px] text-fg/80 transition hover:bg-white/[0.04] hover:text-fg',
              collapsed ? 'justify-center' : 'gap-3 px-3',
            )}
          >
            {collapsed ? (
              user ? (
                <Avatar name={user.name} size={26} />
              ) : (
                <Settings className="size-[18px] opacity-80" strokeWidth={1.75} />
              )
            ) : (
              <>
                <Settings className="size-[18px] opacity-80" strokeWidth={1.75} />
                <span className="flex-1 text-left">Настройки</span>
                {user && <Avatar name={user.name} size={24} />}
              </>
            )}
          </button>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>{user?.email}</MenuLabel>
          <MenuSeparator />
          <MenuItem icon={<Database className="size-4" />} onSelect={() => navigate('/db')}>
            Подключения к БД
          </MenuItem>
          <MenuItem icon={<LogOut className="size-4" />} onSelect={() => void logout().then(() => navigate('/login'))}>
            Выйти
          </MenuItem>
        </MenuContent>
      </Menu>

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="Новое рабочее пространство"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Отмена
            </Button>
            <Button variant="primary" disabled={!name.trim()} onClick={() => void createWorkspace()}>
              Создать
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Название">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Проекты" />
          </Field>
          <Field label="Иконка">
            <Select value={icon} onChange={(e) => setIcon(e.target.value)}>
              <option value="folder">Папка</option>
              <option value="briefcase">Портфель</option>
              <option value="chart">График</option>
              <option value="education">Учёба</option>
            </Select>
          </Field>
        </div>
      </Dialog>
    </aside>
  );
}
