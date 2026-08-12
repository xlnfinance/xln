/**
 * UI-specific types for XLN frontend
 *
 * These types are frontend-only and not shared with backend.
 * Shared machine types come directly from their Runtime, Entity, or Account
 * owner. This module only gives frontend code one UI-oriented import surface.
 */

import type { EnvSnapshot, RuntimeTx } from '@xln/runtime/runtime/types';
import type { EntityInput } from '@xln/runtime/entity/types';
import type { FrameLogEntry } from '@xln/runtime/types/logging';

// Re-export commonly used backend types for convenience
export type {
  EntityReplica,
  EntityState,
  EntityInput,
} from '@xln/runtime/entity/types';
export type { EntityTx } from '@xln/runtime/types/entity-tx';
export type {
  AccountReplica,
  AccountState,
  Delta,
  DerivedDelta,
  AccountFrame,
  AccountTx,
} from '@xln/runtime/types/account';
export type {
  RuntimeInput,
  RuntimeTx,
  EnvSnapshot as Snapshot, // Frontend historically called this Snapshot
} from '@xln/runtime/runtime/types';
export type {
  LogLevel,
  LogCategory,
  FrameLogEntry,
} from '@xln/runtime/types/logging';

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
  liteMode: boolean;
  compactNumbers: boolean;
  showTokenIcons: boolean;
  showTimeMachine: boolean;
  showXlnMascot: boolean;
  xlnMascotDock: XlnMascotDockPlacement;
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

export type XlnMascotDockSide = 'left' | 'right' | 'top' | 'bottom';

export interface XlnMascotDockPlacement {
  version: 1;
  side: XlnMascotDockSide;
  offsetRatio: number;
}

export type AccountSkin = 'classic' | 'apple';
// Minimal capacity-bar styles for the 'apple' skin.
export type AccountBarStyle = 'hairline' | 'pips' | 'twin' | 'capsule' | 'thread';

export interface Settings {
  theme: ThemeName;
  // Account list visual skin: 'classic' (current) or 'apple' (minimal, progressive disclosure). A/B.
  accountSkin: AccountSkin;
  // Capacity-bar style used by the 'apple' skin.
  accountBarStyle: AccountBarStyle;
  uiStyle: UIStyleSettings;
  liteMode: boolean;
  barColorMode: BarColorMode;
  barLayout: BarLayoutMode;
  // Internal normalized bar scale. UI presents this as "100px = $N".
  accountBarUsdPerPx: number;
  accountDeltaViewMode: AccountDeltaViewMode;
  tokenPrecision: number;
  showTokenIcons: boolean;
  showTimeMachine: boolean;
  showXlnMascot: boolean;
  xlnMascotDock: XlnMascotDockPlacement;
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
// Jurisdiction UI display
// =============================================================================
// STRUCTURED LOGGING SYSTEM
// =============================================================================
// Core log types are imported from their backend owner above.

/** Log filter configuration (frontend-only) */
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
