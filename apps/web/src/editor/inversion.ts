/**
 * Color inversion of the spreadsheet canvas. Documents store light colors; Univer's dark
 * mode inverts them on screen to match the dark interface. The choice is per browser and
 * shared by every open sheet (workbook editor and database tables).
 */
import { useEffect, useSyncExternalStore } from 'react';

import type { FUniver } from './univer';

const KEY = 'thule.sheet.inverted';
const listeners = new Set<() => void>();

/** True when the canvas shows inverted (dark) colors. Inverted is the default. */
export function isInverted(): boolean {
  return localStorage.getItem(KEY) !== '0';
}

export function setInverted(value: boolean): void {
  localStorage.setItem(KEY, value ? '1' : '0');
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => event.key === KEY && listener();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** Current inversion state; applies it to `api` whenever it changes. */
export function useInversion(api: FUniver | null): [boolean, () => void] {
  const inverted = useSyncExternalStore(subscribe, isInverted);
  useEffect(() => {
    if (api && api.isDarkMode() !== inverted) api.toggleDarkMode(inverted);
  }, [api, inverted]);
  return [inverted, () => setInverted(!inverted)];
}
