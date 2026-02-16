import type { ThemeName } from '$lib/types/ui';

export interface ThemeColors {
  name: string;
  background: string;
  backgroundGradient: string;
  surface: string;
  surfaceHover: string;
  surfaceBorder: string;
  entityColor: string;
  entityEmissive: string;
  connectionColor: string;
  creditColor: string;
  debitColor: string;
  collateralColor: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accentColor: string;
  accentHover: string;
  borderColor: string;
  glassBackground: string;
  glassBorder: string;
  inputBackground: string;
  inputBorder: string;
  inputFocus: string;
  buttonPrimary: string;
  buttonPrimaryHover: string;
  badgeSynced: string;
  badgeSyncedBg: string;
  badgePending: string;
  badgePendingBg: string;
  barCredit: string;
  barCollateral: string;
  barDebt: string;
  barBackground: string;
  cardBackground: string;
  cardBorder: string;
  cardHoverBorder: string;
  headerBackground: string;
  scrollbarThumb: string;
}

// Helper: fill missing extended fields with sensible defaults from base fields
function withDefaults(
  partial: Partial<ThemeColors> &
    Pick<
      ThemeColors,
      | 'name'
      | 'background'
      | 'backgroundGradient'
      | 'entityColor'
      | 'entityEmissive'
      | 'connectionColor'
      | 'creditColor'
      | 'debitColor'
      | 'collateralColor'
      | 'textPrimary'
      | 'textSecondary'
      | 'accentColor'
      | 'borderColor'
      | 'glassBackground'
      | 'glassBorder'
    >,
): ThemeColors {
  const isLight = partial.background ? parseInt(partial.background.replace('#', ''), 16) > 0x888888 : false;
  return {
    textMuted: partial.textSecondary,
    accentHover: partial.accentColor,
    surface: isLight ? '#ffffff' : '#18181b',
    surfaceHover: isLight ? '#f8f8fa' : '#1c1c20',
    surfaceBorder: partial.borderColor,
    inputBackground: isLight ? '#ffffff' : '#09090b',
    inputBorder: partial.borderColor,
    inputFocus: partial.accentColor,
    buttonPrimary: partial.accentColor,
    buttonPrimaryHover: partial.accentColor,
    badgeSynced: partial.creditColor,
    badgeSyncedBg: isLight ? 'rgba(0, 170, 102, 0.1)' : 'rgba(74, 222, 128, 0.1)',
    badgePending: '#fbbf24',
    badgePendingBg: 'rgba(251, 191, 36, 0.1)',
    barCredit: isLight ? '#94a3b8' : '#52525b',
    barCollateral: partial.creditColor,
    barDebt: partial.debitColor,
    barBackground: isLight ? '#e2e8f0' : '#27272a',
    cardBackground: isLight ? '#ffffff' : '#18181b',
    cardBorder: partial.borderColor,
    cardHoverBorder: isLight ? 'rgba(0, 0, 0, 0.25)' : '#3f3f46',
    headerBackground: isLight ? '#ffffff' : '#1c1917',
    scrollbarThumb: isLight ? '#cbd5e1' : '#27272a',
    ...partial,
  } as ThemeColors;
}

export const THEME_DEFINITIONS: Record<ThemeName, ThemeColors> = {
  dark: withDefaults({
    name: 'Dark',
    background: '#09090b',
    backgroundGradient: 'linear-gradient(135deg, #09090b 0%, #18181b 50%, #0c0c0e 100%)',
    surface: '#18181b',
    surfaceHover: '#1c1c20',
    surfaceBorder: '#27272a',
    entityColor: '#007acc',
    entityEmissive: '#003d66',
    connectionColor: '#00ccff',
    creditColor: '#4ade80',
    debitColor: '#f43f5e',
    collateralColor: '#10b981',
    textPrimary: '#e4e4e7',
    textSecondary: '#a1a1aa',
    textMuted: '#71717a',
    accentColor: '#fbbf24',
    accentHover: '#f59e0b',
    borderColor: '#27272a',
    glassBackground: 'rgba(24, 24, 27, 0.85)',
    glassBorder: 'rgba(255, 255, 255, 0.06)',
    inputBackground: '#09090b',
    inputBorder: '#27272a',
    inputFocus: '#fbbf24',
    buttonPrimary: '#2563eb',
    buttonPrimaryHover: '#3b82f6',
    badgeSynced: '#4ade80',
    badgeSyncedBg: 'rgba(74, 222, 128, 0.1)',
    badgePending: '#fbbf24',
    badgePendingBg: 'rgba(251, 191, 36, 0.1)',
    barCredit: '#52525b',
    barCollateral: '#10b981',
    barDebt: '#f43f5e',
    barBackground: '#27272a',
    cardBackground: '#18181b',
    cardBorder: '#27272a',
    cardHoverBorder: '#3f3f46',
    headerBackground: '#151316',
    scrollbarThumb: '#27272a',
  }),

  editor: withDefaults({
    name: 'Editor',
    background: '#1e1e2e',
    backgroundGradient: 'linear-gradient(180deg, #1e1e2e 0%, #181825 100%)',
    surface: '#252536',
    surfaceHover: '#2a2a3c',
    surfaceBorder: '#313145',
    entityColor: '#89b4fa',
    entityEmissive: '#1e66f5',
    connectionColor: '#74c7ec',
    creditColor: '#a6e3a1',
    debitColor: '#f38ba8',
    collateralColor: '#94e2d5',
    textPrimary: '#cdd6f4',
    textSecondary: '#a6adc8',
    textMuted: '#6c7086',
    accentColor: '#89b4fa',
    accentHover: '#b4d0fb',
    borderColor: '#313145',
    glassBackground: 'rgba(30, 30, 46, 0.9)',
    glassBorder: 'rgba(137, 180, 250, 0.08)',
    inputBackground: '#181825',
    inputBorder: '#313145',
    inputFocus: '#89b4fa',
    buttonPrimary: '#89b4fa',
    buttonPrimaryHover: '#b4d0fb',
    badgeSynced: '#a6e3a1',
    badgeSyncedBg: 'rgba(166, 227, 161, 0.1)',
    badgePending: '#f9e2af',
    badgePendingBg: 'rgba(249, 226, 175, 0.1)',
    barCredit: '#585b70',
    barCollateral: '#94e2d5',
    barDebt: '#f38ba8',
    barBackground: '#313145',
    cardBackground: '#252536',
    cardBorder: '#313145',
    cardHoverBorder: '#45475a',
    headerBackground: '#1e1e2e',
    scrollbarThumb: '#45475a',
  }),

  light: withDefaults({
    name: 'Light',
    background: '#f8fafc',
    backgroundGradient: 'linear-gradient(180deg, #ffffff 0%, #f1f5f9 100%)',
    surface: '#ffffff',
    surfaceHover: '#f8fafc',
    surfaceBorder: '#e2e8f0',
    entityColor: '#2563eb',
    entityEmissive: '#1d4ed8',
    connectionColor: '#3b82f6',
    creditColor: '#16a34a',
    debitColor: '#dc2626',
    collateralColor: '#0d9488',
    textPrimary: '#0f172a',
    textSecondary: '#475569',
    textMuted: '#94a3b8',
    accentColor: '#2563eb',
    accentHover: '#1d4ed8',
    borderColor: '#e2e8f0',
    glassBackground: 'rgba(255, 255, 255, 0.92)',
    glassBorder: 'rgba(0, 0, 0, 0.06)',
    inputBackground: '#ffffff',
    inputBorder: '#cbd5e1',
    inputFocus: '#2563eb',
    buttonPrimary: '#2563eb',
    buttonPrimaryHover: '#1d4ed8',
    badgeSynced: '#16a34a',
    badgeSyncedBg: 'rgba(22, 163, 74, 0.08)',
    badgePending: '#d97706',
    badgePendingBg: 'rgba(217, 119, 6, 0.08)',
    barCredit: '#94a3b8',
    barCollateral: '#0d9488',
    barDebt: '#dc2626',
    barBackground: '#e2e8f0',
    cardBackground: '#ffffff',
    cardBorder: '#e2e8f0',
    cardHoverBorder: '#cbd5e1',
    headerBackground: '#ffffff',
    scrollbarThumb: '#cbd5e1',
  }),

  merchant: withDefaults({
    name: 'Merchant',
    background: '#faf9f7',
    backgroundGradient: 'linear-gradient(180deg, #ffffff 0%, #f5f3ef 100%)',
    surface: '#ffffff',
    surfaceHover: '#fdfcfa',
    surfaceBorder: '#e7e5e4',
    entityColor: '#0c4a6e',
    entityEmissive: '#075985',
    connectionColor: '#0284c7',
    creditColor: '#15803d',
    debitColor: '#b91c1c',
    collateralColor: '#0f766e',
    textPrimary: '#1c1917',
    textSecondary: '#57534e',
    textMuted: '#a8a29e',
    accentColor: '#0c4a6e',
    accentHover: '#0369a1',
    borderColor: '#e7e5e4',
    glassBackground: 'rgba(255, 255, 255, 0.95)',
    glassBorder: 'rgba(0, 0, 0, 0.05)',
    inputBackground: '#fafaf9',
    inputBorder: '#d6d3d1',
    inputFocus: '#0c4a6e',
    buttonPrimary: '#0c4a6e',
    buttonPrimaryHover: '#0369a1',
    badgeSynced: '#15803d',
    badgeSyncedBg: 'rgba(21, 128, 61, 0.06)',
    badgePending: '#b45309',
    badgePendingBg: 'rgba(180, 83, 9, 0.06)',
    barCredit: '#a8a29e',
    barCollateral: '#0f766e',
    barDebt: '#b91c1c',
    barBackground: '#e7e5e4',
    cardBackground: '#ffffff',
    cardBorder: '#e7e5e4',
    cardHoverBorder: '#d6d3d1',
    headerBackground: '#ffffff',
    scrollbarThumb: '#d6d3d1',
  }),

  'gold-luxe': withDefaults({
    name: 'Gold Luxe',
    background: '#1a1410',
    backgroundGradient: 'linear-gradient(135deg, #1a1410 0%, #2a2218 50%, #1f1814 100%)',
    surface: '#2a2218',
    surfaceHover: '#342c20',
    surfaceBorder: 'rgba(255, 215, 0, 0.12)',
    entityColor: '#ffd700',
    entityEmissive: '#b8860b',
    connectionColor: '#ffaa00',
    creditColor: '#32cd32',
    debitColor: '#dc143c',
    collateralColor: '#daa520',
    textPrimary: '#f5e6d3',
    textSecondary: '#b8a992',
    textMuted: '#8a7a66',
    accentColor: '#ffd700',
    accentHover: '#ffe44d',
    borderColor: 'rgba(255, 215, 0, 0.12)',
    glassBackground: 'rgba(42, 34, 24, 0.85)',
    glassBorder: 'rgba(255, 215, 0, 0.1)',
    inputBackground: '#1a1410',
    inputBorder: 'rgba(255, 215, 0, 0.12)',
    inputFocus: '#ffd700',
    buttonPrimary: '#b8860b',
    buttonPrimaryHover: '#daa520',
    barCredit: '#8a7a66',
    barCollateral: '#daa520',
    barDebt: '#dc143c',
    barBackground: 'rgba(255, 215, 0, 0.06)',
    cardBackground: '#2a2218',
    cardBorder: 'rgba(255, 215, 0, 0.12)',
    cardHoverBorder: 'rgba(255, 215, 0, 0.25)',
    headerBackground: '#221c14',
    scrollbarThumb: 'rgba(255, 215, 0, 0.15)',
  }),

  matrix: withDefaults({
    name: 'Matrix',
    background: '#000000',
    backgroundGradient: 'linear-gradient(135deg, #000000 0%, #001a00 50%, #000000 100%)',
    surface: '#0a1a0a',
    surfaceHover: '#0f240f',
    surfaceBorder: 'rgba(0, 255, 65, 0.12)',
    entityColor: '#00ff00',
    entityEmissive: '#003300',
    connectionColor: '#00ff41',
    creditColor: '#39ff14',
    debitColor: '#ff0033',
    collateralColor: '#00ff88',
    textPrimary: '#00ff41',
    textSecondary: '#008f11',
    textMuted: '#005500',
    accentColor: '#00ff00',
    accentHover: '#33ff33',
    borderColor: 'rgba(0, 255, 65, 0.12)',
    glassBackground: 'rgba(0, 20, 0, 0.85)',
    glassBorder: 'rgba(0, 255, 65, 0.1)',
    inputBackground: '#000a00',
    inputBorder: 'rgba(0, 255, 65, 0.12)',
    inputFocus: '#00ff00',
    buttonPrimary: '#006600',
    buttonPrimaryHover: '#008800',
    barCredit: '#005500',
    barCollateral: '#00ff88',
    barDebt: '#ff0033',
    barBackground: 'rgba(0, 255, 65, 0.06)',
    cardBackground: '#0a1a0a',
    cardBorder: 'rgba(0, 255, 65, 0.12)',
    cardHoverBorder: 'rgba(0, 255, 65, 0.25)',
    headerBackground: '#001200',
    scrollbarThumb: 'rgba(0, 255, 65, 0.15)',
  }),

  arctic: withDefaults({
    name: 'Arctic',
    background: '#0d1117',
    backgroundGradient: 'linear-gradient(135deg, #0d1117 0%, #161b22 50%, #0d1117 100%)',
    surface: '#161b22',
    surfaceHover: '#1c2129',
    surfaceBorder: '#30363d',
    entityColor: '#58a6ff',
    entityEmissive: '#1f6feb',
    connectionColor: '#79c0ff',
    creditColor: '#56d364',
    debitColor: '#f85149',
    collateralColor: '#3fb950',
    textPrimary: '#c9d1d9',
    textSecondary: '#8b949e',
    textMuted: '#484f58',
    accentColor: '#58a6ff',
    accentHover: '#79c0ff',
    borderColor: '#30363d',
    glassBackground: 'rgba(22, 27, 34, 0.85)',
    glassBorder: 'rgba(88, 166, 255, 0.08)',
    inputBackground: '#0d1117',
    inputBorder: '#30363d',
    inputFocus: '#58a6ff',
    buttonPrimary: '#238636',
    buttonPrimaryHover: '#2ea043',
    barCredit: '#484f58',
    barCollateral: '#3fb950',
    barDebt: '#f85149',
    barBackground: '#30363d',
    cardBackground: '#161b22',
    cardBorder: '#30363d',
    cardHoverBorder: '#484f58',
    headerBackground: '#161b22',
    scrollbarThumb: '#30363d',
  }),
};

export function getThemeColors(themeName: ThemeName): ThemeColors {
  return THEME_DEFINITIONS[themeName] || THEME_DEFINITIONS.dark;
}

/** Get all available theme names with display labels */
export function getAvailableThemes(): Array<{ id: ThemeName; name: string }> {
  return (Object.entries(THEME_DEFINITIONS) as [ThemeName, ThemeColors][]).map(([id, theme]) => ({
    id,
    name: theme.name,
  }));
}

export function applyThemeToDocument(themeName: ThemeName): void {
  const theme = getThemeColors(themeName);

  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  // Core colors
  root.style.setProperty('--theme-background', theme.background);
  root.style.setProperty('--theme-bg-gradient', theme.backgroundGradient);
  root.style.setProperty('--theme-entity', theme.entityColor);
  root.style.setProperty('--theme-entity-emissive', theme.entityEmissive);
  root.style.setProperty('--theme-connection', theme.connectionColor);
  root.style.setProperty('--theme-credit', theme.creditColor);
  root.style.setProperty('--theme-debit', theme.debitColor);
  root.style.setProperty('--theme-collateral', theme.collateralColor);
  root.style.setProperty('--theme-text-primary', theme.textPrimary);
  root.style.setProperty('--theme-text-secondary', theme.textSecondary);
  root.style.setProperty('--theme-text-muted', theme.textMuted);
  root.style.setProperty('--theme-accent', theme.accentColor);
  root.style.setProperty('--theme-accent-hover', theme.accentHover);
  root.style.setProperty('--theme-border', theme.borderColor);
  root.style.setProperty('--theme-glass-bg', theme.glassBackground);
  root.style.setProperty('--theme-glass-border', theme.glassBorder);

  // Surfaces
  root.style.setProperty('--theme-surface', theme.surface);
  root.style.setProperty('--theme-surface-hover', theme.surfaceHover);
  root.style.setProperty('--theme-surface-border', theme.surfaceBorder);

  // Inputs
  root.style.setProperty('--theme-input-bg', theme.inputBackground);
  root.style.setProperty('--theme-input-border', theme.inputBorder);
  root.style.setProperty('--theme-input-focus', theme.inputFocus);

  // Buttons
  root.style.setProperty('--theme-btn-primary', theme.buttonPrimary);
  root.style.setProperty('--theme-btn-primary-hover', theme.buttonPrimaryHover);

  // Badges
  root.style.setProperty('--theme-badge-synced', theme.badgeSynced);
  root.style.setProperty('--theme-badge-synced-bg', theme.badgeSyncedBg);
  root.style.setProperty('--theme-badge-pending', theme.badgePending);
  root.style.setProperty('--theme-badge-pending-bg', theme.badgePendingBg);

  // Bars
  root.style.setProperty('--theme-bar-credit', theme.barCredit);
  root.style.setProperty('--theme-bar-collateral', theme.barCollateral);
  root.style.setProperty('--theme-bar-debt', theme.barDebt);
  root.style.setProperty('--theme-bar-bg', theme.barBackground);

  // Cards
  root.style.setProperty('--theme-card-bg', theme.cardBackground);
  root.style.setProperty('--theme-card-border', theme.cardBorder);
  root.style.setProperty('--theme-card-hover-border', theme.cardHoverBorder);

  // Layout
  root.style.setProperty('--theme-header-bg', theme.headerBackground);
  root.style.setProperty('--theme-scrollbar-thumb', theme.scrollbarThumb);

  // Set data attribute for theme-specific selectors
  root.setAttribute('data-theme', themeName);
}
