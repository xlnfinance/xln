/**
 * UI-specific types for XLN frontend
 *
 * These types are frontend-only and not shared with backend.
 * For shared types (EntityState, AccountMachine, etc.), import from $types
 */

import type { EnvSnapshot, EntityInput, ServerTx } from '$types';

// Re-export commonly used backend types for convenience
export type {
  EntityReplica,
  AccountMachine,
  EntityState,
  EntityTx,
  EntityInput,
  ServerInput,
  ServerTx,
  Delta,
  DerivedDelta,
  AccountFrame,
  AccountTx,
  EnvSnapshot as Snapshot, // Frontend historically called this Snapshot
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
export type ThemeName = 'dark' | 'light' | 'gold-luxe' | 'matrix' | 'arctic';

export interface ThemeColors {
  name: string;
  background: string;
  backgroundGradient: string;
  entityColor: string;
  entityEmissive: string;
  connectionColor: string;
  creditColor: string;
  debitColor: string;
  collateralColor: string;
  textPrimary: string;
  textSecondary: string;
  accentColor: string;
  borderColor: string;
  glassBackground: string;
  glassBorder: string;
}

export interface Settings {
  theme: ThemeName;
  dropdownMode: 'signer-first' | 'entity-first';
  serverDelay: number;
  portfolioScale: number;
  componentStates: ComponentState;
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

// Server frame wrapper for transaction history UI
export interface ServerFrame {
  frameIndex: number;
  snapshot: EnvSnapshot;
  inputs: EntityInput[];
  outputs: EntityInput[]; // Backend uses EntityInput for both directions
  imports: ServerTx[];
  serverTxs: ServerTx[];
  timestamp: number;
  hasActivity: boolean;
}

// Banking transaction display
export interface BankingTransaction {
  type: 'input' | 'output' | 'import';
  icon: string;
  primaryInfo: string;
  secondaryInfo: string;
  amount: string;
}
