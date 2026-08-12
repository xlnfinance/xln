import type { AccountReplica } from '../types/account';
import type { EntityReplica, EntityState } from '../entity/types';
import { cloneAccountReplica } from '../account/state/state-clone';
import { cloneEntityState } from '../entity/state-clone';
import {
  cloneCrossJurisdictionBookAdmission,
  cloneCrossJurisdictionAccountTxRoute,
  cloneCrossJurisdictionRoute,
} from '../extensions/cross-j/index';
import { encodeBuffer } from './codec';
import { DEFAULT_ACCOUNT_MERKLE_RADIX, normalizeEntityId } from './keys';
import { buildHexKeyedMerkle, type RadixMerkleRadix } from '../protocol/radix-merkle';
import type { StorageAccountDoc, StorageEntityCoreDoc, StorageReplicaMeta } from './types';

export {
  hydrateAccountDocFromStorage,
  hydrateEntityStateFromStorage,
} from './hydration';

const withProp = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

const publicCrossJurisdictionSwaps = (swaps: EntityState['crossJurisdictionSwaps']): EntityState['crossJurisdictionSwaps'] | undefined =>
  swaps ? new Map(Array.from(swaps.entries()).map(([id, route]) => [id, cloneCrossJurisdictionRoute(route)])) : undefined;

const publicCrossJurisdictionBookAdmissions = (
  admissions: EntityState['crossJurisdictionBookAdmissions'],
): EntityState['crossJurisdictionBookAdmissions'] | undefined =>
  admissions ? new Map(Array.from(admissions.entries()).map(([id, admission]) => [
    id,
    cloneCrossJurisdictionBookAdmission(admission),
  ])) : undefined;

const publicPendingCrossJurisdictionFillAcks = (
  pendingAcks: EntityState['pendingCrossJurisdictionFillAcks'],
): EntityState['pendingCrossJurisdictionFillAcks'] | undefined =>
  pendingAcks ? new Map(Array.from(pendingAcks.entries()).map(([id, pending]) => [
    id,
    {
      ...pending,
      tx: cloneCrossJurisdictionAccountTxRoute(pending.tx) as typeof pending.tx,
    },
  ])) : undefined;

export const projectEntityCoreDoc = (
  state: EntityState,
): StorageEntityCoreDoc => ({
  entityId: state.entityId,
  height: state.height,
  timestamp: state.timestamp,
  nonces: state.nonces,
  ...withProp('entityCommandNonces', state.entityCommandNonces),
  proposals: state.proposals,
  config: state.config,
  reserves: state.reserves,
  ...withProp('externalWallet', state.externalWallet),
  lastFinalizedJHeight: state.lastFinalizedJHeight,
  jBlockChain: state.jBlockChain,
  ...withProp('jHistoryFinality', state.jHistoryFinality),
  ...withProp('certifiedBoardState', state.certifiedBoardState),
  ...withProp('profileEncryptionManifest', state.profileEncryptionManifest),
  profile: state.profile,
  htlcRoutes: state.htlcRoutes,
  htlcFeesEarned: state.htlcFeesEarned,
  lockBook: state.lockBook,
  ...withProp('prevFrameHash', state.prevFrameHash),
  ...withProp('leaderState', state.leaderState),
  ...withProp('deferredAccountProposals', state.deferredAccountProposals),
  ...withProp('settlementContinuations', state.settlementContinuations),
  ...withProp('crontabState', state.crontabState),
  ...withProp('jBatchState', state.jBatchState),
  ...withProp('entityProviderActionState', state.entityProviderActionState),
  ...withProp('consumptionAccumulator', state.consumptionAccumulator),
  ...withProp('certifiedOutputSequences', state.certifiedOutputSequences),
  ...withProp('outDebtsByToken', state.outDebtsByToken),
  ...withProp('inDebtsByToken', state.inDebtsByToken),
  ...withProp('swapTradingPairs', state.swapTradingPairs),
  ...withProp('crossJurisdictionSwaps', publicCrossJurisdictionSwaps(state.crossJurisdictionSwaps)),
  ...withProp('crossJurisdictionAuthorizations', publicCrossJurisdictionSwaps(state.crossJurisdictionAuthorizations)),
  ...withProp('pendingCrossJurisdictionFillAcks', publicPendingCrossJurisdictionFillAcks(state.pendingCrossJurisdictionFillAcks)),
  ...withProp('crossJurisdictionBookAdmissions', publicCrossJurisdictionBookAdmissions(state.crossJurisdictionBookAdmissions)),
  ...withProp('hubRebalanceConfig', state.hubRebalanceConfig),
  ...withProp('orderbookHubProfile', state.orderbookExt?.hubProfile),
  ...withProp('orderbookReferrals', state.orderbookExt?.referrals),
  ...withProp('lending', state.lending),
});

export type EntityReplicaCoreViewDoc = StorageEntityCoreDoc & {
  signerId: string;
  isProposer: boolean;
  entityEncPubKey: string;
  htlcNotes?: EntityReplica['htlcNotes'];
};

/**
 * Live adapter view for one validator replica. This is deliberately separate
 * from projectEntityCoreDoc so validator-local identity can never enter the
 * shared storage document. Private encryption material is never projected.
 */
export const projectEntityReplicaCoreView = (
  state: EntityState,
  replica: Pick<EntityReplica, 'signerId' | 'isProposer' | 'entityEncPubKey' | 'htlcNotes'>,
): EntityReplicaCoreViewDoc => ({
  ...projectEntityCoreDoc(state),
  signerId: normalizeEntityId(replica.signerId),
  isProposer: replica.isProposer,
  entityEncPubKey: replica.entityEncPubKey,
  ...withProp('htlcNotes', replica.htlcNotes),
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
  entityEncPubKey: replica.entityEncPubKey,
  ...(!options?.omitState ? { state } : {}),
  ...withProp('htlcNotes', replica.htlcNotes),
  mempool,
  ...withProp('position', replica.position),
  ...withProp('proposal', replica.proposal),
  ...withProp('lockedFrame', replica.lockedFrame),
  ...withProp('candidate', replica.candidate),
  ...withProp(
    'certifiedFrameLineage',
    options ? options.certifiedFrameLineage : replica.certifiedFrameLineage,
  ),
  ...withProp(
    'certifiedFrameAnchor',
    options ? options.certifiedFrameAnchor : replica.certifiedFrameAnchor,
  ),
  ...withProp('hankoWitness', cloneHankoWitness(replica.hankoWitness)),
  ...withProp('leaderVotes', replica.leaderVotes),
  ...withProp('pendingLeaderCertificate', replica.pendingLeaderCertificate),
  ...withProp('lastConsensusProgressAt', replica.lastConsensusProgressAt),
  ...withProp('jHistory', replica.jHistory),
  ...withProp('jPrefixRound', replica.jPrefixRound),
  ...withProp('jSubmitState', replica.jSubmitState),
  ...withProp('entityProviderActionSubmitState', replica.entityProviderActionSubmitState),
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
