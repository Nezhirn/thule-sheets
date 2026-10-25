import { useEffect, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router';

import { Button, Dialog } from '../components/ui';

/**
 * Guards unsaved local changes: the browser asks before closing or reloading the tab,
 * and in-app navigation shows a dialog. `onSave` resolves to true when saving succeeded.
 * Returns the dialog element to render.
 */
export function useUnsavedGuard(dirty: boolean, onSave: () => Promise<boolean>): ReactNode {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    return dirty && currentLocation.pathname !== nextLocation.pathname;
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers require a return value to show the prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const blocked = blocker.state === 'blocked';

  async function saveAndLeave() {
    setSaving(true);
    try {
      if (await onSave()) blocker.proceed?.();
      else blocker.reset?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={blocked}
      onOpenChange={(open) => !open && blocker.reset?.()}
      title="Несохранённые изменения"
      footer={
        <>
          <Button variant="ghost" onClick={() => blocker.reset?.()}>
            Остаться
          </Button>
          <Button variant="danger" onClick={() => blocker.proceed?.()}>
            Не сохранять
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void saveAndLeave()}>
            Сохранить
          </Button>
        </>
      }
    >
      <p className="text-[14px] text-fg-muted">Если уйти сейчас, изменения будут потеряны.</p>
    </Dialog>
  );
}

/** Calls `handler` on Ctrl+S / Cmd+S instead of the browser's "Save page" dialog. */
export function useSaveShortcut(handler: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyS') {
        event.preventDefault();
        event.stopPropagation();
        handler();
      }
    };
    // Capture phase: the spreadsheet canvas handles key events before they bubble.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handler, enabled]);
}
