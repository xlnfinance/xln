/**
 * EntityEnvContext - Pierce store boundary once
 *
 * Provides a unified API for entity panels to access environment state,
 * regardless of whether using global stores (/ route) or isolated stores (/view route).
 *
 * Usage:
 *   // In parent component (View.svelte or legacy layout):
 *   setEntityEnvContext({ isolatedEnv, isolatedHistory, isolatedTimeIndex });
 *
 *   // In child component (EntityPanel, PaymentPanel, etc.):
 *   const { env, replicas, timeIndex, isLive, xlnFunctions } = getEntityEnv();
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import { getContext, setContext } from 'svelte';
import { derived, get, type Readable, type Writable } from 'svelte/store';
import type { EntityReplica } from '$lib/types/ui';

// Import global stores as fallback
import { xlnEnvironment, xlnFunctions as globalXlnFunctions } from '$lib/stores/xlnStore';
import { visibleReplicas, currentTimeIndex, isLive as globalIsLive } from '$lib/stores/timeStore';
import { history as globalHistory } from '$lib/stores/xlnStore';

const ENTITY_ENV_CONTEXT_KEY = Symbol('entity-env-context');

/**
 * XLN Functions interface - utilities exposed from runtime.js
 */
export interface XLNFunctions {
  deriveDelta: (delta: TokenDelta, isLeft: boolean) => DerivedDelta;
  getTokenInfo: (tokenId: number) => TokenInfo;
  formatTokenAmount: (tokenId: number, amount: bigint) => string;
  getEntityShortId: (entityId: string) => string;
  formatEntityId: (entityId: string) => string;
  safeStringify: (obj: unknown) => string;
  generateEntityAvatar: (entityId: string) => string;
  generateSignerAvatar: (signerId: string) => string;
  classifyBilateralState?: (myAccount: unknown, peerCurrentHeight: number | undefined, isLeft: boolean) => { state: string; isLeftEntity: boolean; shouldRollback: boolean; pendingHeight: number | null; mempoolCount: number };
  getAccountBarVisual?: (leftState: unknown, rightState: unknown) => { glowColor: string | null; glowSide: string | null; glowIntensity: number; isDashed: boolean; pulseSpeed: number };
  resolveEntityProposerId?: (env: unknown, entityId: string, context: string) => string;
  sendEntityInput?: (env: unknown, input: unknown) => { sent: boolean; deferred: boolean; queuedLocal: boolean };
}

/**
 * Token delta as stored in account state
 */
export interface TokenDelta {
  collateral: bigint;
  ondelta: bigint;
  offdelta: bigint;
  leftCreditLimit: bigint;
  rightCreditLimit: bigint;
}

/**
 * Derived delta with calculated capacities
 */
export interface DerivedDelta {
  delta: bigint;
  collateral: bigint;
  inCollateral: bigint;
  outCollateral: bigint;
  totalCapacity: bigint;
  inCapacity: bigint;
  outCapacity: bigint;
  ownCreditLimit: bigint;
  peerCreditLimit: bigint;
  inOwnCredit: bigint;
  outOwnCredit: bigint;
  inPeerCredit: bigint;
  outPeerCredit: bigint;
  outSettleHold: bigint;
  inSettleHold: bigint;
  outHtlcHold: bigint;
  inHtlcHold: bigint;
  ascii?: string;
}

/**
 * Token info from runtime
 */
export interface TokenInfo {
  symbol: string;
  decimals: number;
  name?: string;
  color?: string;
}

/**
 * Runtime history frame
 */
export interface HistoryFrame {
  height: number;
  timestamp: number;
  runtimeSeed?: string;
  runtimeId?: string;
  eReplicas: Map<string, EntityReplica>;
  jReplicas?: unknown[];
  runtimeInput?: unknown;
  runtimeOutputs?: unknown[];
  description?: string;
  title?: string;
  gossip?: {
    profiles?: Array<{ entityId: string; metadata?: { name?: string } }>;
    getProfiles?: () => Array<{ entityId: string; metadata?: { name?: string } }>;
  };
}

/**
 * Environment state accessible to all entity components
 */
export interface EntityEnvState {
  /** Current environment (time-aware - historical frame or live) */
  env: Readable<HistoryFrame | null>;
  /** Current entity replicas map */
  eReplicas: Readable<Map<string, EntityReplica>>;
  /** Current time index (-1 = live mode) */
  timeIndex: Readable<number>;
  /** Whether in live mode vs historical playback */
  isLive: Readable<boolean>;
  /** History frames array */
  history: Readable<HistoryFrame[]>;
  /** XLN runtime functions (formatting, derivation, etc.) */
  xlnFunctions: Readable<XLNFunctions | null>;
}

/**
 * Options for setting up the context
 */
export interface EntityEnvContextOptions {
  /** Isolated environment store (for /view route) */
  isolatedEnv?: Writable<HistoryFrame | null> | undefined;
  /** Isolated history store (for /view route) */
  isolatedHistory?: Writable<HistoryFrame[]> | undefined;
  /** Isolated time index store (for /view route) */
  isolatedTimeIndex?: Writable<number> | undefined;
  /** Isolated isLive store (for /view route) */
  isolatedIsLive?: Writable<boolean> | undefined;
}

/**
 * Set up entity environment context in a parent component.
 * If isolated stores are provided, uses those; otherwise falls back to global stores.
 *
 * Call this in onMount or at component initialization in View.svelte or layout.
 */
export function setEntityEnvContext(options: EntityEnvContextOptions = {}): void {
  const {
    isolatedEnv,
    isolatedHistory,
    isolatedTimeIndex,
    isolatedIsLive,
  } = options;

  // Use isolated stores if provided, otherwise global
  const useIsolated = isolatedEnv !== undefined;

  // Time index store
  const timeIndex: Readable<number> = isolatedTimeIndex ?? currentTimeIndex;

  // History store
  const history: Readable<HistoryFrame[]> = isolatedHistory ?? globalHistory as Readable<HistoryFrame[]>;

  // Is live store — explicit boolean, not derived from timeIndex
  const isLive: Readable<boolean> = isolatedIsLive ?? derived(globalIsLive, ($v) => $v);

  // Environment: raw env for off-runtime infra (gossip, signers, jadapter, P2P)
  const env: Readable<HistoryFrame | null> = useIsolated
    ? (isolatedEnv! as Readable<HistoryFrame | null>)
    : (xlnEnvironment as Readable<HistoryFrame | null>);

  // Replicas: ALWAYS from history[timeIndex] (consistent snapshots), fallback to raw env
  const replicas: Readable<Map<string, EntityReplica>> = useIsolated
    ? derived([isolatedHistory!, isolatedTimeIndex!, isolatedEnv!], ([$hist, $idx, $env]) => {
        if ($hist && $hist.length > 0) {
          const idx = Math.max(0, Math.min($idx, $hist.length - 1));
          const frame = $hist[idx];
          if (frame?.eReplicas) return new Map(frame.eReplicas);
        }
        return $env?.eReplicas ? new Map($env.eReplicas) : new Map();
      })
    : visibleReplicas as Readable<Map<string, EntityReplica>>;

  // XLN functions (always from global - loaded once)
  const xlnFunctions: Readable<XLNFunctions | null> = globalXlnFunctions as Readable<XLNFunctions | null>;

  const state: EntityEnvState = {
    env,
    eReplicas: replicas,
    timeIndex,
    isLive,
    history,
    xlnFunctions,
  };

  setContext(ENTITY_ENV_CONTEXT_KEY, state);
}

/**
 * Get entity environment context in child components.
 * Must be called during component initialization (not in event handlers).
 *
 * @throws Error if context not found (setEntityEnvContext not called in parent)
 */
export function getEntityEnv(): EntityEnvState {
  const ctx = getContext<EntityEnvState | undefined>(ENTITY_ENV_CONTEXT_KEY);

  if (!ctx) {
    // Fallback to global stores if context not set (legacy mode)
    console.warn('[EntityEnvContext] Context not found, using global stores fallback');
    return createGlobalFallback();
  }

  return ctx;
}

/**
 * Check if entity context has been set
 */
export function hasEntityEnvContext(): boolean {
  return getContext<EntityEnvState | undefined>(ENTITY_ENV_CONTEXT_KEY) !== undefined;
}

/**
 * Create fallback using only global stores (for components used outside context)
 */
function createGlobalFallback(): EntityEnvState {
  const timeIndex = currentTimeIndex;
  const history = globalHistory as Readable<HistoryFrame[]>;
  const isLive = derived(timeIndex, ($idx) => $idx < 0);

  const env = derived(
    [globalHistory as Readable<HistoryFrame[]>, currentTimeIndex, xlnEnvironment],
    ([$hist, $idx, $xlnEnv]) => {
      if ($idx >= 0 && $hist && $hist.length > 0) {
        const idx = Math.min($idx, $hist.length - 1);
        return $hist[idx] ?? null;
      }
      return $xlnEnv as HistoryFrame | null;
    }
  );

  return {
    env,
    eReplicas: visibleReplicas as Readable<Map<string, EntityReplica>>,
    timeIndex,
    isLive,
    history,
    xlnFunctions: globalXlnFunctions as Readable<XLNFunctions | null>,
  };
}

/**
 * Utility: Get current value from a store (for non-reactive access)
 */
export function getEnvValue<T>(store: Readable<T>): T {
  return get(store);
}
