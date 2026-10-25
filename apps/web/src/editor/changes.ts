/**
 * Detects user edits of the open workbook. The server copy changes only on an explicit
 * save, so the page only needs to know whether the local copy differs from it.
 */
import { CommandType } from '@univerjs/core';

import type { FUniver } from './univer';

const MUTATION_ID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.mutation\.[A-Za-z0-9_.-]+$/;

/** True for mutations that change the saved workbook content. */
function changesContent(id: string): boolean {
  if (!MUTATION_ID.test(id)) return false;
  // doc.* mutations belong to the in-cell editor document (keystrokes), not to the workbook.
  if (id.startsWith('doc.')) return false;
  // Formula recalculation results are derived state, except defined names.
  if (id.startsWith('formula.mutation.') && !id.includes('defined-name')) return false;
  return !id.includes('mark-dirty');
}

/**
 * Calls `onChange` for every content mutation of the active workbook.
 * Returns a disposer.
 */
export function trackChanges(api: FUniver, onChange: () => void): () => void {
  const subscription = api.addEvent(api.Event.CommandExecuted, (event) => {
    if (event.type !== CommandType.MUTATION) return;
    const options = event.options ?? {};
    if (options.onlyLocal || options.fromCollab || options.fromChangeset) return;
    if (!changesContent(event.id)) return;
    const unitId = (event.params as { unitId?: string } | undefined)?.unitId;
    if (unitId && unitId !== api.getActiveWorkbook()?.getId()) return;
    onChange();
  });
  return () => subscription.dispose();
}
