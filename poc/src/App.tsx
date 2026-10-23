import { useCallback, useEffect, useRef, useState } from 'react';
import type { FUniver } from '@univerjs/presets';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { DocumentHeader, MenuBar } from './components/DocumentHeader';
import { Toolbar } from './components/Toolbar';
import { FormulaBar } from './components/FormulaBar';
import { KpiPanel } from './components/KpiPanel';
import { SheetBar, type SheetTab } from './components/SheetBar';
import '@univerjs/sheets-formula/facade';
import { bootUniver } from './univer/boot';
import { createDemoWorkbook } from './univer/demoWorkbook';
import {
  getSelection,
  readKpi,
  readSelectionStyle,
  type KpiSnapshot,
  type SelectionStyle,
} from './univer/actions';

const STORAGE_KEY = 'thule-sheets:poc-workbook:v2';

declare global {
  interface Window {
    __univerAPI?: FUniver;
  }
}

interface SelectionState {
  address: string;
  sheetName: string;
  formula: string;
}

export default function App() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<FUniver | null>(null);
  const saveTimer = useRef<number | null>(null);

  const [api, setApi] = useState<FUniver | null>(null);
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState<SelectionState>({
    address: 'A1',
    sheetName: 'Финансы',
    formula: '',
  });
  const [selectionStyle, setSelectionStyle] = useState<SelectionStyle | null>(null);
  const [kpi, setKpi] = useState<KpiSnapshot | null>(null);
  const [tabs, setTabs] = useState<SheetTab[]>([]);
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved');

  const syncSelection = useCallback(() => {
    const current = apiRef.current;
    if (!current) {
      return;
    }

    const workbook = current.getActiveWorkbook();
    const range = workbook?.getActiveRange();
    const sheet = workbook?.getActiveSheet();
    if (!range || !sheet) {
      return;
    }

    const formula = range.getFormula();
    const value = range.getRawValue();
    setSelection({
      address: range.getA1Notation(),
      sheetName: sheet.getSheetName(),
      formula: formula || (value == null ? '' : String(value)),
    });
    setSelectionStyle(readSelectionStyle(current));
    setKpi(readKpi(current));

    const activeSheetId = workbook?.getActiveSheet().getSheetId();
    setTabs(
      (workbook?.getSheets() ?? []).map((sheet) => ({
        id: sheet.getSheetId(),
        name: sheet.getSheetName(),
        color: sheet.getTabColor(),
        active: sheet.getSheetId() === activeSheetId,
      })),
    );
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const univerAPI = bootUniver(host);
    apiRef.current = univerAPI;
    window.__univerAPI = univerAPI;

    const stored = window.localStorage.getItem(STORAGE_KEY);
    let snapshot = createDemoWorkbook();

    if (stored) {
      try {
        snapshot = JSON.parse(stored);
      } catch {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    }

    univerAPI.createWorkbook(snapshot);
    setApi(univerAPI);
    setReady(true);

    window.setTimeout(syncSelection, 80);

    const commandSub = univerAPI.getActiveWorkbook()?.onCommandExecuted(() => {
      window.setTimeout(syncSelection, 40);
      setSaveState('saving');

      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }

      saveTimer.current = window.setTimeout(() => {
        const workbook = univerAPI.getActiveWorkbook();
        if (workbook) {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(workbook.save()));
        }
        setSaveState('saved');
      }, 700);
    });

    const selectionSub = univerAPI.addEvent(univerAPI.Event.SelectionChanged, () => {
      window.setTimeout(syncSelection, 20);
    });

    return () => {
      commandSub?.dispose();
      selectionSub.dispose();
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }
      univerAPI.dispose();
      apiRef.current = null;
    };
  }, [syncSelection]);

  const commitFormula = () => {
    const current = apiRef.current;
    const range = current ? getSelection(current) : null;
    if (!range) {
      return;
    }

    const raw = selection.formula.trim();
    if (raw === '') {
      range.clearContent();
    } else if (raw.startsWith('=')) {
      range.setFormula(raw);
    } else if (Number.isNaN(Number(raw.replace(',', '.')))) {
      range.setValue(raw);
    } else {
      range.setValue(Number(raw.replace(',', '.')));
    }

    window.setTimeout(syncSelection, 30);
  };

  const blurActiveControl = () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };

  const selectSheet = (sheetId: string) => {
    const workbook = apiRef.current?.getActiveWorkbook();
    const sheet = workbook?.getSheetBySheetId(sheetId);
    if (!workbook || !sheet) {
      return;
    }
    workbook.setActiveSheet(sheet);
    blurActiveControl();
    syncSelection();
  };

  const addSheet = () => {
    const workbook = apiRef.current?.getActiveWorkbook();
    if (!workbook) {
      return;
    }
    const sheet = workbook.insertSheet(`Лист ${tabs.length + 1}`);
    sheet.activate();
    blurActiveControl();
    syncSelection();
  };

  return (
    <div className="app">
      <Sidebar />

      <main className="main">
        <TopBar />
        <DocumentHeader saveState={saveState} sheetCount={tabs.length} />
        <MenuBar />

        <Toolbar api={api} style={selectionStyle} onChanged={syncSelection} />

        <FormulaBar
          address={selection.address}
          formula={selection.formula}
          onChange={(formula) => setSelection((previous) => ({ ...previous, formula }))}
          onCommit={commitFormula}
          onCancel={syncSelection}
        />

        {selection.sheetName === 'Финансы' && <KpiPanel kpi={kpi} />}

        <section className="sheet-shell" aria-label={`Лист ${selection.sheetName}`}>
          <div className="sheet-canvas">
            <div ref={hostRef} className="univer-host" />
            {!ready && (
              <div className="sheet-loading">
                <span className="spinner" />
                Запускаем табличный движок…
              </div>
            )}
          </div>
          <SheetBar tabs={tabs} onSelect={selectSheet} onAdd={addSheet} />
        </section>
      </main>
    </div>
  );
}
