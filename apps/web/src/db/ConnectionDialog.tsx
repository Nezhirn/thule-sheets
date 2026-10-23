import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, PlugZap, XCircle } from 'lucide-react';
import { useState } from 'react';

import { api, type DbConnection, type DbConnectionInput } from '../api/client';
import { Button, Dialog, Field, Input, Select, useToast } from '../components/ui';

export function ConnectionDialog({
  open,
  onOpenChange,
  existing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing?: DbConnection | null;
  onSaved: (connection: DbConnection) => void;
}) {
  const toast = useToast();
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: api.workspaces });
  const owned = workspaces.data?.filter((w) => w.role === 'owner') ?? [];
  const [form, setForm] = useState<DbConnectionInput>(() => ({
    workspace_id: existing?.workspace_id ?? '',
    name: existing?.name ?? '',
    host: existing?.host ?? '127.0.0.1',
    port: existing?.port ?? 5432,
    database: existing?.database ?? '',
    username: existing?.username ?? '',
    password: '',
    sslmode: existing?.sslmode ?? 'prefer',
    read_only: existing?.read_only ?? true,
  }));
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const workspaceId = form.workspace_id || owned[0]?.id || '';
  const set = (patch: Partial<DbConnectionInput>) => {
    setForm({ ...form, ...patch });
    setTest(null);
  };
  const valid = form.name.trim() && form.host.trim() && form.database.trim() && form.username.trim() && workspaceId;

  async function runTest() {
    setBusy('test');
    try {
      // An unchanged password is not known to the client: test the stored connection instead.
      const result =
        existing && !form.password
          ? await api.testSavedConnection(existing.id)
          : await api.testConnection({ ...form, workspace_id: workspaceId });
      setTest({ ok: result.ok, text: result.ok ? `PostgreSQL ${result.server_version}` : (result.error ?? 'Ошибка') });
    } catch (error) {
      setTest({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy('save');
    try {
      const saved = existing
        ? await api.updateConnection(existing.id, {
            name: form.name,
            host: form.host,
            port: form.port,
            database: form.database,
            username: form.username,
            sslmode: form.sslmode,
            read_only: form.read_only,
            password: form.password ? form.password : null,
          })
        : await api.createConnection({ ...form, workspace_id: workspaceId });
      // Close first: the page resets the URL on close, then onSaved navigates to the new connection.
      onOpenChange(false);
      onSaved(saved);
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={existing ? 'Подключение' : 'Новое подключение'}
      description="Пароль хранится зашифрованным и не возвращается в интерфейс. Лучше всего подключаться отдельной ролью с минимальными правами."
      width={540}
      footer={
        <>
          <Button className="mr-auto" icon={<PlugZap className="size-4" />} loading={busy === 'test'} disabled={!valid} onClick={() => void runTest()}>
            Проверить
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!valid} onClick={() => void save()}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-6 gap-3">
        <div className="col-span-6">
          <Field label="Название">
            <Input autoFocus value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Продакшн CRM" />
          </Field>
        </div>
        {!existing && (
          <div className="col-span-6">
            <Field label="Рабочее пространство">
              <Select value={workspaceId} onChange={(e) => set({ workspace_id: e.target.value })} className="w-full">
                {owned.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <div className="col-span-4">
          <Field label="Хост">
            <Input value={form.host} onChange={(e) => set({ host: e.target.value })} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Порт">
            <Input type="number" min={1} max={65535} value={form.port} onChange={(e) => set({ port: Number(e.target.value) || 5432 })} />
          </Field>
        </div>
        <div className="col-span-6">
          <Field label="База данных">
            <Input value={form.database} onChange={(e) => set({ database: e.target.value })} />
          </Field>
        </div>
        <div className="col-span-3">
          <Field label="Пользователь">
            <Input value={form.username} onChange={(e) => set({ username: e.target.value })} autoComplete="off" />
          </Field>
        </div>
        <div className="col-span-3">
          <Field label="Пароль">
            <Input
              type="password"
              value={form.password}
              onChange={(e) => set({ password: e.target.value })}
              placeholder={existing ? 'не менять' : ''}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <div className="col-span-3">
          <Field label="SSL">
            <Select value={form.sslmode} onChange={(e) => set({ sslmode: e.target.value })} className="w-full">
              {['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className="col-span-3 mt-6 flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={form.read_only}
            onChange={(e) => set({ read_only: e.target.checked })}
            className="size-4 accent-[#8b5cf6]"
          />
          Только чтение
        </label>
      </div>
      {test && (
        <p className={`mt-4 flex items-center gap-2 text-[13px] ${test.ok ? 'text-ok' : 'text-bad'}`}>
          {test.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
          {test.text}
        </p>
      )}
    </Dialog>
  );
}
