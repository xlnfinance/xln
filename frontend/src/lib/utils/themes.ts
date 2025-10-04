import type { ThemeColors, ThemeName } from '../types';

export const THEME_DEFINITIONS: Record<ThemeName, ThemeColors> = {
  'dark': {
    name: 'Dark (Default)',
    background: '#0a0a0a',
    backgroundGradient: 'linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 50%, #0f0f0f 100%)',
    entityColor: '#007acc',
    entityEmissive: '#003d66',
    connectionColor: '#00ccff',
    creditColor: '#00ff88',
    debitColor: '#ff4444',
    collateralColor: '#ffa500',
    textPrimary: '#e8e8e8',
    textSecondary: '#9d9d9d',
    accentColor: '#00d9ff',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    glassBackground: 'rgba(30, 30, 30, 0.8)',
    glassBorder: 'rgba(255, 255, 255, 0.1)',
  },

  'light': {
    name: 'Light',
    background: '#f5f5f5',
    backgroundGradient: 'linear-gradient(135deg, #ffffff 0%, #f0f0f0 50%, #fafafa 100%)',
    entityColor: '#0066cc',
    entityEmissive: '#004499',
    connectionColor: '#0088ff',
    creditColor: '#00aa66',
    debitColor: '#cc3333',
    collateralColor: '#ff8800',
    textPrimary: '#1a1a1a',
    textSecondary: '#666666',
    accentColor: '#0066cc',
    borderColor: 'rgba(0, 0, 0, 0.15)',
    glassBackground: 'rgba(255, 255, 255, 0.9)',
    glassBorder: 'rgba(0, 0, 0, 0.1)',
  },

  'gold-luxe': {
    name: 'Gold Luxe',
    background: '#1a1410',
    backgroundGradient: 'linear-gradient(135deg, #1a1410 0%, #2a2218 50%, #1f1814 100%)',
    entityColor: '#ffd700',
    entityEmissive: '#b8860b',
    connectionColor: '#ffaa00',
    creditColor: '#32cd32',
    debitColor: '#dc143c',
    collateralColor: '#daa520',
    textPrimary: '#f5e6d3',
    textSecondary: '#b8a992',
    accentColor: '#ffd700',
    borderColor: 'rgba(255, 215, 0, 0.2)',
    glassBackground: 'rgba(42, 34, 24, 0.85)',
    glassBorder: 'rgba(255, 215, 0, 0.15)',
  },

  'matrix': {
    name: 'Matrix',
    background: '#000000',
    backgroundGradient: 'linear-gradient(135deg, #000000 0%, #001a00 50%, #000000 100%)',
    entityColor: '#00ff00',
    entityEmissive: '#003300',
    connectionColor: '#00ff41',
    creditColor: '#39ff14',
    debitColor: '#ff0033',
    collateralColor: '#ffff00',
    textPrimary: '#00ff41',
    textSecondary: '#008f11',
    accentColor: '#00ff00',
    borderColor: 'rgba(0, 255, 65, 0.2)',
    glassBackground: 'rgba(0, 20, 0, 0.85)',
    glassBorder: 'rgba(0, 255, 65, 0.15)',
  },

  'arctic': {
    name: 'Arctic',
    background: '#0d1117',
    backgroundGradient: 'linear-gradient(135deg, #0d1117 0%, #161b22 50%, #0d1117 100%)',
    entityColor: '#58a6ff',
    entityEmissive: '#1f6feb',
    connectionColor: '#79c0ff',
    creditColor: '#56d364',
    debitColor: '#f85149',
    collateralColor: '#d29922',
    textPrimary: '#c9d1d9',
    textSecondary: '#8b949e',
    accentColor: '#58a6ff',
    borderColor: 'rgba(88, 166, 255, 0.15)',
    glassBackground: 'rgba(22, 27, 34, 0.8)',
    glassBorder: 'rgba(88, 166, 255, 0.1)',
  },
};

export function getThemeColors(themeName: ThemeName): ThemeColors {
  return THEME_DEFINITIONS[themeName] || THEME_DEFINITIONS.dark;
}

export function applyThemeToDocument(themeName: ThemeName): void {
  const theme = getThemeColors(themeName);

  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  // Apply CSS variables
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
  root.style.setProperty('--theme-accent', theme.accentColor);
  root.style.setProperty('--theme-border', theme.borderColor);
  root.style.setProperty('--theme-glass-bg', theme.glassBackground);
  root.style.setProperty('--theme-glass-border', theme.glassBorder);

  // Set data attribute for theme-specific selectors
  root.setAttribute('data-theme', themeName);
}
