import { AllCommunityModule, colorSchemeDark, ModuleRegistry, themeQuartz } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

export const gridTheme = themeQuartz.withPart(colorSchemeDark).withParams({
  backgroundColor: '#101016',
  foregroundColor: '#ececf1',
  headerBackgroundColor: '#15151d',
  headerTextColor: '#9a9cab',
  chromeBackgroundColor: '#15151d',
  accentColor: '#8b5cf6',
  borderColor: 'rgba(255,255,255,0.07)',
  rowHoverColor: 'rgba(139,92,246,0.08)',
  selectedRowBackgroundColor: 'rgba(139,92,246,0.16)',
  oddRowBackgroundColor: 'rgba(255,255,255,0.015)',
  fontFamily: "'Inter Variable', system-ui, sans-serif",
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 600,
  rowHeight: 34,
  headerHeight: 36,
  wrapperBorderRadius: 0,
  wrapperBorder: false,
  spacing: 6,
});
