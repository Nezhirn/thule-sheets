import { Grid2x2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';

import { api } from '../api/client';
import { Button, Field, Input } from '../components/ui';
import { useAuth } from '../lib/auth';

export function LoginPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await api.login(email, password);
      else await api.register(email, name, password);
      await refresh();
      navigate('/');
    } catch (err) {
      setError(
        mode === 'login' && (err as { status?: number }).status === 401
          ? 'Неверный email или пароль'
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative z-10 flex h-full items-center justify-center p-6">
      <form onSubmit={submit} className="window flex w-[380px] flex-col gap-4 p-8">
        <div className="mb-2 flex flex-col items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[#a78bfa] to-[#7c3aed] shadow-[0_10px_30px_-10px_rgba(139,92,246,0.9)]">
            <Grid2x2 className="size-6 text-white" />
          </div>
          <h1 className="text-xl font-semibold">Thule Sheets</h1>
          <p className="text-[13px] text-fg-muted">
            {mode === 'login' ? 'Войдите, чтобы продолжить' : 'Создайте аккаунт'}
          </p>
        </div>
        {mode === 'register' && (
          <Field label="Имя">
            <Input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </Field>
        )}
        <Field label="Email">
          <Input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
          />
        </Field>
        <Field label="Пароль" hint={mode === 'register' ? 'Не короче 8 символов' : undefined}>
          <Input
            required
            type="password"
            minLength={mode === 'register' ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </Field>
        {error && <p className="text-[13px] text-bad">{error}</p>}
        <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-2">
          {mode === 'login' ? 'Войти' : 'Зарегистрироваться'}
        </Button>
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
          className="text-[13px] text-fg-muted transition hover:text-fg"
        >
          {mode === 'login' ? 'Нет аккаунта? Регистрация' : 'Уже есть аккаунт? Вход'}
        </button>
      </form>
    </div>
  );
}
