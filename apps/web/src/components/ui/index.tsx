import clsx from 'clsx';
import { Loader2, X } from 'lucide-react';
import { Dialog as RDialog, DropdownMenu, Tooltip as RTooltip } from 'radix-ui';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

export { clsx as cx };

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'bg-gradient-to-b from-[#9b6dff] to-accent-strong text-white shadow-[0_8px_24px_-10px_rgba(139,92,246,0.9)] hover:brightness-110',
  secondary: 'bg-raised text-fg hairline hover:bg-hover',
  ghost: 'text-fg-muted hover:bg-hover hover:text-fg',
  danger: 'bg-bad/15 text-bad hover:bg-bad/25',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: 'sm' | 'md' | 'lg';
    loading?: boolean;
    icon?: ReactNode;
  }
>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex select-none items-center justify-center gap-2 rounded-[10px] font-medium transition disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-9 px-4 text-sm',
        size === 'lg' && 'h-11 px-5 text-[15px]',
        buttonVariants[variant],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; label: string }
>(function IconButton({ active, label, className, children, ...props }, ref) {
  return (
    <Tooltip label={label}>
      <button
        ref={ref}
        aria-label={label}
        aria-pressed={active}
        className={clsx(
          'inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg px-1.5 text-fg-muted transition hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
          active && 'bg-accent-soft text-fg',
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={clsx(
          'h-9 w-full rounded-[10px] bg-app/60 px-3 text-sm text-fg placeholder:text-fg-subtle hairline outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/25',
          className,
        )}
        {...props}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={clsx(
          'h-9 rounded-[10px] bg-app/60 px-2.5 text-sm text-fg hairline outline-none focus:border-accent/60',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-fg-muted">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-fg-subtle">{hint}</span>}
    </label>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-4 animate-spin text-fg-muted', className)} />;
}

export function Tooltip({
  label,
  children,
  side,
  delay = 450,
}: {
  label: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  delay?: number;
}) {
  return (
    <RTooltip.Root delayDuration={delay}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-md bg-[#2a2a36] px-2 py-1 text-[12px] text-fg shadow-lg hairline"
        >
          {label}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 460,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />
        <RDialog.Content
          style={{ width }}
          className="window fixed left-1/2 top-[14vh] z-50 max-h-[76vh] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden outline-none"
        >
          <div className="flex items-start justify-between gap-4 px-6 pt-5">
            <div>
              <RDialog.Title className="text-[15px] font-semibold">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-1 text-[13px] text-fg-muted">{description}</RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">{title}</RDialog.Description>
              )}
            </div>
            <RDialog.Close className="rounded-md p-1 text-fg-subtle hover:bg-hover hover:text-fg" aria-label="Закрыть">
              <X className="size-4" />
            </RDialog.Close>
          </div>
          <div className="max-h-[calc(76vh-130px)] overflow-auto px-6 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-6 py-3.5">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({
  children,
  align = 'start',
  side,
}: {
  children: ReactNode;
  align?: 'start' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={8}
        className="glass z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[220px] !bg-[rgb(26_26_34/0.97)] overflow-y-auto rounded-xl p-1.5 text-[13px] shadow-2xl hairline"
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  icon,
  shortcut,
  disabled,
  danger,
}: {
  children: ReactNode;
  onSelect?: () => void;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={clsx(
        'flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent data-[highlighted]:text-white',
        danger ? 'text-bad' : 'text-fg',
      )}
    >
      <span className="flex size-4 items-center justify-center opacity-80">{icon}</span>
      <span className="flex-1">{children}</span>
      {shortcut && <span className="text-[12px] opacity-50">{shortcut}</span>}
    </DropdownMenu.Item>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-[11px] uppercase tracking-wider text-fg-subtle">{children}</DropdownMenu.Label>;
}

export function Avatar({ name, color, size = 28 }: { name: string; color?: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      title={name}
      style={{ width: size, height: size, background: color ?? '#8b5cf6', fontSize: size * 0.38 }}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-panel"
    >
      {initials || '?'}
    </span>
  );
}

// ---------------------------------------------------------------- toasts

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
}

const ToastContext = createContext<(text: string, tone?: Toast['tone']) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-3), { id, text, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4500);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={clsx(
              'glass pointer-events-auto max-w-sm rounded-xl px-4 py-3 text-[13px] shadow-2xl hairline',
              toast.tone === 'error' && 'text-bad',
              toast.tone === 'success' && 'text-ok',
            )}
          >
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
