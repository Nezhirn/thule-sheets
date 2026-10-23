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
  Plus,
  Settings,
  Star,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router';

import { api } from '../api/client';
import { useAuth } from '../lib/auth';
import { Avatar, Button, Dialog, Field, Input, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Select, useToast } from './ui';

export const WORKSPACE_ICONS: Record<string, LucideIcon> = {
  home: Home,
  briefcase: Briefcase,
  folder: Folder,
  chart: BarChart3,
  education: GraduationCap,
};

function NavItem({ to, icon: Icon, label, end }: { to: string; icon: LucideIcon; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        clsx(
          'flex h-10 items-center gap-3 rounded-xl px-3 text-[15px] transition',
          isActive ? 'bg-white/[0.07] text-fg' : 'text-fg/80 hover:bg-white/[0.04] hover:text-fg',
        )
      }
    >
      <Icon className="size-[18px] opacity-80" strokeWidth={1.75} />
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

function SectionTitle({ children, onAdd, addLabel }: { children: string; onAdd?: () => void; addLabel?: string }) {
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
    <aside className="window relative z-10 flex w-[264px] shrink-0 flex-col overflow-hidden p-3">
      <div className="flex items-center gap-3 px-2 pb-6 pt-2">
        <div className="flex size-9 items-center justify-center rounded-[10px] bg-gradient-to-br from-[#a78bfa] to-[#7c3aed] shadow-[0_6px_18px_-6px_rgba(139,92,246,0.9)]">
          <Grid2x2 className="size-5 text-white" strokeWidth={2} />
        </div>
        <span className="text-[19px] font-semibold tracking-tight">Thule Sheets</span>
      </div>

      <nav className="flex flex-col gap-0.5">
        <NavItem to="/" end icon={Home} label="Главная" />
        <NavItem to="/recent" icon={Clock3} label="Недавние" />
        <NavItem to="/favorites" icon={Star} label="Избранное" />
        <NavItem to="/shared" icon={Users} label="Общий доступ" />
      </nav>

      <div className="mx-3 mt-5 h-px bg-line" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SectionTitle onAdd={() => setCreating(true)} addLabel="Новое пространство">
          Рабочие пространства
        </SectionTitle>
        <nav className="flex flex-col gap-0.5">
          {workspaces.data?.map((workspace) => (
            <NavItem
              key={workspace.id}
              to={`/w/${workspace.id}`}
              icon={WORKSPACE_ICONS[workspace.icon] ?? Folder}
              label={workspace.name}
            />
          ))}
        </nav>

        <SectionTitle onAdd={() => navigate('/db?new=1')} addLabel="Новое подключение">
          Базы данных
        </SectionTitle>
        <nav className="flex flex-col gap-0.5">
          {connections.data?.map((connection) => (
            <NavItem key={connection.id} to={`/db/${connection.id}`} icon={Database} label={connection.name} />
          ))}
          {connections.data?.length === 0 && (
            <NavItem to="/db" end icon={Database} label="PostgreSQL" />
          )}
        </nav>
      </div>

      <Menu>
        <MenuTrigger asChild>
          <button className="mt-3 flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] text-fg/80 transition hover:bg-white/[0.04] hover:text-fg">
            <Settings className="size-[18px] opacity-80" strokeWidth={1.75} />
            <span className="flex-1 text-left">Настройки</span>
            {user && <Avatar name={user.name} size={24} />}
          </button>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>{user?.email}</MenuLabel>
          <MenuSeparator />
          <MenuItem icon={<Database className="size-4" />} onSelect={() => navigate('/db')}>
            Подключения к БД
          </MenuItem>
          <MenuItem
            icon={<LogOut className="size-4" />}
            // A full reload guarantees the auth query is gone before the login route renders.
            onSelect={() => void logout().then(() => window.location.replace('/login'))}
          >
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
