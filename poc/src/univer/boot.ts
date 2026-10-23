import { LocaleType, mergeLocales } from '@univerjs/core';
import { CalculationMode } from '@univerjs/sheets-formula';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import ruRU from '@univerjs/preset-sheets-core/locales/ru-RU';
import { createUniver, defaultTheme, type FUniver } from '@univerjs/presets';
import '@univerjs/preset-sheets-core/lib/index.css';

/**
 * Accent palette is taken from Univer's purple scale (same contrast as the default blue),
 * so selection, focus rings and active controls follow the product accent.
 */
const thuleTheme = {
  ...defaultTheme,
  primary: defaultTheme.purple,
};

export function bootUniver(container: HTMLElement): FUniver {
  const { univerAPI } = createUniver({
    locale: LocaleType.RU_RU,
    locales: {
      [LocaleType.RU_RU]: mergeLocales(ruRU),
    },
    theme: thuleTheme,
    darkMode: true,
    presets: [
      UniverSheetsCorePreset({
        container,
        header: false,
        toolbar: false,
        formulaBar: false,
        contextMenu: true,
        footer: false,
        formula: {
          // Snapshots ship precomputed values; force a full pass so the
          // dependency graph is built and later edits recalculate.
          initialFormulaComputing: CalculationMode.FORCED,
        },
        // The RPC worker path does not deliver recalculations in this Vite setup
        // (see poc/README.md); keep the main-thread formula engine for now.
        // workerURL: new UniverWorker(),
      }),
    ],
  });

  return univerAPI;
}
