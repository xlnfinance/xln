import type {
  AccountDeltaViewMode,
  BarColorMode,
  BarLayoutMode,
  Settings,
  ThemeName,
  UIStyleSettings,
  UiSettingsExport,
  UIAccentIntensity,
  UIButtonStyle,
  UIBorderMode,
  UICardStyle,
  UIDensityMode,
  UIInputStyle,
  UIRadiusMode,
  UIShadowMode,
  UITabStyle,
  UITypographyScale,
} from '$lib/types/ui';

const VALID_DENSITY: readonly UIDensityMode[] = ['compact', 'comfortable', 'roomy'] as const;
const VALID_RADIUS: readonly UIRadiusMode[] = ['sharp', 'soft', 'pill'] as const;
const VALID_BORDERS: readonly UIBorderMode[] = ['minimal', 'subtle', 'strong'] as const;
const VALID_SHADOWS: readonly UIShadowMode[] = ['flat', 'soft', 'float'] as const;
const VALID_TABS: readonly UITabStyle[] = ['minimal', 'underline', 'rail', 'pill', 'segmented', 'floating'] as const;
const VALID_BUTTONS: readonly UIButtonStyle[] = ['minimal', 'soft', 'solid'] as const;
const VALID_CARDS: readonly UICardStyle[] = ['flat', 'filled', 'striped'] as const;
const VALID_INPUTS: readonly UIInputStyle[] = ['minimal', 'outlined', 'filled'] as const;
const VALID_ACCENT: readonly UIAccentIntensity[] = ['quiet', 'normal', 'bold'] as const;
const VALID_TYPOGRAPHY: readonly UITypographyScale[] = ['sm', 'md', 'lg'] as const;

export const DEFAULT_UI_STYLE: UIStyleSettings = {
  density: 'comfortable',
  radius: 'soft',
  borders: 'subtle',
  shadows: 'soft',
  tabs: 'rail',
  buttons: 'soft',
  cards: 'filled',
  inputs: 'outlined',
  accent: 'normal',
  typography: 'md',
};

const VALID_BAR_COLOR_MODE: readonly BarColorMode[] = ['rgy', 'theme', 'token'] as const;
const VALID_BAR_LAYOUT: readonly BarLayoutMode[] = ['center', 'sides'] as const;
const VALID_ACCOUNT_DELTA_VIEW: readonly AccountDeltaViewMode[] = ['per-token', 'aggregated'] as const;
const VALID_THEME: readonly ThemeName[] = ['dark', 'editor', 'light', 'merchant', 'gold-luxe', 'matrix', 'arctic'] as const;

function pickOption<T extends string>(value: unknown, valid: readonly T[], fallback: T): T {
  return typeof value === 'string' && valid.includes(value as T) ? (value as T) : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

export function normalizeUiStyle(input: Partial<UIStyleSettings> | null | undefined): UIStyleSettings {
  return {
    density: pickOption(input?.density, VALID_DENSITY, DEFAULT_UI_STYLE.density),
    radius: pickOption(input?.radius, VALID_RADIUS, DEFAULT_UI_STYLE.radius),
    borders: pickOption(input?.borders, VALID_BORDERS, DEFAULT_UI_STYLE.borders),
    shadows: pickOption(input?.shadows, VALID_SHADOWS, DEFAULT_UI_STYLE.shadows),
    tabs: pickOption(input?.tabs, VALID_TABS, DEFAULT_UI_STYLE.tabs),
    buttons: pickOption(input?.buttons, VALID_BUTTONS, DEFAULT_UI_STYLE.buttons),
    cards: pickOption(input?.cards, VALID_CARDS, DEFAULT_UI_STYLE.cards),
    inputs: pickOption(input?.inputs, VALID_INPUTS, DEFAULT_UI_STYLE.inputs),
    accent: pickOption(input?.accent, VALID_ACCENT, DEFAULT_UI_STYLE.accent),
    typography: pickOption(input?.typography, VALID_TYPOGRAPHY, DEFAULT_UI_STYLE.typography),
  };
}

export function applyUiStyleToDocument(uiStyleInput: Partial<UIStyleSettings> | null | undefined): void {
  if (typeof document === 'undefined') return;

  const uiStyle = normalizeUiStyle(uiStyleInput);
  const root = document.documentElement;

  const densityScale = uiStyle.density === 'compact' ? 0.92 : uiStyle.density === 'roomy' ? 1.08 : 1;
  const controlHeight = uiStyle.density === 'compact' ? 40 : uiStyle.density === 'roomy' ? 48 : 44;
  const radiusBase = uiStyle.radius === 'sharp' ? 8 : uiStyle.radius === 'pill' ? 18 : 12;
  const radiusLarge = uiStyle.radius === 'sharp' ? 12 : uiStyle.radius === 'pill' ? 24 : 16;
  const radiusPill = uiStyle.radius === 'sharp' ? 12 : 999;
  const borderAlpha = uiStyle.borders === 'minimal' ? 0.34 : uiStyle.borders === 'strong' ? 0.82 : 0.56;
  const borderStrongAlpha = uiStyle.borders === 'minimal' ? 0.48 : uiStyle.borders === 'strong' ? 0.96 : 0.72;
  const shadowOpacity = uiStyle.shadows === 'flat' ? 0 : uiStyle.shadows === 'float' ? 0.14 : 0.07;
  const shadowLift = uiStyle.shadows === 'flat' ? '0px 0px 0px' : uiStyle.shadows === 'float' ? '0px 20px 48px' : '0px 10px 24px';
  const accentSoft = uiStyle.accent === 'quiet' ? 0.05 : uiStyle.accent === 'bold' ? 0.18 : 0.1;
  const accentBorder = uiStyle.accent === 'quiet' ? 0.12 : uiStyle.accent === 'bold' ? 0.34 : 0.22;
  const fontScale = uiStyle.typography === 'sm' ? 0.94 : uiStyle.typography === 'lg' ? 1.06 : 1;
  const cardFillOpacity = uiStyle.cards === 'flat' ? 0.78 : uiStyle.cards === 'striped' ? 0.88 : 0.94;
  const inputFillOpacity = uiStyle.inputs === 'minimal' ? 0.62 : uiStyle.inputs === 'filled' ? 0.94 : 0.82;

  root.style.setProperty('--ui-density-scale', String(densityScale));
  root.style.setProperty('--ui-control-height', `${controlHeight}px`);
  root.style.setProperty('--ui-radius-base', `${radiusBase}px`);
  root.style.setProperty('--ui-radius-large', `${radiusLarge}px`);
  root.style.setProperty('--ui-radius-pill', String(radiusPill));
  root.style.setProperty('--ui-border-alpha', String(borderAlpha));
  root.style.setProperty('--ui-border-strong-alpha', String(borderStrongAlpha));
  root.style.setProperty('--ui-border-mix', `${Math.round(borderAlpha * 100)}%`);
  root.style.setProperty('--ui-border-strong-mix', `${Math.round(borderStrongAlpha * 100)}%`);
  root.style.setProperty('--ui-shadow-opacity', String(shadowOpacity));
  root.style.setProperty('--ui-shadow-lift', shadowLift);
  root.style.setProperty('--ui-accent-soft', String(accentSoft));
  root.style.setProperty('--ui-accent-border', String(accentBorder));
  root.style.setProperty('--ui-accent-soft-mix', `${Math.round(accentSoft * 100)}%`);
  root.style.setProperty('--ui-accent-border-mix', `${Math.round(accentBorder * 100)}%`);
  root.style.setProperty('--ui-font-scale', String(fontScale));
  root.style.setProperty('--ui-card-fill-opacity', String(cardFillOpacity));
  root.style.setProperty('--ui-input-fill-opacity', String(inputFillOpacity));
  root.style.setProperty('--ui-card-fill-mix', `${Math.round(cardFillOpacity * 100)}%`);
  root.style.setProperty('--ui-input-fill-mix', `${Math.round(inputFillOpacity * 100)}%`);

  root.setAttribute('data-ui-density', uiStyle.density);
  root.setAttribute('data-ui-radius', uiStyle.radius);
  root.setAttribute('data-ui-borders', uiStyle.borders);
  root.setAttribute('data-ui-shadows', uiStyle.shadows);
  root.setAttribute('data-ui-tabs', uiStyle.tabs);
  root.setAttribute('data-ui-buttons', uiStyle.buttons);
  root.setAttribute('data-ui-cards', uiStyle.cards);
  root.setAttribute('data-ui-inputs', uiStyle.inputs);
  root.setAttribute('data-ui-accent', uiStyle.accent);
  root.setAttribute('data-ui-typography', uiStyle.typography);
}

export function exportUiSettings(settings: Settings): UiSettingsExport {
  return {
    version: 1,
    theme: settings.theme,
    uiStyle: normalizeUiStyle(settings.uiStyle),
    compactNumbers: !!settings.compactNumbers,
    showTokenIcons: !!settings.showTokenIcons,
    showTimeMachine: !!settings.showTimeMachine,
    tokenPrecision: clampNumber(settings.tokenPrecision, 4, 2, 18),
    accountDeltaViewMode: settings.accountDeltaViewMode,
    portfolioScale: clampNumber(settings.portfolioScale, 5000, 1000, 10000),
    barColorMode: settings.barColorMode,
    barLayout: settings.barLayout,
    accountBarUsdPerPx: clampNumber(settings.accountBarUsdPerPx, 20, 0.1, 100),
    verboseLogging: !!settings.verboseLogging,
    barCreditGradient: !!settings.barCreditGradient,
    barAnimTransition: !!settings.barAnimTransition,
    barAnimSweep: !!settings.barAnimSweep,
    barAnimGlow: !!settings.barAnimGlow,
    barAnimDeltaFlash: !!settings.barAnimDeltaFlash,
    barAnimRipple: !!settings.barAnimRipple,
  };
}

export function normalizeImportedUiSettings(input: unknown): Partial<Settings> {
  if (!input || typeof input !== 'object') {
    throw new Error('Expected a JSON object');
  }

  const value = input as Partial<UiSettingsExport>;
  if (value.version !== 1) {
    throw new Error('Unsupported UI settings version');
  }

  return {
    theme: pickOption(value.theme, VALID_THEME, 'dark'),
    uiStyle: normalizeUiStyle(value.uiStyle),
    compactNumbers: !!value.compactNumbers,
    showTokenIcons: !!value.showTokenIcons,
    showTimeMachine: !!value.showTimeMachine,
    tokenPrecision: clampNumber(value.tokenPrecision, 4, 2, 18),
    accountDeltaViewMode: pickOption(value.accountDeltaViewMode, VALID_ACCOUNT_DELTA_VIEW, 'per-token'),
    portfolioScale: clampNumber(value.portfolioScale, 5000, 1000, 10000),
    barColorMode: pickOption(value.barColorMode, VALID_BAR_COLOR_MODE, 'rgy'),
    barLayout: pickOption(value.barLayout, VALID_BAR_LAYOUT, 'center'),
    accountBarUsdPerPx: clampNumber(value.accountBarUsdPerPx, 20, 0.1, 100),
    verboseLogging: !!value.verboseLogging,
    barCreditGradient: !!value.barCreditGradient,
    barAnimTransition: !!value.barAnimTransition,
    barAnimSweep: !!value.barAnimSweep,
    barAnimGlow: !!value.barAnimGlow,
    barAnimDeltaFlash: !!value.barAnimDeltaFlash,
    barAnimRipple: !!value.barAnimRipple,
  };
}
