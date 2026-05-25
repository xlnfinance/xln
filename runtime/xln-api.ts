/**
 * XLN API Types - Frontend-importable type definitions
 *
 * This file defines the interface for the XLN runtime module as loaded by the browser.
 * Frontend can import these types for compile-time checking while runtime.js
 * is loaded dynamically at runtime.
 *
 * Usage in frontend:
 *   import type { XLNModule, Env } from '@xln/runtime/xln-api';
 */

// Re-export identity types from ids.ts
export type {
  EntityId,
  SignerId,
  JId,
  EntityProviderAddress,
  ReplicaKey,
  FullReplicaAddress,
  ReplicaUri,
  EntityType,
  JurisdictionInfo,
} from './ids';

// Re-export core types from types.ts
export type {
  Env,
  EnvSnapshot,
  EntityReplica,
  EntityState,
  JReplica,
  SwapBookEntry,
  EntityTx,
  AccountMachine,
  AccountFrame,
  AccountSnapshot,
  Delta,
  DerivedDelta,
  Xlnomy,
  XlnomySnapshot,
  EntityProfile,
  JurisdictionConfig,
  ConsensusConfig,
  HubRebalanceConfig,
  DebtEntry,
  DebtUpdate,
  DebtStatus,
  RuntimeInput,
  EntityInput,
  RoutedEntityInput,
  AccountTx,
  SettlementDiff,
  CrossJurisdictionSwapRoute,
} from './types';
export type { PersistedFrameJournal } from './wal/store';
export type { StorageFrameRecord, StorageHead } from './storage/types';
export type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
  TowerActivePayloadV1,
  TowerActionKindV1,
  TowerAppointmentOwnerProofV1,
  TowerAppointmentV1,
  TowerCounterDisputeRemedyV1,
  TowerDiscoverResponseV1,
  TowerFinalDisputeProofV1,
  TowerModeV1,
  TowerReceiptV1,
  TowerRestoreRequestV1,
  TowerRestoreResponseV1,
} from './recovery/types';

export type { Profile, GossipLayer } from './networking/gossip';
export type { PaymentRoute } from './routing/pathfinding';
export type { CompletedBatch, JBatch, JBatchState } from './j-batch';
export type { JAdapter } from './jadapter/types';
export type { BookState, OrderbookExtState, PreparedSwapOrder } from './orderbook';
export type {
  RuntimeAdapter,
  RuntimeAdapterAuthLevel,
  RuntimeAdapterConfig,
  RuntimeAdapterReadQuery,
  RuntimeAdapterStatus,
} from './radapter';
export { getBestBid, getBestAsk, getBookSideLevels } from './orderbook';
export {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionVenueIdForLegs,
} from './cross-jurisdiction-market';
export {
  getJurisdictionStackId,
  isJurisdictionStackRef,
} from './jurisdiction-stack';

// Re-export identity functions types
export {
  parseReplicaKey,
  extractEntityId,
  extractSignerId,
  formatReplicaKey,
  createReplicaKey,
  formatEntityDisplay,
  formatSignerDisplay,
  formatReplicaDisplay,
  isValidEntityId,
  isValidSignerId,
  isValidJId,
  isValidEpAddress,
  toEntityId,
  toSignerId,
  toJId,
  toEpAddress,
  isNumberedEntity,
  isLazyEntity,
  getEntityDisplayNumber,
  formatReplicaUri,
  parseReplicaUri,
  safeParseReplicaKey,
  safeExtractEntityId,
  XLN_URI_SCHEME,
  DEFAULT_RUNTIME_HOST,
  MAX_NUMBERED_ENTITY,
} from './ids';

import type { EntityId, SignerId, ReplicaKey } from './ids';
import type {
  Env,
  Delta,
  DerivedDelta,
  EntityProfile,
  JurisdictionConfig,
  ConsensusConfig,
  CrossJurisdictionSwapRoute,
  RuntimeInput,
  EntityInput,
  EntityState,
} from './types';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
  TowerActivePayloadV1,
  TowerModeV1,
} from './recovery/types';
import type { JAdapter } from './jadapter/types';
import type { PersistedFrameJournal } from './wal/store';
import type { EmbeddedRuntimeAdapter } from './radapter/embedded';
import type { RemoteRuntimeAdapter } from './radapter/remote';
import type {
  RuntimeAdapterAccountPage,
  RuntimeAdapterBookPage,
  RuntimeAdapterViewFrame,
  resolveRuntimeAdapterRead,
} from './radapter/resolve';
import type { RuntimeAdapterEntitySummary, RuntimeAdapterReadQuery } from './radapter/types';

export type QueueEntityInputPayload = {
  type: string;
} & Record<string, unknown>;

export type BrowserVMTokenInfo = {
  tokenId: number;
  symbol: string;
  name?: string;
  address?: string;
  decimals: number;
};

export type LoadEnvFromDbOptions = {
  fromSnapshotHeight?: number;
};

export type VerifyRuntimeChainResult = {
  ok: true;
  latestHeight: number;
  checkpointHeight: number;
  selectedSnapshotHeight: number;
  restoredHeight: number;
  expectedStateHash: string;
  actualStateHash: string;
};

export type {
  RuntimeAdapterAccountPage,
  RuntimeAdapterBookPage,
  RuntimeAdapterViewFrame,
  RuntimeAdapterEntitySummary,
};

export type P2PConfig = {
  relayUrls?: string[];
  wsUrl?: string | null;
  seedRuntimeIds?: string[];
  runtimeId?: string;
  signerId?: string;
  advertiseEntityIds?: string[];
  isHub?: boolean;
  gossipPollMs?: number;
};

export type CrossJurisdictionSwapSubmitParams = {
  orderId?: string;
  sourceUserEntityId: string;
  sourceHubEntityId: string;
  targetHubEntityId: string;
  targetUserEntityId: string;
  sourceTokenId: number;
  sourceAmount: bigint;
  targetTokenId: number;
  targetAmount: bigint;
  bookHubEntityId?: string;
  sourceUserSignerId?: string;
  sourceHubSignerId?: string;
  targetHubSignerId?: string;
  targetUserSignerId?: string;
  bookHubSignerId?: string;
  expiresInMs?: number;
  priceTicks?: bigint;
  priceImprovementMode?: CrossJurisdictionSwapRoute['priceImprovementMode'];
  memo?: string;
};

export type CrossJurisdictionSwapSubmitResult = {
  route: CrossJurisdictionSwapRoute;
};

/**
 * Entity display info returned by getEntityDisplayInfo
 */
export interface EntityDisplayInfo {
  name: string;
  avatar: string;
  type: 'numbered' | 'lazy' | 'named';
}

/**
 * Signer display info returned by getSignerDisplayInfo
 */
export interface SignerDisplayInfo {
  name: string;
  address: string;
  avatar: string;
}

/**
 * Financial constants exported by runtime
 */
export interface FinancialConstants {
  PRECISION_18: bigint;
  PRECISION_6: bigint;
  MAX_SAFE_BIGINT: bigint;
  MIN_SAFE_BIGINT: bigint;
}

/**
 * BigInt math utilities
 */
export interface BigIntMathUtils {
  min: (...values: bigint[]) => bigint;
  max: (...values: bigint[]) => bigint;
  abs: (value: bigint) => bigint;
  clamp: (value: bigint, min: bigint, max: bigint) => bigint;
}

/**
 * XLN Module Interface - defines all exports from runtime.js
 *
 * This is the type for the dynamically loaded runtime module.
 */
export interface XLNModule {
  // Core lifecycle
  main: () => Promise<Env>;
  process: (env: Env, inputs?: unknown[], delay?: number) => Promise<Env>;
  registerEnvChangeCallback: (env: Env, callback: (env: Env) => void) => (() => void);
  registerRecoveryBackupBarrier?: (
    env: Env,
    callback: (env: Env, info: { height: number; remoteOutputCount: number; jInputCount: number }) => Promise<void>,
  ) => (() => void);
  getEnv: (env?: Env | null) => Env | null;
  getActiveJAdapter?: (env: Env | null) => JAdapter | null;
  getEntityJAdapter: (env: Env, entityId: string, signerId?: string) => JAdapter | null;
  submitDebtEnforcement: (
    env: Env,
    entityId: string,
    tokenId: number,
    maxIterations?: number | bigint,
    signerId?: string,
  ) => Promise<void>;
  processJBlockEvents?: (env: Env) => Promise<void>;
  queueEntityInput?: (env: Env, entityId: string, signerId: string, txData: QueueEntityInputPayload) => Promise<void>;
  submitCrossJurisdictionSwap?: (
    env: Env,
    params: CrossJurisdictionSwapSubmitParams,
  ) => Promise<CrossJurisdictionSwapSubmitResult>;
  setDeltaTransformerAddress?: (address: string) => void;

  // Identity system (from ids.ts)
  parseReplicaKey: (keyString: string) => ReplicaKey;
  extractEntityId: (keyString: string) => EntityId;
  extractSignerId: (keyString: string) => SignerId;
  formatReplicaKey: (key: ReplicaKey) => string;
  createReplicaKey: (entityId: string, signerId: string) => ReplicaKey;
  isValidEntityId: (s: string) => boolean;
  isValidSignerId: (s: string) => boolean;
  isValidJId: (s: string) => boolean;
  isValidEpAddress: (s: string) => boolean;

  // Entity utilities
  getEntityShortId: (entityId: string) => string;
  formatEntityId: (entityId: string) => string;
  formatEntityDisplay: (entityId: EntityId) => string;

  // Avatar generation
  hashToAvatar: (seed: string, size?: number) => string;
  generateEntityAvatar: (entityId: string) => string;
  generateSignerAvatar: (signerId: string) => string;
  getEntityDisplayInfo: (entityId: string) => EntityDisplayInfo;
  getSignerDisplayInfo: (signerId: string) => SignerDisplayInfo;

  // Crypto key management (for HD wallet integration)
  registerSignerKey: (signerId: string, privateKey: Uint8Array) => void;
  getCachedSignerPrivateKey: (signerId: string) => Uint8Array | null;
  deriveSignerKey: (seed: Uint8Array | string, signerId: string) => Promise<Uint8Array>;
  deriveSignerKeySync: (seed: Uint8Array | string, signerId: string) => Uint8Array;

  // Account utilities
  deriveDelta: (delta: Delta, isLeft: boolean) => DerivedDelta;
  isLeft: (entityId: string, counterpartyId: string) => boolean;
  formatTokenAmount: (tokenId: number, amount: bigint | null | undefined) => string;
  getTokenInfo: (tokenId: number) => { symbol: string; name: string; decimals: number; color: string };
  isLiquidSwapToken: (tokenId: number) => boolean;
  getSwapPairOrientation: (tokenA: number, tokenB: number) => { baseTokenId: number; quoteTokenId: number; pairId: string };
  getDefaultSwapTradingPairs: () => Array<{ baseTokenId: number; quoteTokenId: number; pairId: string }>;
  listOpenSwapOffers: (state: Pick<EntityState, 'accounts'>) => import('./types').SwapBookEntry[];
  computeSwapPriceTicks: (giveTokenId: number, wantTokenId: number, giveAmount: bigint, wantAmount: bigint) => bigint;
  prepareSwapOrder: (giveTokenId: number, wantTokenId: number, giveAmount: bigint, wantAmount: bigint) => import('./orderbook').PreparedSwapOrder | null;
  quantizeSwapOrder: (giveTokenId: number, wantTokenId: number, giveAmount: bigint, wantAmount: bigint) => { effectiveGive: bigint; effectiveWant: bigint; priceTicks: bigint } | null;
  createDemoDelta: () => Delta;
  getDefaultCreditLimit: (tokenId: number) => bigint;

  // Financial utilities (ethers.js-based)
  formatTokenAmountEthers: (amount: bigint, decimals: number) => string;
  parseTokenAmount: (amount: string, decimals: number) => bigint;
  convertTokenPrecision: (amount: bigint, fromDecimals: number, toDecimals: number) => bigint;
  calculatePercentageEthers: (amount: bigint, percentage: number) => bigint;
  formatAssetAmountEthers: (amount: bigint, symbol: string, decimals: number) => string;
  BigIntMath: BigIntMathUtils;
  FINANCIAL_CONSTANTS: FinancialConstants;

  // Serialization
  safeStringify: (obj: unknown, space?: number) => string;
  encode: (data: unknown) => Uint8Array;
  decode: (data: Uint8Array) => unknown;

  // Validation
  validateDelta: (delta: unknown) => Delta;
  validateAccountDeltas: (deltas: unknown) => Map<string, Delta>;
  createDefaultDelta: () => Delta;
  isDelta: (obj: unknown) => obj is Delta;

  // Profile management
  createProfileUpdateTx: (profile: Partial<EntityProfile>) => unknown;

  // Jurisdiction management
  getAvailableJurisdictions: () => Promise<JurisdictionConfig[]>;
  getJurisdictionByAddress: (address: string) => JurisdictionConfig | undefined;

  // Entity creation
  generateLazyEntityId: (validators: string[] | { name: string; weight: number }[], threshold: bigint) => string;
  generateNumberedEntityId: (entityNumber: number) => string;
  generateNamedEntityId: (name: string) => string;
  createLazyEntity: (name: string, validators: string[], threshold: bigint, jurisdiction?: JurisdictionConfig) => { config: ConsensusConfig; executionTimeMs: number };
  createNumberedEntity: (name: string, validators: string[], threshold: bigint, jurisdiction: JurisdictionConfig) => Promise<{ config: ConsensusConfig; entityNumber: number; entityId: string }>;
  createNumberedEntitiesBatch: (env: Env, jId: string, count: number) => Promise<Env>;

  // Runtime operations
  applyRuntimeInput: (env: Env, input: RuntimeInput) => Promise<{ entityOutbox: EntityInput[]; mergedInputs: EntityInput[] }>;
  enqueueRuntimeInput: (env: Env, input: RuntimeInput) => void;
  startRuntimeLoop?: (env: Env) => () => void;
  closeRuntimeDb?: (env: Env) => Promise<void>;
  closeInfraDb?: (env: Env) => Promise<void>;
  startP2P: (env: Env, config?: P2PConfig) => unknown;
  startJurisdictionWatchers: (env: Env) => void;
  stopP2P: (env: Env) => void;
  getP2P: (env: Env) => unknown;
  getP2PState: (env: Env) => { connected: boolean; reconnect: { attempt: number; nextAt: number } | null; queue: { targetCount: number; totalMessages: number; oldestEntryAge: number; perTarget: Record<string, number> } };
  refreshGossip?: (env: Env) => void;
  clearGossip?: (env: Env) => void;
  // runDemo: REMOVED - use scenarios.ahb(env) or scenarios.grid(env) instead

  // Environment creation
  createEmptyEnv: (seed?: Uint8Array | string | null) => Env;
  setRuntimeSeed: (env: Env, seed: string | null) => void;
  setRuntimeId: (env: Env, id: string | null) => void;
  deriveRuntimeId: (seed: string) => string;  // Derive runtimeId from seed (for isolated envs)

  // Scenarios namespace
  scenarios: {
    ahb: (env: Env) => Promise<Env>;
    lockAhb: (env: Env) => Promise<Env>;
    swap: (env: Env) => Promise<Env>;
    grid: (env: Env) => Promise<Env>;
    fullMechanics: (env: Env) => Promise<Env>;
  };

  // Database operations
  clearDB: (env?: Env) => Promise<void>;
  clearDatabase: () => Promise<void>;
  clearDatabaseAndHistory: (env: Env) => Promise<Env>;
  saveEnvToDB: (env: Env) => Promise<void>;
  restoreEnvFromCheckpointSnapshot: (
    snapshot: Record<string, unknown>,
    options?: { runtimeSeed?: string | null; runtimeId?: string | null },
  ) => Promise<Env>;
  loadEnvFromDB: (
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    options?: LoadEnvFromDbOptions,
  ) => Promise<Env | null>;
  getPersistedLatestHeight: (env: Env) => Promise<number>;
  readPersistedStorageHead: (env: Env) => Promise<import('./storage/types').StorageHead | null>;
  readPersistedStorageFrameRecord: (env: Env, height: number) => Promise<import('./storage/types').StorageFrameRecord | null>;
  listPersistedCheckpointHeights: (env: Env) => Promise<number[]>;
  listPersistedEntityIdsAtHeight: (env: Env, height: number) => Promise<string[]>;
  loadEntityStateFromStorageDb: (env: Env, entityId: string, height?: number) => Promise<EntityState | null>;
  loadEntityAccountDocFromStorageDb: (
    env: Env,
    entityId: string,
    counterpartyId: string,
    height?: number,
  ) => Promise<import('./storage/types').StorageAccountDoc | null>;
  loadEntityViewPageFromStorageDb: (
    env: Env,
    entityId: string,
    height: number,
    query?: RuntimeAdapterReadQuery,
  ) => Promise<import('./storage').StorageEntityViewPage | null>;
  verifyRuntimeChain: (
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    options?: { fromSnapshotHeight?: number },
  ) => Promise<VerifyRuntimeChainResult>;
  readPersistedFrameJournal: (env: Env, height: number) => Promise<PersistedFrameJournal | null>;
  readPersistedFrameJournals: (
    env: Env,
    opts?: {
      fromHeight?: number;
      toHeight?: number;
      limit?: number;
    },
  ) => Promise<PersistedFrameJournal[]>;
  readPersistedCheckpointSnapshot: (env: Env, height: number) => Promise<Record<string, unknown> | null>;
  buildRuntimeRecoveryBundle: (
    env: Env,
    options: { signers: RuntimeRecoverySignerV1[]; meta?: RuntimeRecoveryMetaV1; createdAt?: number },
  ) => RuntimeRecoveryBundleV1;
  encryptRuntimeRecoveryBundle: (
    bundle: RuntimeRecoveryBundleV1,
    runtimeSeed: string,
  ) => Promise<EncryptedRuntimeRecoveryBundleV1>;
  decryptRuntimeRecoveryBundle: (
    bundle: EncryptedRuntimeRecoveryBundleV1,
    runtimeSeed: string,
  ) => Promise<RuntimeRecoveryBundleV1>;
  deriveRuntimeRecoveryLookupKey: (runtimeId: string, runtimeSeed: string) => string;
  buildTowerAppointmentOwnerMessage: (
    runtimeId: string,
    towerMode: TowerModeV1,
    lookupKey: string,
    slot: number,
    bundleHash: string,
    height: number,
    signedAt: number,
    activePayload?: TowerActivePayloadV1 | null,
  ) => string;
  computeWatchtowerCounterDisputeAuthorizationHash: (
    chainId: number,
    depositoryAddress: string,
    towerAddress: string,
    entityId: string,
    counterentity: string,
    finalNonce: number,
    finalProofbodyHash: string,
    lastResortWindowBlocks: number,
    appointmentSequence: number,
  ) => string;

  // Blockchain operations
  submitProcessBatch: (env: Env, jurisdiction: JurisdictionConfig, entityId: string, batch: unknown, signerId?: string) => Promise<{ transaction: unknown; receipt: unknown }>;
  debugFundReserves: (env: Env, entityId: string, tokenAddress: string, amount: bigint) => Promise<Env>;

  // History and snapshots
  getHistory: (env: Env) => Env[];
  getSnapshot: (env: Env, index: number) => Env | null;
  getCurrentHistoryIndex: (env: Env) => number;
  getCleanLogs: (env: Env) => string;
  clearCleanLogs: (env: Env) => void;
  copyCleanLogs: (env: Env) => Promise<string>;

  // Entity detection
  detectEntityType: (entityId: string) => string;
  isEntityRegistered: (env: Env, entityId: string) => boolean;
  getEntityInfoFromChain: (entityId: string) => Promise<unknown>;

  // Name operations
  resolveEntityName: (name: string) => Promise<string | null>;
  resolveEntityIdentifier: (identifier: string) => Promise<string | null>;
  searchEntityNames: (query: string) => Promise<string[]>;
  requestNamedEntity: (env: Env, name: string) => Promise<Env>;
  assignNameOnChain: (env: Env, entityId: string, name: string) => Promise<Env>;
  transferNameBetweenEntities: (env: Env, name: string, fromEntityId: string, toEntityId: string) => Promise<Env>;

  setBrowserVMJurisdiction: (env: Env, depositoryAddress: string, browserVMInstance?: unknown) => void;
  getBrowserVMInstance: (env?: Env) => unknown | null;

  // Networking helpers
  sendEntityInput: (env: Env, input: EntityInput) => { sent: boolean; deferred: boolean; queuedLocal: boolean };
  resolveEntityProposerId: (env: Env, entityId: string, context: string) => string;
  ensureGossipProfiles?: (env: Env, entityIds: string[]) => Promise<boolean>;

  // Entity display helpers
  getEntityDisplayInfoFromProfile: (profile: EntityProfile) => EntityDisplayInfo;
  formatShortEntityId: (entityId: string) => string;

  // Bilateral consensus state
  classifyBilateralState: (myAccount: unknown, peerCurrentHeight: number | undefined, isLeft: boolean) => { state: string; isLeftEntity: boolean; shouldRollback: boolean; pendingHeight: number | null; mempoolCount: number };
  getAccountBarVisual: (leftState: unknown, rightState: unknown) => { glowColor: string | null; glowSide: string | null; glowIntensity: number; isDashed: boolean; pulseSpeed: number };

  // Runtime adapter contract (embedded and remote share the same read resolver)
  EmbeddedRuntimeAdapter: typeof EmbeddedRuntimeAdapter;
  RemoteRuntimeAdapter: typeof RemoteRuntimeAdapter;
  resolveRuntimeAdapterRead: typeof resolveRuntimeAdapterRead;
}

/**
 * Type guard for checking if XLN module is loaded
 */
export function isXLNModuleLoaded(module: unknown): module is XLNModule {
  return (
    typeof module === 'object' &&
    module !== null &&
    'main' in module &&
    'extractEntityId' in module &&
    'parseReplicaKey' in module
  );
}
