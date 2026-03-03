/**
 * EntityEnvContext - Pierce store boundary once
 *
 * Provides a unified API for entity panels to access the selected runtime env.
 * Isolated stores can be provided by parent, otherwise it reads active runtime env.
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

// Runtime-scoped stores (active runtime from RuntimeDropdown)
import { xlnEnvironment, xlnFunctions as globalXlnFunctions } from '$lib/stores/xlnStore';

const ENTITY_ENV_CONTEXT_KEY = Symbol('entity-env-context');

/**
 * XLN Functions interface - utilities exposed from runtime.js
 */
export interface XLNFunctions {
  deriveDelta: (delta: TokenDelta, isLeft: boolean) => DerivedDelta;
  getTokenInfo: (tokenId: number) => TokenInfo;
  isLiquidSwapToken: (tokenId: number) => boolean;
  getSwapPairOrientation: (tokenA: number, tokenB: number) => { baseTokenId: number; quoteTokenId: number; pairId: string };
  getDefaultSwapTradingPairs: () => Array<{ baseTokenId: number; quoteTokenId: number; pairId: string }>;
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
  outTotalHold: bigint;
  inTotalHold: bigint;
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
 * If isolated stores are provided, uses them; otherwise uses selected runtime env.
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

  const useIsolatedEnv = isolatedEnv !== undefined;
  const hasIsolatedTimeline = isolatedHistory !== undefined && isolatedTimeIndex !== undefined;

  // Environment: always selected runtime env (isolated if provided by parent).
  const env: Readable<HistoryFrame | null> = useIsolatedEnv
    ? (isolatedEnv as Readable<HistoryFrame | null>)
    : (xlnEnvironment as Readable<HistoryFrame | null>);

  // History/time: derived from selected runtime env unless isolated timeline is provided.
  const history: Readable<HistoryFrame[]> = isolatedHistory
    ? isolatedHistory
    : derived(env, ($env) => (($env?.history as HistoryFrame[] | undefined) || []));

  const timeIndex: Readable<number> = isolatedTimeIndex
    ? isolatedTimeIndex
    : derived(history, ($hist) => Math.max(0, $hist.length - 1));

  // No implicit global time-machine fallback: live=true unless parent explicitly provides isolatedIsLive.
  const isLive: Readable<boolean> = isolatedIsLive
    ? isolatedIsLive
    : derived(timeIndex, () => true);

  // Replicas: if isolated timeline provided, read frame snapshot; otherwise read current env replicas.
  const replicas: Readable<Map<string, EntityReplica>> = hasIsolatedTimeline
    ? derived([isolatedHistory as Readable<HistoryFrame[]>, isolatedTimeIndex as Readable<number>, env], ([$hist, $idx, $env]) => {
        if ($hist && $hist.length > 0) {
          const idx = Math.max(0, Math.min($idx, $hist.length - 1));
          const frame = $hist[idx];
          if (frame?.eReplicas) return new Map(frame.eReplicas);
        }
        return $env?.eReplicas ? new Map($env.eReplicas) : new Map();
      })
    : derived(env, ($env) => ($env?.eReplicas ? new Map($env.eReplicas) : new Map()));

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
    // Components should be wrapped by context, but keep a runtime-scoped fallback.
    console.warn('[EntityEnvContext] Context not found, using active runtime fallback');
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
 * Create fallback from currently selected runtime env (for components used outside context)
 */
function createGlobalFallback(): EntityEnvState {
  const env = xlnEnvironment as Readable<HistoryFrame | null>;
  const history = derived(env, ($env) => (($env?.history as HistoryFrame[] | undefined) || []));
  const timeIndex = derived(history, ($hist) => Math.max(0, $hist.length - 1));
  const isLive = derived(timeIndex, () => true);

  return {
    env,
    eReplicas: derived(env, ($env) => ($env?.eReplicas ? new Map($env.eReplicas) : new Map())),
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
