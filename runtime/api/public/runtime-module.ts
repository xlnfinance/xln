/**
 * Browser Runtime module contract.
 *
 * This file defines the interface for the XLN runtime module as loaded by the browser.
 * Frontend can import these types for compile-time checking while runtime.js
 * is loaded dynamically at runtime.
 *
 * Usage in frontend:
 *   import type { XLNModule, RuntimeReplica } from '@xln/runtime/api/public/runtime-module';
 */

// Re-export identity types from ids.ts
export type {
  EntityId,
  SignerId,
  JId,
  EntityProviderAddress,
  ReplicaKey,
  EntityType,
} from '../../protocol/identity';

// Re-export core types from types.ts
export type { RuntimeReplica, EnvSnapshot, RuntimeInput, RoutedEntityInput } from '../../runtime/types';
export type { EntityReplica, EntityState, SwapBookEntry, JurisdictionConfig, ConsensusConfig, EntityInput } from '../../entity/types';
export type { JReplica } from '../../types/jurisdiction-runtime';
export type { EntityTx } from '../../types/entity-tx';
export type { AccountReplica, AccountState, AccountFrame, Delta, DerivedDelta, AccountTx, SettlementDiff } from '../../types/account';
export type { Xlnomy } from '../../types/xlnomy';
export type { HubRebalanceConfig } from '../../types/rebalance';
export type { DebtEntry } from '../../types/debt';
export type { CrossJurisdictionSwapRoute } from '../../types/cross-jurisdiction';
export type { PaymentDeliveryMode } from '../../types/payment';
export type { PersistedFrameJournal } from '../../storage/types';
export type { RuntimeFrame, StorageHead } from '../../storage/types';
export type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
  TowerLastResortPayloadV1,
  TowerAppointmentV1,
  TowerCounterDisputeRemedy,
  TowerModeV1,
  TowerReceiptV1,
} from '../../storage/recovery/types';

export type { Profile } from '../../entity/profile';
export type { PaymentRoute } from '../../routing/pathfinding';
export type { JBatch, JBatchState } from '../../jurisdiction/machine/batch';
export type { JAdapter } from '../../jurisdiction/adapter/types';
export type { BookState } from '../../orderbook';
export type {
  SwapAccountCapacityView,
  SwapInboundCapacityPlan,
} from '../../account/swap-inbound-plan';
export type { RuntimeActivityEvent, RuntimeActivityFilters } from '../../storage/views/activity-types';
export type { DeliveryResult } from '../../protocol/payments/delivery-result';
export type {
  RuntimeAdapter,
  RuntimeAdapterAuthLevel,
  RuntimeAdapterConfig,
  RuntimeAdapterReadQuery,
  RuntimeAdapterSendResult,
  RuntimeAdapterStatus,
  NumberedRegistrationCommand,
  NumberedRegistrationCommandResult,
} from '../runtime-adapter';
export { getBestBid, getBestAsk, getBookSideLevels } from '../../orderbook';
export { isTronChainId } from '../../jurisdiction/adapter/chain-ids';
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
} from '../../protocol/payments/mpp';
export {
  deriveCanonicalCrossJurisdictionBookOwnerForLegs,
  deriveCanonicalCrossJurisdictionMarketForLegs,
} from '../../extensions/cross-j/market';
export {
  getJurisdictionStackId,
} from '../../jurisdiction/machine/jurisdiction-stack';

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
  XLN_URI_SCHEME,
  DEFAULT_RUNTIME_HOST,
  MAX_NUMBERED_ENTITY,
} from '../../protocol/identity';
export {
  formatEntityDisplay,
  formatSignerDisplay,
  formatReplicaDisplay,
  getEntityDisplayNumber,
} from '../../protocol/identity-display';
export { formatReplicaUri, parseReplicaUri } from '../../protocol/identity-uri';

import type {
  RuntimeAdapterGraphEntityCore,
  RuntimeAdapterGraphFrame,
  RuntimeAdapterFrameSummary,
  RuntimeAdapterHistoryFrameBatch,
  RuntimeAdapterViewFrame,
} from '../runtime-adapter/resolve';
import type {
	  RuntimeAdapterActivityPage,
	  RuntimeAdapterEntitySummary,
	  RuntimeAdapterSolvencySummary,
	  RuntimeAdapterTimelineIndexPage,
	} from '../runtime-adapter/types';

export type BrowserVMTokenInfo = {
  tokenId: number;
  symbol: string;
  name?: string;
  address?: string;
  decimals: number;
};

export type {
  RuntimeAdapterGraphEntityCore,
  RuntimeAdapterGraphFrame,
  RuntimeAdapterFrameSummary,
  RuntimeAdapterHistoryFrameBatch,
	  RuntimeAdapterViewFrame,
	  RuntimeAdapterActivityPage,
	  RuntimeAdapterEntitySummary,
	  RuntimeAdapterSolvencySummary,
	  RuntimeAdapterTimelineIndexPage,
	};


/**
 * Entity display info returned by getEntityDisplayInfo
 */
export interface EntityDisplayInfo {
  name: string;
  avatar: string;
  type: 'numbered' | 'lazy' | 'named';
}

/** Exact financial utility shapes exported by runtime. */
export type FinancialConstants =
  typeof import('../../account/financial-utils').FINANCIAL_CONSTANTS;

/**
 * Exact browser bundle namespace; no handwritten mirror may drift.
 *
 * The production Runtime facade deliberately excludes demo scenarios. The
 * browser composition root adds them without making the financial core depend
 * on QA code.
 */
export type XLNModule = typeof import('./browser');
