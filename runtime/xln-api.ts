/**
 * XLN API Types - Frontend-importable type definitions
 *
 * This file defines the interface for the XLN runtime module as loaded by the browser.
 * Frontend can import these types for compile-time checking while runtime.js
 * is loaded dynamically at runtime.
 *
 * Usage in frontend:
 *   import type { XLNModule, RuntimeState } from '@xln/runtime/xln-api';
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
} from './protocol/identity';
export type { JurisdictionInfo } from './protocol/jurisdiction-identity';

// Re-export core types from types.ts
export type {
  RuntimeState,
  EnvSnapshot,
  EntityReplica,
  EntityState,
  JReplica,
  SwapBookEntry,
  EntityTx,
  AccountState,
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

export type { GossipLayer } from './networking/gossip';
export type { Profile } from './entity/profile';
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
} from './protocol/payments/mpp';
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
} from './protocol/payments/mpp';
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
  safeParseReplicaKey,
  safeExtractEntityId,
  XLN_URI_SCHEME,
  DEFAULT_RUNTIME_HOST,
  MAX_NUMBERED_ENTITY,
} from './protocol/identity';
export {
  formatEntityDisplay,
  formatSignerDisplay,
  formatReplicaDisplay,
  getEntityDisplayNumber,
} from './protocol/identity-display';
export { formatReplicaUri, parseReplicaUri } from './protocol/identity-uri';

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

export type { P2PConfig } from './networking/p2p';
export type {
  CrossJurisdictionSwapSubmitParams,
  CrossJurisdictionSwapSubmitResult,
} from './runtime/jurisdiction-api';

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

/** Exact browser runtime module namespace; no handwritten mirror may drift. */
export type XLNModule = typeof import('./runtime');
