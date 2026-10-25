import { ChevronDown, FunctionSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { commitInput, type SelectionState } from './actions';
import type { FUniver } from './univer';

export function FormulaBar({
  api,
  selection,
  readOnly,
}: {
  api: FUniver | null;
  selection: SelectionState;
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState(selection.input);
  const [address, setAddress] = useState(selection.address);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(selection.input);
    setAddress(selection.address);
  }, [selection.input, selection.address]);

  function jump() {
    if (!api) return;
    const match = /^(?:'?(.+?)'?!)?([A-Za-z]+\d+(?::[A-Za-z]+\d+)?)$/.exec(address.trim());
    const workbook = api.getActiveWorkbook();
    if (!match || !workbook) {
      setAddress(selection.address);
      return;
    }
    const sheet = match[1] ? workbook.getSheetByName(match[1]) : workbook.getActiveSheet();
    if (!sheet) return;
    workbook.setActiveSheet(sheet);
    const range = sheet.getRange(match[2].toUpperCase());
    range.activate();
    // activate() selects without scrolling; bring the target into view.
    sheet.scrollToCell(range.getRow(), range.getColumn());
  }

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-2">
      <label className="flex w-36 items-center gap-1 rounded-[10px] bg-white/[0.03] px-3 hairline focus-within:border-accent/60">
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') jump();
            if (e.key === 'Escape') setAddress(selection.address);
          }}
          onBlur={() => setAddress(selection.address)}
          aria-label="Адрес ячейки"
          className="min-w-0 flex-1 bg-transparent text-[14px] font-medium outline-none"
        />
        <ChevronDown className="size-3.5 text-fg-subtle" />
      </label>
      <div className="flex min-w-0 flex-1 items-center rounded-[10px] bg-white/[0.03] hairline focus-within:border-accent/60">
        <span className="flex h-full items-center border-r border-line px-3 text-fg-subtle">
          <FunctionSquare className="size-[18px]" strokeWidth={1.5} />
        </span>
        <input
          value={draft}
          readOnly={readOnly}
          onFocus={() => (editing.current = true)}
          onBlur={() => {
            editing.current = false;
            setDraft(selection.input);
          }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && api && !readOnly) {
              commitInput(api, draft);
              editing.current = false;
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === 'Escape') {
              setDraft(selection.input);
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label="Строка формул"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent px-3 font-mono text-[14px] outline-none"
        />
      </div>
    </div>
  );
}
