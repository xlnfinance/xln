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
  DebtStatus,
  RuntimeInput,
  EntityInput,
  RoutedEntityInput,
  AccountTx,
  SettlementDiff,
  CrossJurisdictionSwapRoute,
  PaymentDeliveryMode,
} from './types';
export type { PersistedFrameJournal } from './storage/types';
export type { BoardMemberInput } from './entity/factory';
export type { PersistedActivityJournal } from './api/activity-history';
export type { StorageFrameRecord, StorageHead } from './storage/types';
export type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeRecording,
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
  TowerLastResortPayloadV1,
  TowerActionKindV1,
  TowerAppointmentOwnerProofV1,
  TowerAppointmentV1,
  TowerCounterDisputeRemedy,
  TowerDiscoverResponseV1,
  TowerEncryptedPayloadV1,
  TowerFinalDisputeProof,
  TowerModeV1,
  TowerReceiptV1,
  TowerRestoreRequestV1,
  TowerRestoreResponseV1,
} from './recovery/types';

export type { Profile, GossipLayer } from './networking/gossip';
export type { PaymentRoute } from './routing/pathfinding';
export type { CompletedBatch, JBatch, JBatchState } from './jurisdiction/batch';
export type { JAdapter, JEvent } from './jadapter/types';
export type { BookState, OrderbookExtState, PreparedSwapOrder } from './orderbook';
export type {
  SwapAccountCapacityView,
  SwapAccountCapacityViewInput,
  SwapInboundCapacityPlan,
  SwapInboundCapacityPlanInput,
} from './account/swap-inbound-plan';
export type {
  MppChallenge,
  MppChallengeBindingInput,
  MppCredential,
  MppJsonRecord,
  MppJsonValue,
  MppReceipt,
} from './agent-payments/mpp';
export type { RuntimeActivityEvent, RuntimeActivityFilters } from './api/activity-history';
export type { DeliveryOutcome, DeliveryResult } from './protocol/payments/delivery-result';
export type { RuntimeEntityInputRoutingResult } from './machine/output-routing';
export type {
  RuntimeAdapter,
  RuntimeAdapterAuthLevel,
	  RuntimeAdapterConfig,
	  RuntimeAdapterReadQuery,
	  RuntimeAdapterSendResult,
	  RuntimeAdapterStatus,
	} from './radapter';
export { getBestBid, getBestAsk, getBookSideLevels } from './orderbook';
export {
  buildMppChallengeHeader,
  buildMppCredentialHeader,
  buildMppReceiptHeader,
  canonicalizeMppJson,
  computeMppChallengeId,
  decodeMppJson,
  encodeMppJson,
  parseMppChallengeHeader,
  parseMppCredentialHeader,
  parseMppReceiptHeader,
} from './agent-payments/mpp';
export {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarketForLegs,
  deriveCanonicalCrossJurisdictionVenueIdForLegs,
} from './extensions/cross-j/market';
export {
  getJurisdictionStackId,
  isJurisdictionStackRef,
} from './jurisdiction/jurisdiction-stack';

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
  AccountMachine,
} from './types';
import type { BoardMemberInput } from './entity/factory';
import type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeRecording,
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
  TowerLastResortPayloadV1,
  TowerModeV1,
} from './recovery/types';
import type { JAdapter } from './jadapter/types';
import type { PersistedFrameJournal } from './storage/types';
import type { EmbeddedRuntimeAdapter } from './radapter/embedded';
import type { RemoteRuntimeAdapter } from './radapter/remote';
import type { PersistedActivityJournal, RuntimeActivityFilters } from './api/activity-history';
import type { RuntimeEntityInputRoutingResult } from './machine/output-routing';
import type {
  RuntimeAdapterAccountPage,
  RuntimeAdapterBookPage,
  RuntimeAdapterGraphAccount,
  RuntimeAdapterGraphAccountActivity,
  RuntimeAdapterGraphAccountPage,
  RuntimeAdapterGraphEntityCore,
  RuntimeAdapterGraphFrame,
  RuntimeAdapterHistoryFrameBatch,
  RuntimeAdapterViewFrame,
  resolveRuntimeAdapterRead,
} from './radapter/resolve';
import type {
	  RuntimeAdapterActivityPage,
	  RuntimeAdapterEntitySummary,
	  RuntimeAdapterReadQuery,
	  RuntimeAdapterSolvencySummary,
	  RuntimeAdapterTimelineIndexPage,
	  RuntimeAdapterTimelineFrame,
	} from './radapter/types';

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
  RuntimeAdapterGraphAccount,
  RuntimeAdapterGraphAccountActivity,
  RuntimeAdapterGraphAccountPage,
  RuntimeAdapterGraphEntityCore,
  RuntimeAdapterGraphFrame,
  RuntimeAdapterHistoryFrameBatch,
	  RuntimeAdapterViewFrame,
	  RuntimeAdapterActivityPage,
	  RuntimeAdapterEntitySummary,
	  RuntimeAdapterSolvencySummary,
	  RuntimeAdapterTimelineIndexPage,
	  RuntimeAdapterTimelineFrame,
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
  riskMode?: CrossJurisdictionSwapRoute['riskMode'];
  settlementPolicy?: CrossJurisdictionSwapRoute['settlementPolicy'];
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
  main: (runtimeSeedOverride?: string | null) => Promise<Env>;
  process: (env: Env, inputs?: unknown[], delay?: number) => Promise<Env>;
  hasRuntimeWork?: (env: Env) => boolean;
  registerEnvChangeCallback: (env: Env, callback: (env: Env) => void) => (() => void);
  registerRecoveryBackupBarrier?: (
    env: Env,
    callback: (env: Env, info: { height: number; remoteOutputCount: number; jInputCount: number }) => Promise<void>,
  ) => (() => void);
  getEnv: (env?: Env | null) => Env | null;
  getActiveJAdapter?: (env: Env | null) => JAdapter | null;
  getEntityJAdapter: (env: Env, entityId: string, signerId?: string) => JAdapter | null;
  buildDebtEnforcementRuntimeInputFromProjection: (
    params: import('./machine/jurisdiction-api').DebtEnforcementProjectionRuntimeInputParams,
  ) => RuntimeInput;
  buildDebtEnforcementRuntimeInput: (
    env: Env,
    params: import('./machine/jurisdiction-api').DebtEnforcementRuntimeInputParams,
  ) => RuntimeInput;
  applyJEventsToEnv?: (
    env: Env,
    events: import('./jadapter/types').JEvent[],
    label: string,
    source: JAdapter | import('./types').JReplica,
  ) => void;
  buildJEventsRuntimeInput?: (
    env: Env,
    events: import('./jadapter/types').JEvent[],
    label: string,
    source: JAdapter | import('./types').JReplica,
  ) => RuntimeInput | null;
  queueEntityInput?: (env: Env, entityId: string, signerId: string, txData: QueueEntityInputPayload) => Promise<void>;
  submitCrossJurisdictionSwap?: (
    env: Env,
    params: CrossJurisdictionSwapSubmitParams,
  ) => Promise<CrossJurisdictionSwapSubmitResult>;
  submitCrossJurisdictionIntent: (
    env: Env,
    route: CrossJurisdictionSwapRoute,
  ) => Promise<CrossJurisdictionSwapSubmitResult>;
  buildDisputeArgumentsForSnapshot?: (
    account: AccountMachine,
    entityState: EntityState,
    counterpartyEntityId: string,
    proofbodyHash: string,
    options: { secretsSide: 'left' | 'right' | 'none' },
  ) => { leftArguments: string; rightArguments: string };

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
  registerSignerKey: (
    scope: import('./account/crypto').SignerKeyEnv | Uint8Array | string,
    signerId: string,
    privateKey: Uint8Array,
  ) => void;
  clearSignerKeys: (scope: import('./account/crypto').SignerKeyEnv | Uint8Array | string) => void;
  getCachedSignerPrivateKey: (
    scope: import('./account/crypto').SignerKeyEnv | Uint8Array | string,
    signerId: string,
  ) => Uint8Array | null;
  deriveSignerKey: (seed: Uint8Array | string, signerId: string) => Promise<Uint8Array>;
  deriveSignerKeySync: (seed: Uint8Array | string, signerId: string) => Uint8Array;

  // Account utilities
  deriveDelta: (delta: Delta, isLeft: boolean) => DerivedDelta;
  isLeft: (entityId: string, counterpartyId: string) => boolean;
  formatTokenAmount: (tokenId: number, amount: bigint | null | undefined) => string;
  getTokenInfo: (tokenId: number) => { symbol: string; name: string; decimals: number; color: string };
  getKnownTokenIds: () => number[];
  getTokenIdsForJurisdiction: (input?: { name?: string | null; chainId?: number | null } | string | null) => number[];
  isLiquidSwapToken: (tokenId: number) => boolean;
  getSwapPairOrientation: (tokenA: number, tokenB: number) => { baseTokenId: number; quoteTokenId: number; pairId: string };
  getDefaultSwapTradingPairs: () => Array<{ baseTokenId: number; quoteTokenId: number; pairId: string }>;
  listOpenSwapOffers: (state: Pick<EntityState, 'accounts'>) => import('./types').SwapBookEntry[];
  computeSwapPriceTicks: (giveTokenId: number, wantTokenId: number, giveAmount: bigint, wantAmount: bigint) => bigint;
  getSwapLotScale: (baseTokenId: number) => bigint;
  prepareSwapOrder: (giveTokenId: number, wantTokenId: number, giveAmount: bigint, wantAmount: bigint) => import('./orderbook').PreparedSwapOrder | null;
  quantizeSwapOrder: (giveTokenId: number, wantTokenId: number, giveAmount: bigint, wantAmount: bigint) => { effectiveGive: bigint; effectiveWant: bigint; priceTicks: bigint } | null;
  requantizeRemainingSwapAtPrice: (
    giveTokenId: number,
    wantTokenId: number,
    remainingGiveAmount: bigint,
    priceTicks: bigint,
  ) => { effectiveGive: bigint; effectiveWant: bigint; releasedGiveDust: bigint } | null;
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

  // Machine Payments Protocol core compatibility
  canonicalizeMppJson: (value: unknown) => string;
  encodeMppJson: (value: unknown) => string;
  decodeMppJson: <T = import('./agent-payments/mpp').MppJsonValue>(value: string) => T;
  buildMppChallengeHeader: (challenge: import('./agent-payments/mpp').MppChallenge) => string;
  parseMppChallengeHeader: (header: string) => import('./agent-payments/mpp').MppChallenge;
  buildMppCredentialHeader: (credential: import('./agent-payments/mpp').MppCredential) => string;
  parseMppCredentialHeader: (header: string) => import('./agent-payments/mpp').MppCredential;
  buildMppReceiptHeader: (receipt: import('./agent-payments/mpp').MppReceipt) => string;
  parseMppReceiptHeader: (header: string) => import('./agent-payments/mpp').MppReceipt;
  computeMppChallengeId: (
    secret: string | Uint8Array,
    challenge: import('./agent-payments/mpp').MppChallengeBindingInput,
  ) => string;

  // Validation
  validateDelta: (delta: unknown) => Delta;
  validateAccountDeltas: (deltas: unknown) => Map<number, Delta>;
  createDefaultDelta: (tokenId: number) => Delta;
  isDelta: (obj: unknown) => obj is Delta;

  // Profile management
  createProfileUpdateTx: (profile: Partial<EntityProfile>) => unknown;

  // Jurisdiction management
  getAvailableJurisdictions: () => Promise<JurisdictionConfig[]>;
  getJurisdictionByAddress: (address: string) => JurisdictionConfig | undefined;

  // Entity creation
  generateLazyEntityId: (validators: readonly BoardMemberInput[], threshold: bigint) => string;
  generateNumberedEntityId: (entityNumber: number) => string;
  generateNamedEntityId: (name: string) => string;
  createLazyEntity: (name: string, validators: readonly BoardMemberInput[], threshold: bigint, jurisdiction?: JurisdictionConfig) => { config: ConsensusConfig; executionTimeMs: number };
  createNumberedEntity: (
    name: string,
    validators: readonly BoardMemberInput[],
    threshold: bigint,
    jurisdiction: JurisdictionConfig,
    env: Env,
    registrationSignerId: string,
  ) => Promise<{ config: ConsensusConfig; entityNumber: number; entityId: string }>;
  createNumberedEntitiesBatch: (
    entities: readonly Readonly<{
      name: string;
      validators: readonly BoardMemberInput[];
      threshold: bigint;
    }>[],
    jurisdiction: JurisdictionConfig,
    env: Env,
    registrationSignerId: string,
  ) => Promise<Array<{ config: ConsensusConfig; entityNumber: number; entityId: string }>>;

  // Runtime operations
  applyRuntimeInput: (env: Env, input: RuntimeInput) => Promise<{ entityOutbox: EntityInput[]; mergedInputs: EntityInput[] }>;
  planSwapInboundCapacity: typeof import('./account/swap-inbound-plan').planSwapInboundCapacity;
  readSwapAccountCapacity: typeof import('./account/swap-inbound-plan').readSwapAccountCapacity;
  validateRuntimeInputAdmission: (env: Env, input: RuntimeInput) => void;
  enqueueRuntimeInput: (env: Env, input: RuntimeInput) => void;
  startRuntimeLoop?: (env: Env) => () => void;
  resumeRuntimeLoop: (env: Env) => () => void;
  resumeRuntimeAfterPersistenceQuiesce: (env: Env) => () => void;
  stopRuntimeLoopAndWait: (env: Env, timeoutMs?: number) => Promise<boolean>;
  waitForRuntimeWorkDrained: (
    env: Env,
    timeoutMs?: number,
    quietMs?: number,
    options?: { allowPersistencePaused?: boolean },
  ) => Promise<boolean>;
  closeRuntimeDb?: (env: Env) => Promise<void>;
  closeInfraDb?: (env: Env) => Promise<void>;
  startP2P: (env: Env, config?: P2PConfig) => unknown;
  startJurisdictionWatchers: (env: Env) => void;
  stopJurisdictionWatchers: (env: Env) => void;
  stopJurisdictionWatchersAndWait: (env: Env) => Promise<void>;
  stopP2P: (env: Env) => void;
  stopP2PAndWait: (env: Env, timeoutMs?: number) => Promise<void>;
  getP2P: (env: Env) => unknown;
  getP2PState: (env: Env) => { connected: boolean; reconnect: { attempt: number; nextAt: number } | null; queue: { targetCount: number; totalMessages: number; oldestEntryAge: number; perTarget: Record<string, number> } };
  refreshGossip?: (env: Env) => void;
  clearGossip?: (env: Env) => void;
  // runDemo: REMOVED - use scenarios.ahb(env) or scenarios.grid(env) instead

  // Environment creation
  createEmptyEnv: (seed?: Uint8Array | string | null) => Env;
  setRuntimeId: (env: Env, id: string | null) => void;
  deriveRuntimeId: (seed: string) => string;  // Derive runtimeId from seed (for isolated envs)

  // Scenarios namespace
  scenarios: {
    ahb: (env: Env) => Promise<Env>;
    lockAhb: (env: Env) => Promise<Env>;
    swap: (env: Env) => Promise<Env>;
    grid: (env: Env) => Promise<Env>;
    settle?: (env: Env) => Promise<Env>;
    swapMarket?: (env: Env) => Promise<Env>;
    rapidFire?: (env: Env) => Promise<Env>;
    disputeLifecycle?: (env: Env) => Promise<Env>;
    fullMechanics: (env: Env) => Promise<Env>;
  };

  // Database operations
  clearDB: (env?: Env) => Promise<void>;
  clearDatabase: () => Promise<void>;
  saveEnvToDB: (env: Env) => Promise<void>;
  persistRestoredEnvToDB: (env: Env) => Promise<void>;
  restoreEnvFromCheckpointSnapshot: (
    snapshot: Record<string, unknown>,
    options?: { runtimeSeed?: string | null; runtimeId?: string | null },
  ) => Promise<Env>;
  restoreEnvFromRecoveryBundles: (
    bundles: RuntimeRecoveryBundleV1[],
    options?: {
      runtimeSeed?: string | null;
      runtimeId?: string | null;
      targetHeight?: number;
      readOnly?: boolean;
    },
  ) => Promise<Env>;
  loadEnvFromDB: (
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    options?: LoadEnvFromDbOptions,
  ) => Promise<Env | null>;
  getPersistedLatestHeight: (env: Env) => Promise<number>;
  readPersistedRuntimeActivityPage: (
    env: Env,
    opts?: RuntimeActivityFilters & {
      beforeHeight?: number | undefined;
      limit?: number | undefined;
      scanLimit?: number | undefined;
    },
  ) => Promise<RuntimeAdapterActivityPage>;
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
  verifyLiveRuntimeStorage: (env: Env) => Promise<{
    ok: true;
    runtimeId: string;
    latestHeight: number;
    checkedFrames: number;
  }>;
  readPersistedFrameJournal: (env: Env, height: number) => Promise<PersistedFrameJournal | null>;
  readPersistedRuntimeActivityJournal: (env: Env, height: number) => Promise<PersistedActivityJournal | null>;
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
    options: {
      signers: RuntimeRecoverySignerV1[];
      meta?: RuntimeRecoveryMetaV1;
      createdAt?: number;
      kind?: 'snapshot' | 'journal_tail';
      baseCheckpoint?: { height: number; hash: string };
      frames?: PersistedFrameJournal[];
    },
  ) => RuntimeRecoveryBundleV1;
  buildPersistedRuntimeRecording: (
    env: Env,
    options: {
      signers: RuntimeRecoverySignerV1[];
      meta?: RuntimeRecoveryMetaV1;
      createdAt?: number;
    },
  ) => Promise<RuntimeRecording>;
  openDetachedRuntimeRecording: (
    recording: RuntimeRecording,
    runtimeSeed: string,
  ) => {
    readonly runtimeId: string;
    readonly baseHeight: number;
    readonly targetHeight: number;
    readAtHeight(height: number): Promise<Env>;
    close(): Promise<void>;
  };
  encryptRuntimeRecoveryBundle: (
    bundle: RuntimeRecoveryBundleV1,
    runtimeSeed: string,
  ) => Promise<EncryptedRuntimeRecoveryBundleV1>;
  decryptRuntimeRecoveryBundle: (
    bundle: EncryptedRuntimeRecoveryBundleV1,
    runtimeSeed: string,
  ) => Promise<RuntimeRecoveryBundleV1>;
  deriveRuntimeRecoveryActionLookupKey: (
    runtimeId: string,
    runtimeSeed: string,
    entityId: string,
    counterentity: string,
  ) => string;
  deriveRuntimeRecoveryLookupKey: (runtimeId: string, runtimeSeed: string) => string;
  buildTowerAppointmentOwnerMessage: (
    runtimeId: string,
    towerMode: TowerModeV1,
    lookupKey: string,
    slot: number,
    bundleHash: string,
    height: number,
    signedAt: number,
    lastResortPayload?: TowerLastResortPayloadV1 | null,
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
  encryptTowerPayloadForWatchSeed: (
    plaintext: string,
    watchSeed: string,
  ) => Promise<string>;
  decryptTowerPayloadWithWatchSeed: (
    payloadJson: string,
    watchSeed: string,
  ) => Promise<string>;
  buildSingleSignerHanko: (
    entityId: string,
    hash: string,
    privateKey: string | Uint8Array,
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

  setBrowserVMJurisdiction: (env: Env, depositoryAddress: string, browserVMInstance?: unknown) => void;
  getBrowserVMInstance: (env?: Env) => unknown | null;

  // Networking helpers
  sendEntityInput: (env: Env, input: EntityInput) => RuntimeEntityInputRoutingResult;
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
