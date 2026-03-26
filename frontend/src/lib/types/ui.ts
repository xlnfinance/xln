/**
 * UI-specific types for XLN frontend
 *
 * These types are frontend-only and not shared with backend.
 * For shared types (EntityState, AccountMachine, etc.), import from $types
 */

import type { EnvSnapshot, EntityInput, RuntimeTx, LogLevel, LogCategory, FrameLogEntry } from '$types';

// Re-export commonly used backend types for convenience
export type {
  EntityReplica,
  AccountMachine,
  EntityState,
  EntityTx,
  EntityInput,
  RuntimeInput,
  RuntimeTx,
  Delta,
  DerivedDelta,
  AccountFrame,
  AccountTx,
  EnvSnapshot as Snapshot, // Frontend historically called this Snapshot
  // Structured logging types (canonical definitions from backend)
  LogLevel,
  LogCategory,
  FrameLogEntry,
} from '$types';

// Tab management for multi-entity UI
export interface Tab {
  id: string;
  title: string;
  jurisdiction: string;
  signerId: string;
  entityId: string;
  accountId?: string;
  isActive: boolean;
}

// UI state management
export interface ComponentState {
  [componentId: string]: boolean; // expanded/collapsed state
}

// Theme system
export type ThemeName = 'dark' | 'editor' | 'light' | 'merchant' | 'gold-luxe' | 'matrix' | 'arctic';

// ThemeColors interface is defined in utils/themes.ts (single source of truth)
export type { ThemeColors } from '$lib/utils/themes';

export type BarColorMode = 'rgy' | 'theme' | 'token';
export type BarLayoutMode = 'center' | 'sides';
export type AccountDeltaViewMode = 'per-token' | 'aggregated';
export type UIDensityMode = 'compact' | 'comfortable' | 'roomy';
export type UIRadiusMode = 'sharp' | 'soft' | 'pill';
export type UIBorderMode = 'minimal' | 'subtle' | 'strong';
export type UIShadowMode = 'flat' | 'soft' | 'float';
export type UITabStyle = 'minimal' | 'underline' | 'rail' | 'pill' | 'segmented' | 'floating';
export type UIButtonStyle = 'minimal' | 'soft' | 'solid';
export type UICardStyle = 'flat' | 'filled' | 'striped';
export type UIInputStyle = 'minimal' | 'outlined' | 'filled';
export type UIAccentIntensity = 'quiet' | 'normal' | 'bold';
export type UITypographyScale = 'sm' | 'md' | 'lg';

export interface UIStyleSettings {
  density: UIDensityMode;
  radius: UIRadiusMode;
  borders: UIBorderMode;
  shadows: UIShadowMode;
  tabs: UITabStyle;
  buttons: UIButtonStyle;
  cards: UICardStyle;
  inputs: UIInputStyle;
  accent: UIAccentIntensity;
  typography: UITypographyScale;
}

export interface UiSettingsExport {
  version: 1;
  theme: ThemeName;
  uiStyle: UIStyleSettings;
  compactNumbers: boolean;
  showTokenIcons: boolean;
  showTimeMachine: boolean;
  tokenPrecision: number;
  accountDeltaViewMode: AccountDeltaViewMode;
  portfolioScale: number;
  barColorMode: BarColorMode;
  barLayout: BarLayoutMode;
  accountBarUsdPerPx: number;
  verboseLogging: boolean;
  barCreditGradient: boolean;
  barAnimTransition: boolean;
  barAnimSweep: boolean;
  barAnimGlow: boolean;
  barAnimDeltaFlash: boolean;
  barAnimRipple: boolean;
}

export interface Settings {
  theme: ThemeName;
  uiStyle: UIStyleSettings;
  barColorMode: BarColorMode;
  barLayout: BarLayoutMode;
  // Internal normalized bar scale. UI presents this as "100px = $N".
  accountBarUsdPerPx: number;
  accountDeltaViewMode: AccountDeltaViewMode;
  tokenPrecision: number;
  showTokenIcons: boolean;
  showTimeMachine: boolean;
  dropdownMode: 'signer-first' | 'entity-first';
  runtimeDelay: number;
  balanceRefreshMs: number;
  relayUrl: string;
  portfolioScale: number;
  componentStates: ComponentState;
  compactNumbers: boolean;
  verboseLogging: boolean;
  // Bar visual effects (Appearance tab)
  barCreditGradient: boolean;
  barAnimTransition: boolean;
  barAnimSweep: boolean;
  barAnimGlow: boolean;
  barAnimDeltaFlash: boolean;
  barAnimRipple: boolean;
}

// Time machine
export interface TimeState {
  currentTimeIndex: number;
  maxTimeIndex: number;
  isLive: boolean;
}

// Entity formation forms
export interface EntityFormData {
  entityType: 'lazy' | 'numbered' | 'named';
  entityName: string;
  jurisdiction: string;
  validators: ValidatorData[];
  threshold: number;
}

export interface ValidatorData {
  name: string;
  weight: number;
}

// Jurisdiction UI display
export interface JurisdictionStatus {
  port: number;
  name: string;
  connected: boolean;
  chainId?: number;
  blockNumber?: number;
  contractAddress?: string;
  nextEntityNumber?: number;
  entities: EntityInfo[];
  lastUpdate: Date;
}

export interface EntityInfo {
  id: string;
  name: string;
  type: 'lazy' | 'numbered' | 'named';
  boardHash: string;
}

// =============================================================================
// STRUCTURED LOGGING SYSTEM
// =============================================================================
// Core log types (LogLevel, LogCategory, FrameLogEntry) are imported from $types

/** Log filter configuration (frontend-only) */
export interface LogFilter {
  levels: Set<LogLevel>;
  categories: Set<LogCategory>;
  entityId?: string; // Filter to specific entity
  searchText?: string; // Free-text search
}

// Server frame wrapper for transaction history UI
export interface RuntimeFrame {
  frameIndex: number;
  snapshot: EnvSnapshot;
  inputs: EntityInput[];
  outputs: EntityInput[]; // Backend uses EntityInput for both directions
  imports: RuntimeTx[];
  runtimeTxs: RuntimeTx[];
  timestamp: number;
  hasActivity: boolean;
  logs: FrameLogEntry[]; // Frame-specific structured logs
}

// Banking transaction display
export interface BankingTransaction {
  type: 'input' | 'output' | 'import';
  icon: string;
  primaryInfo: string;
  secondaryInfo: string;
  amount: string;
}
