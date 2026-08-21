import type { AccountReplica } from '../../types/account';
import type { EntityReplica, EntityState } from '../../entity/types';
import { encodeBuffer } from '../codec/codec';
import { normalizeEntityId } from '../keys';
import type { StorageAccountDoc, StorageEntityCoreDoc, StorageReplicaMeta } from '../types';
import {
  withDefinedProperty,
} from './entity-core-boundary';
import { pruneFinalizedValidatorJHistory } from '../../jurisdiction/machine/local-history';
import { cloneCrossJurisdictionRoute } from '../../extensions/cross-j';

export {
  hydrateAccountDocFromStorage,
  hydrateEntityStateFromStorage,
} from './hydration';

/** Storage codecs accept boundary-native maps, never live overlay containers. */
const projectStorageMap = <Key, Value>(source: ReadonlyMap<Key, Value>): Map<Key, Value> =>
  new Map(source.entries());

const projectCrossJurisdictionRoutes = (
  source: ReadonlyMap<string, import('../../types/cross-jurisdiction').CrossJurisdictionSwapRoute>,
): Map<string, import('../../types/cross-jurisdiction').CrossJurisdictionSwapRoute> =>
  new Map([...source].map(([orderId, route]) => [orderId, cloneCrossJurisdictionRoute(route)]));

export type EntityStorageTreeField =
  | 'htlcRoutes'
  | 'lockBook'
  | 'crossJurisdictionSwaps'
  | 'crossJurisdictionAuthorizations'
  | 'pendingCrossJurisdictionFillAcks'
  | 'crossJurisdictionBookAdmissions';

export type StorageEntityScalarDoc = Omit<StorageEntityCoreDoc, EntityStorageTreeField>;

/**
 * Static Entity envelope only. Growing collections are the authoritative RAM
 * Patricia roots and are projected separately by the storage graph codec.
 */
export const projectEntityScalarDoc = (state: EntityState): StorageEntityScalarDoc => ({
  entityId: state.entityId,
  height: state.height,
  timestamp: state.timestamp,
  nonces: state.nonces,
  ...withDefinedProperty('entityCommandNonces', state.entityCommandNonces),
  proposals: state.proposals,
  config: state.config,
  entityEncryptionPublicKey: state.entityEncryptionPublicKey,
  reserves: state.reserves,
  ...withDefinedProperty('externalWallet', state.externalWallet),
  lastFinalizedJHeight: state.lastFinalizedJHeight,
  ...withDefinedProperty('jHistoryFinality', state.jHistoryFinality),
  ...withDefinedProperty('certifiedBoardState', state.certifiedBoardState),
  profile: state.profile,
  htlcFeesEarned: state.htlcFeesEarned,
  ...withDefinedProperty('prevFrameHash', state.prevFrameHash),
  ...withDefinedProperty('leaderState', state.leaderState),
  ...withDefinedProperty('deferredAccountProposals', state.deferredAccountProposals),
  ...withDefinedProperty('settlementContinuations', state.settlementContinuations),
  ...withDefinedProperty('crontabState', state.crontabState),
  ...withDefinedProperty('jBatchState', state.jBatchState),
  ...withDefinedProperty('entityProviderActionState', state.entityProviderActionState),
  ...withDefinedProperty('consumptionAccumulator', state.consumptionAccumulator),
  ...withDefinedProperty('certifiedOutputSequences', state.certifiedOutputSequences),
  ...withDefinedProperty('outDebtsByToken', state.outDebtsByToken),
  ...withDefinedProperty('inDebtsByToken', state.inDebtsByToken),
  ...withDefinedProperty('swapTradingPairs', state.swapTradingPairs),
  ...withDefinedProperty('hubRebalanceConfig', state.hubRebalanceConfig),
  ...withDefinedProperty('orderbookHubProfile', state.orderbookExt?.hubProfile),
  ...withDefinedProperty(
    'orderbookReferrals',
    state.orderbookExt && projectStorageMap(state.orderbookExt.referrals),
  ),
  ...withDefinedProperty(
    'orderbookPairDimensions',
    state.orderbookExt && projectStorageMap(state.orderbookExt.pairDimensions),
  ),
  ...withDefinedProperty('lending', state.lending),
});

export const projectEntityCoreDoc = (
  state: EntityState,
): StorageEntityCoreDoc => ({
  ...projectEntityScalarDoc(state),
  htlcRoutes: projectStorageMap(state.htlcRoutes),
  lockBook: projectStorageMap(state.lockBook),
  ...withDefinedProperty(
    'crossJurisdictionSwaps',
    state.crossJurisdictionSwaps && projectCrossJurisdictionRoutes(state.crossJurisdictionSwaps),
  ),
  ...withDefinedProperty(
    'crossJurisdictionAuthorizations',
    state.crossJurisdictionAuthorizations && projectCrossJurisdictionRoutes(state.crossJurisdictionAuthorizations),
  ),
  ...withDefinedProperty(
    'pendingCrossJurisdictionFillAcks',
    state.pendingCrossJurisdictionFillAcks && projectStorageMap(state.pendingCrossJurisdictionFillAcks),
  ),
  ...withDefinedProperty(
    'crossJurisdictionBookAdmissions',
    state.crossJurisdictionBookAdmissions && projectStorageMap(state.crossJurisdictionBookAdmissions),
  ),
});

export type EntityReplicaCoreViewDoc = StorageEntityCoreDoc & {
  signerId: string;
  isProposer: boolean;
  htlcNotes?: EntityReplica['htlcNotes'];
};

/**
 * Live adapter view for one validator replica. This is deliberately separate
 * from projectEntityCoreDoc so validator-local identity can never enter the
 * shared storage document. Private encryption material is never projected.
 */
export const projectEntityReplicaCoreView = (
  state: EntityState,
  replica: Pick<EntityReplica, 'signerId' | 'isProposer' | 'htlcNotes'>,
): EntityReplicaCoreViewDoc => ({
  ...projectEntityCoreDoc(state),
  signerId: normalizeEntityId(replica.signerId),
  isProposer: replica.isProposer,
  ...withDefinedProperty('htlcNotes', replica.htlcNotes),
});

type ReplicaMetaProjectionOptions = {
  certifiedFrameHead?: EntityReplica['certifiedFrameHead'];
  certifiedFrameAnchor?: EntityReplica['certifiedFrameAnchor'];
};

const buildReplicaMetaProjection = (
  replica: EntityReplica,
  state: EntityState,
  mempool: EntityReplica['mempool'],
  options?: ReplicaMetaProjectionOptions,
): StorageReplicaMeta => ({
  entityId: normalizeEntityId(replica.entityId),
  signerId: normalizeEntityId(replica.signerId),
  isProposer: replica.isProposer,
  ...withDefinedProperty('htlcNotes', replica.htlcNotes),
  mempool,
  ...withDefinedProperty('position', replica.position),
  ...withDefinedProperty('proposal', replica.proposal),
  ...withDefinedProperty('lockedFrame', replica.lockedFrame),
  ...withDefinedProperty('candidate', replica.candidate),
  ...withDefinedProperty(
    'certifiedFrameHead',
    options ? options.certifiedFrameHead : replica.certifiedFrameHead,
  ),
  ...withDefinedProperty(
    'certifiedFrameAnchor',
    options ? options.certifiedFrameAnchor : replica.certifiedFrameAnchor,
  ),
  ...withDefinedProperty('hankoWitness', replica.hankoWitness),
  ...withDefinedProperty('leaderVotes', replica.leaderVotes),
  ...withDefinedProperty('pendingLeaderCertificate', replica.pendingLeaderCertificate),
  ...withDefinedProperty('lastConsensusProgressAt', replica.lastConsensusProgressAt),
  ...withDefinedProperty(
    'jHistory',
    pruneFinalizedValidatorJHistory(replica.jHistory, state.lastFinalizedJHeight),
  ),
  ...withDefinedProperty('jPrefixRound', replica.jPrefixRound),
  ...withDefinedProperty('jSubmitState', replica.jSubmitState),
  ...withDefinedProperty('entityProviderActionSubmitState', replica.entityProviderActionSubmitState),
});

export const projectReplicaMeta = (
  replica: EntityReplica,
  options?: ReplicaMetaProjectionOptions,
): StorageReplicaMeta => buildReplicaMetaProjection(
  replica,
  // Entity committed state is persistent: frame candidates write overlays and
  // publication replaces the root instead of mutating this value. The encoder
  // below consumes this view synchronously, so copying the unbounded Entity
  // graph would add no isolation and would make checkpoint cost O(Entity).
  replica.state,
  replica.mempool,
  options,
);

/**
 * Encode the authoritative replica metadata synchronously from its persistent
 * field view. encodeBuffer canonicalizes into an
 * isolated tree before returning, so live references cannot escape this call.
 */
export const encodeReplicaMeta = (
  replica: EntityReplica,
  options?: ReplicaMetaProjectionOptions,
): Buffer => encodeBuffer(buildReplicaMetaProjection(
  replica,
  replica.state,
  replica.mempool,
  options,
), { omitSymbolKeys: true });

export const projectAccountDoc = (account: AccountReplica): StorageAccountDoc =>
  account;
