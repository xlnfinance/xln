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
  CrossJurisdictionSwapCommandPlan,
  SameJurisdictionSwapCommandPlan,
  SwapCommandPlan,
  SwapCommandPlanInput,
  SwapCommandPreparedOrder,
} from './account/swap-command-plan';
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
export type { RuntimeEntityInputRoutingResult } from './runtime/output-routing';
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
  JurisdictionConfig,
  ConsensusConfig,
  CrossJurisdictionSwapRoute,
  RuntimeInput,
  EntityInput,
  EntityState,
  AccountMachine,
} from './types';
import type { BoardMemberInput } from './entity/factory';
import type { JAdapter } from './jadapter/types';
import type { EmbeddedRuntimeAdapter } from './radapter/embedded';
import type { RemoteRuntimeAdapter } from './radapter/remote';
import type { RuntimeEntityInputRoutingResult } from './runtime/output-routing';
import type {
  RuntimeAdapterAccountPage,
  RuntimeAdapterBookPage,
  RuntimeAdapterGraphAccount,
  RuntimeAdapterGraphAccountActivity,
  RuntimeAdapterGraphAccountPage,
  RuntimeAdapterGraphEntityCore,
  RuntimeAdapterGraphFrame,
  RuntimeAdapterFrameSummary,
  RuntimeAdapterHistoryFrameBatch,
  RuntimeAdapterViewFrame,
  resolveRuntimeAdapterRead,
} from './radapter/resolve';
import type {
	  RuntimeAdapterActivityPage,
	  RuntimeAdapterEntitySummary,
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
  RuntimeAdapterFrameSummary,
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

/** Exact financial utility shapes exported by runtime. */
export type FinancialConstants =
  typeof import('./account/financial-utils').FINANCIAL_CONSTANTS;
export type BigIntMathUtils =
  typeof import('./account/financial-utils').BigIntMath;

/**
 * XLN Module Interface - defines all exports from runtime.js
 *
 * This is the type for the dynamically loaded runtime module.
 */
export interface XLNModule {
  // Core lifecycle
  main: typeof import('./runtime').main;
  processRuntime: typeof import('./runtime').processRuntime;
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
    params: import('./runtime/jurisdiction-api').DebtEnforcementProjectionRuntimeInputParams,
  ) => RuntimeInput;
  buildDebtEnforcementRuntimeInput: (
    env: Env,
    params: import('./runtime/jurisdiction-api').DebtEnforcementRuntimeInputParams,
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
  deriveDelta: typeof import('./account/utils').deriveDelta;
  isLeft: typeof import('./account/utils').isLeft;
  formatTokenAmount:
    typeof import('./account/financial-utils').formatTokenAmount;
  getTokenInfo: typeof import('./account/utils').getTokenInfo;
  getKnownTokenIds: typeof import('./account/utils').getKnownTokenIds;
  getTokenIdsForJurisdiction:
    typeof import('./account/utils').getTokenIdsForJurisdiction;
  isLiquidSwapToken: typeof import('./account/utils').isLiquidSwapToken;
  getSwapPairOrientation:
    typeof import('./account/utils').getSwapPairOrientation;
  getDefaultSwapTradingPairs:
    typeof import('./account/utils').getDefaultSwapTradingPairs;
  listOpenSwapOffers:
    typeof import('./orderbook/open-swap-offers').listOpenSwapOffers;
  computeSwapPriceTicks: typeof import('./orderbook').computeSwapPriceTicks;
  getSwapLotScale: typeof import('./orderbook').getSwapLotScale;
  prepareSwapOrder: typeof import('./orderbook').prepareSwapOrder;
  quantizeSwapOrder: typeof import('./orderbook').quantizeSwapOrder;
  requantizeRemainingSwapAtPrice:
    typeof import('./orderbook').requantizeRemainingSwapAtPrice;
  createDemoDelta: typeof import('./account/utils').createDemoDelta;
  getDefaultCreditLimit:
    typeof import('./account/utils').getDefaultCreditLimit;

  // Financial utilities (ethers.js-based)
  formatTokenAmountEthers:
    typeof import('./account/financial-utils').formatTokenAmount;
  parseTokenAmount:
    typeof import('./account/financial-utils').parseTokenAmount;
  convertTokenPrecision:
    typeof import('./account/financial-utils').convertTokenPrecision;
  calculatePercentageEthers:
    typeof import('./account/financial-utils').calculatePercentage;
  formatAssetAmountEthers:
    typeof import('./account/financial-utils').formatAssetAmount;
  BigIntMath: BigIntMathUtils;
  FINANCIAL_CONSTANTS: FinancialConstants;

  // Serialization
  safeStringify: typeof import('./protocol/serialization').safeStringify;
  encode: typeof import('./storage/snapshot-coder').encode;
  decode: typeof import('./storage/snapshot-coder').decode;

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
  createProfileUpdateTx:
    typeof import('./routing/name-resolution').createProfileUpdateTx;

  // Jurisdiction management
  getAvailableJurisdictions:
    typeof import('./jurisdiction/config').getAvailableJurisdictions;
  getJurisdictionByAddress:
    typeof import('./jadapter').getJurisdictionByAddress;

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
  planSwapCommand: typeof import('./account/swap-command-plan').planSwapCommand;
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
  clearDB: typeof import('./runtime').clearDB;
  clearDatabase: typeof import('./runtime').clearDatabase;
  saveEnvToDB: typeof import('./runtime').saveEnvToDB;
  persistRestoredEnvToDB:
    typeof import('./runtime').persistRestoredEnvToDB;
  restoreEnvFromCheckpointSnapshot:
    typeof import('./runtime').restoreEnvFromCheckpointSnapshot;
  restoreEnvFromRecoveryBundles:
    typeof import('./runtime').restoreEnvFromRecoveryBundles;
  loadEnvFromDB: typeof import('./runtime').loadEnvFromDB;
  getPersistedLatestHeight:
    typeof import('./runtime').getPersistedLatestHeight;
  readPersistedRuntimeActivityPage:
    typeof import('./runtime').readPersistedRuntimeActivityPage;
  readPersistedStorageHead:
    typeof import('./runtime').readPersistedStorageHead;
  readPersistedStorageFrameRecord:
    typeof import('./runtime').readPersistedStorageFrameRecord;
  listPersistedCheckpointHeights:
    typeof import('./runtime').listPersistedCheckpointHeights;
  listPersistedEntityIdsAtHeight:
    typeof import('./runtime').listPersistedEntityIdsAtHeight;
  loadEntityStateFromStorageDb:
    typeof import('./runtime').loadEntityStateFromStorageDb;
  loadEntityAccountDocFromStorageDb:
    typeof import('./runtime').loadEntityAccountDocFromStorageDb;
  loadEntityViewPageFromStorageDb:
    typeof import('./runtime').loadEntityViewPageFromStorageDb;
  verifyRuntimeChain: typeof import('./runtime').verifyRuntimeChain;
  verifyLiveRuntimeStorage:
    typeof import('./runtime').verifyLiveRuntimeStorage;
  readPersistedFrameJournal:
    typeof import('./runtime').readPersistedFrameJournal;
  readPersistedRuntimeActivityJournal:
    typeof import('./runtime').readPersistedRuntimeActivityJournal;
  readPersistedFrameJournals:
    typeof import('./runtime').readPersistedFrameJournals;
  readPersistedCheckpointSnapshot:
    typeof import('./runtime').readPersistedCheckpointSnapshot;
  buildRuntimeRecoveryBundle:
    typeof import('./runtime').buildRuntimeRecoveryBundle;
  buildPersistedRuntimeRecording:
    typeof import('./runtime').buildPersistedRuntimeRecording;
  openDetachedRuntimeRecording:
    typeof import('./runtime').openDetachedRuntimeRecording;
  encryptRuntimeRecoveryBundle:
    typeof import('./runtime').encryptRuntimeRecoveryBundle;
  decryptRuntimeRecoveryBundle:
    typeof import('./runtime').decryptRuntimeRecoveryBundle;
  deriveRuntimeRecoveryActionLookupKey:
    typeof import('./runtime').deriveRuntimeRecoveryActionLookupKey;
  deriveRuntimeRecoveryLookupKey:
    typeof import('./runtime').deriveRuntimeRecoveryLookupKey;
  buildTowerAppointmentOwnerMessage:
    typeof import('./runtime').buildTowerAppointmentOwnerMessage;
  computeWatchtowerCounterDisputeAuthorizationHash:
    typeof import('./runtime').computeWatchtowerCounterDisputeAuthorizationHash;
  encryptTowerPayloadForWatchSeed:
    typeof import('./runtime').encryptTowerPayloadForWatchSeed;
  decryptTowerPayloadWithWatchSeed:
    typeof import('./runtime').decryptTowerPayloadWithWatchSeed;
  buildSingleSignerHanko:
    typeof import('./runtime').buildSingleSignerHanko;

  // Blockchain operations
  submitProcessBatch: typeof import('./jadapter').submitProcessBatch;
  debugFundReserves: typeof import('./jadapter').debugFundReserves;

  // History and snapshots
  getHistory: typeof import('./runtime').getHistory;
  getSnapshot: typeof import('./runtime').getSnapshot;
  getCurrentHistoryIndex: typeof import('./runtime').getCurrentHistoryIndex;
  getCleanLogs: typeof import('./runtime').getCleanLogs;
  clearCleanLogs: typeof import('./runtime').clearCleanLogs;
  copyCleanLogs: typeof import('./runtime').copyCleanLogs;

  // Entity detection
  detectEntityType: typeof import('./entity/factory').detectEntityType;
  isEntityRegistered:
    typeof import('./entity/factory').isEntityRegistered;
  getEntityInfoFromChain:
    typeof import('./jadapter').getEntityInfoFromChain;

  // Name operations
  resolveEntityName: typeof import('./runtime').resolveEntityName;
  resolveEntityIdentifier:
    typeof import('./entity/factory').resolveEntityIdentifier;
  searchEntityNames: typeof import('./runtime').searchEntityNames;
  requestNamedEntity: typeof import('./entity/factory').requestNamedEntity;

  setBrowserVMJurisdiction:
    typeof import('./jadapter').setBrowserVMJurisdiction;
  getBrowserVMInstance: typeof import('./jadapter').getBrowserVMInstance;

  // Networking helpers
  sendEntityInput: (env: Env, input: EntityInput) => RuntimeEntityInputRoutingResult;
  resolveEntityProposerId: (env: Env, entityId: string, context: string) => string;
  ensureGossipProfiles?: (env: Env, entityIds: string[]) => Promise<boolean>;

  // Entity display helpers
  getEntityDisplayInfoFromProfile:
    (entityId: string) => Promise<{ name: string; avatar: string }>;

  // Bilateral consensus state
  classifyBilateralState:
    typeof import('./account/view-state').classifyBilateralState;
  getAccountBarVisual:
    typeof import('./account/view-state').getAccountBarVisual;

  // Runtime adapter contract (embedded and remote share the same read resolver)
  EmbeddedRuntimeAdapter: typeof EmbeddedRuntimeAdapter;
  RemoteRuntimeAdapter: typeof RemoteRuntimeAdapter;
  resolveRuntimeAdapterRead: typeof resolveRuntimeAdapterRead;
}

type RequiredKeys<T extends object> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];

type RequiredXLNModule = Pick<XLNModule, RequiredKeys<XLNModule>>;
type RuntimeModuleExports = typeof import('./runtime');

/**
 * Compile-time diagnostics for the browser runtime boundary.
 *
 * `XLNModule` is necessarily handwritten because the frontend loads runtime.js
 * dynamically. These aliases make that boundary fail compilation when a
 * required export disappears or its implementation stops satisfying the
 * declared frontend contract.
 */
export type XLNRuntimeMissingRequiredExports = Exclude<
  keyof RequiredXLNModule,
  keyof RuntimeModuleExports
>;

export type XLNRuntimeIncompatibleRequiredExports = {
  [K in Extract<keyof RequiredXLNModule, keyof RuntimeModuleExports>]:
    RuntimeModuleExports[K] extends RequiredXLNModule[K] ? never : K;
}[Extract<keyof RequiredXLNModule, keyof RuntimeModuleExports>];

type AssertNever<T extends never> = T;

export type XLNRuntimeModuleConformance = AssertNever<
  XLNRuntimeMissingRequiredExports | XLNRuntimeIncompatibleRequiredExports
>;
