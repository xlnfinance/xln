import type { StorageEntityCoreDoc } from '../../types';

/**
 * Permanent static-key tags for the Entity envelope. Never recycle a tag:
 * changing one changes durable meaning, so an incompatible layout requires a
 * storage schema bump and a fresh network rather than a compatibility reader.
 */
export const STORAGE_ENTITY_FIELD_TAG = Object.freeze({
  entityId: 1,
  height: 2,
  timestamp: 3,
  nonces: 4,
  entityCommandNonces: 5,
  proposals: 6,
  config: 7,
  prevFrameHash: 8,
  leaderState: 9,
  reserves: 10,
  externalWallet: 11,
  deferredAccountProposals: 12,
  settlementContinuations: 13,
  lastFinalizedJHeight: 14,
  jHistoryFinality: 15,
  certifiedBoardState: 16,
  crontabState: 17,
  jBatchState: 18,
  entityProviderActionState: 19,
  entityEncryptionPublicKey: 20,
  profile: 21,
  htlcRoutes: 22,
  htlcFeesEarned: 23,
  consumptionAccumulator: 24,
  certifiedOutputSequences: 25,
  outDebtsByToken: 26,
  inDebtsByToken: 27,
  lockBook: 28,
  swapTradingPairs: 29,
  crossJurisdictionSwaps: 30,
  crossJurisdictionAuthorizations: 31,
  pendingCrossJurisdictionFillAcks: 32,
  crossJurisdictionBookAdmissions: 33,
  hubRebalanceConfig: 34,
  orderbookHubProfile: 35,
  orderbookReferrals: 36,
  orderbookPairDimensions: 37,
  lending: 38,
} as const satisfies Record<keyof StorageEntityCoreDoc, number>);

export type StorageEntityField = keyof typeof STORAGE_ENTITY_FIELD_TAG;

export const STORAGE_ENTITY_FIELD_BY_TAG = new Map<number, StorageEntityField>(
  Object.entries(STORAGE_ENTITY_FIELD_TAG).map(([field, tag]) => [
    tag,
    field as StorageEntityField,
  ]),
);
