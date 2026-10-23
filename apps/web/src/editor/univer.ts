import { LocaleType, mergeLocales, type IWorkbookData } from '@univerjs/core';
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting';
import cfRU from '@univerjs/preset-sheets-conditional-formatting/locales/ru-RU';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import coreRU from '@univerjs/preset-sheets-core/locales/ru-RU';
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation';
import dvRU from '@univerjs/preset-sheets-data-validation/locales/ru-RU';
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import filterRU from '@univerjs/preset-sheets-filter/locales/ru-RU';
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace';
import findRU from '@univerjs/preset-sheets-find-replace/locales/ru-RU';
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link';
import linkRU from '@univerjs/preset-sheets-hyper-link/locales/ru-RU';
import { UniverSheetsNotePreset } from '@univerjs/preset-sheets-note';
import noteRU from '@univerjs/preset-sheets-note/locales/ru-RU';
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort';
import sortRU from '@univerjs/preset-sheets-sort/locales/ru-RU';
import { createUniver, defaultTheme, type FUniver } from '@univerjs/presets';
import { CalculationMode } from '@univerjs/sheets-formula';

import '@univerjs/preset-sheets-core/lib/index.css';
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css';
import '@univerjs/preset-sheets-data-validation/lib/index.css';
import '@univerjs/preset-sheets-filter/lib/index.css';
import '@univerjs/preset-sheets-find-replace/lib/index.css';
import '@univerjs/preset-sheets-hyper-link/lib/index.css';
import '@univerjs/preset-sheets-note/lib/index.css';

export type { FUniver };

// Product accent: Univer's purple scale drives selection, focus rings and active controls.
const theme = { ...defaultTheme, primary: defaultTheme.purple };

export interface UniverHandle {
  api: FUniver;
  dispose: () => void;
}

export function bootUniver(container: HTMLElement): UniverHandle {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.RU_RU,
    locales: {
      [LocaleType.RU_RU]: mergeLocales(coreRU, dvRU, cfRU, filterRU, sortRU, findRU, linkRU, noteRU),
    },
    theme,
    // Dark mode inverts canvas colors, so snapshots keep "light" colors and export as-is.
    darkMode: true,
    presets: [
      UniverSheetsCorePreset({
        container,
        header: false,
        toolbar: false,
        formulaBar: false,
        footer: false,
        contextMenu: true,
        formula: {
          // Snapshots carry cached values; force a pass so the dependency graph is built.
          initialFormulaComputing: CalculationMode.FORCED,
        },
      }),
      UniverSheetsDataValidationPreset(),
      UniverSheetsConditionalFormattingPreset(),
      UniverSheetsFilterPreset(),
      UniverSheetsSortPreset(),
      UniverSheetsFindReplacePreset(),
      UniverSheetsHyperLinkPreset(),
      UniverSheetsNotePreset(),
    ],
  });
  return {
    api: univerAPI,
    dispose: () => univer.dispose(),
  };
}

export function createWorkbook(api: FUniver, snapshot: Record<string, unknown>) {
  return api.createWorkbook(snapshot as unknown as Partial<IWorkbookData>);
}
