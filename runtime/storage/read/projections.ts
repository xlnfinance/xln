import type { AccountReplica } from '../../types/account';
import type { EntityReplica, EntityState } from '../../entity/types';
import { cloneAccountReplica } from '../../account/state/state-clone';
import { cloneEntityState } from '../../entity/state-clone';
import { encodeBuffer } from '../codec/codec';
import { DEFAULT_ACCOUNT_MERKLE_RADIX, normalizeEntityId } from '../keys';
import { buildHexKeyedMerkle, type RadixMerkleRadix } from '../../protocol/state/radix-merkle';
import type { StorageAccountDoc, StorageEntityCoreDoc, StorageReplicaMeta } from '../types';
import {
  cloneStoredCrossJurisdictionBookAdmissions,
  cloneStoredCrossJurisdictionRoutes,
  cloneStoredPendingCrossJurisdictionFillAcks,
  withDefinedProperty,
} from './entity-core-boundary';

export {
  hydrateAccountDocFromStorage,
  hydrateEntityStateFromStorage,
} from './hydration';

export const projectEntityCoreDoc = (
  state: EntityState,
): StorageEntityCoreDoc => ({
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
  jBlockChain: state.jBlockChain,
  ...withDefinedProperty('jHistoryFinality', state.jHistoryFinality),
  ...withDefinedProperty('certifiedBoardState', state.certifiedBoardState),
  profile: state.profile,
  htlcRoutes: state.htlcRoutes,
  htlcFeesEarned: state.htlcFeesEarned,
  lockBook: state.lockBook,
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
  ...withDefinedProperty('crossJurisdictionSwaps', cloneStoredCrossJurisdictionRoutes(state.crossJurisdictionSwaps)),
  ...withDefinedProperty('crossJurisdictionAuthorizations', cloneStoredCrossJurisdictionRoutes(state.crossJurisdictionAuthorizations)),
  ...withDefinedProperty('pendingCrossJurisdictionFillAcks', cloneStoredPendingCrossJurisdictionFillAcks(state.pendingCrossJurisdictionFillAcks)),
  ...withDefinedProperty('crossJurisdictionBookAdmissions', cloneStoredCrossJurisdictionBookAdmissions(state.crossJurisdictionBookAdmissions)),
  ...withDefinedProperty('hubRebalanceConfig', state.hubRebalanceConfig),
  ...withDefinedProperty('orderbookHubProfile', state.orderbookExt?.hubProfile),
  ...withDefinedProperty('orderbookReferrals', state.orderbookExt?.referrals),
  ...withDefinedProperty('orderbookPairDimensions', state.orderbookExt?.pairDimensions),
  ...withDefinedProperty('lending', state.lending),
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

const cloneHankoWitness = (hankoWitness?: EntityReplica['hankoWitness']): EntityReplica['hankoWitness'] | undefined => {
  if (!(hankoWitness instanceof Map) || hankoWitness.size === 0) return undefined;
  return new Map(
    Array.from(hankoWitness.entries()).map(([hash, entry]) => [
      String(hash),
      {
        hanko: entry.hanko,
        type: entry.type,
        entityHeight: entry.entityHeight,
        createdAt: entry.createdAt,
      },
    ]),
  );
};

type ReplicaMetaProjectionOptions = {
  certifiedFrameLineage?: EntityReplica['certifiedFrameLineage'];
  certifiedFrameAnchor?: EntityReplica['certifiedFrameAnchor'];
  omitState?: boolean;
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
  ...(!options?.omitState ? { state } : {}),
  ...withDefinedProperty('htlcNotes', replica.htlcNotes),
  mempool,
  ...withDefinedProperty('position', replica.position),
  ...withDefinedProperty('proposal', replica.proposal),
  ...withDefinedProperty('lockedFrame', replica.lockedFrame),
  ...withDefinedProperty('candidate', replica.candidate),
  ...withDefinedProperty(
    'certifiedFrameLineage',
    options ? options.certifiedFrameLineage : replica.certifiedFrameLineage,
  ),
  ...withDefinedProperty(
    'certifiedFrameAnchor',
    options ? options.certifiedFrameAnchor : replica.certifiedFrameAnchor,
  ),
  ...withDefinedProperty('hankoWitness', cloneHankoWitness(replica.hankoWitness)),
  ...withDefinedProperty('leaderVotes', replica.leaderVotes),
  ...withDefinedProperty('pendingLeaderCertificate', replica.pendingLeaderCertificate),
  ...withDefinedProperty('lastConsensusProgressAt', replica.lastConsensusProgressAt),
  ...withDefinedProperty('jHistory', replica.jHistory),
  ...withDefinedProperty('jPrefixRound', replica.jPrefixRound),
  ...withDefinedProperty('jSubmitState', replica.jSubmitState),
  ...withDefinedProperty('entityProviderActionSubmitState', replica.entityProviderActionSubmitState),
});

export const projectReplicaMeta = (
  replica: EntityReplica,
  options?: ReplicaMetaProjectionOptions,
): StorageReplicaMeta => buildReplicaMetaProjection(
  replica,
  // Snapshot now. Replica states continue mutating after projection.
  cloneEntityState(replica.state, true),
  structuredClone(replica.mempool),
  options,
);

/**
 * Encode the authoritative replica metadata synchronously without first making
 * a redundant full structuredClone. encodeBuffer canonicalizes into an
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
  cloneAccountReplica(account, true);

export const buildAccountMerkleFromState = (
  accounts: ReadonlyMap<string, AccountReplica>,
  radix: RadixMerkleRadix = DEFAULT_ACCOUNT_MERKLE_RADIX,
) => {
  return buildHexKeyedMerkle(
    Array.from(accounts.entries()).map(([counterpartyId, account]) => ({
      hexKey: counterpartyId,
      value: encodeBuffer(projectAccountDoc(account)),
    })),
    { radix },
  );
};
