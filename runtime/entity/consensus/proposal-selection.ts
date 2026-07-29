import {
  buildCertifiedJPrefixTx,
  buildJPrefixCertificate,
  entityRequiresJPrefixCertificate,
  hasPendingLocalJEvent,
  isFrozenBaseJPrefixRollAuthorized,
} from '../../jurisdiction/j-prefix-consensus';
import { nodeProcess } from '../../infra/runtime-process';
import type { EntityReplica, EntityTx, RuntimeState } from '../../types';
import { hasProposableAccount } from './account-work-index';
import { prioritizeScheduledWakeTransactions } from './input-merge';
import { getReplicaProposalLeader } from './leader';
import {
  entityLog,
  isSingleSignerEntity,
  selectProposableEntityTxs,
} from './shared';

export type EntityProposalSelection = {
  hasProposableAccountMempool: boolean;
  isSingleSigner: boolean;
  proposalJPrefixCertificate: ReturnType<typeof buildJPrefixCertificate>;
  proposalSelection: Awaited<ReturnType<typeof selectProposableEntityTxs>>;
  proposalTxs: EntityTx[];
  shouldRollFrozenBaseJPrefixRound: boolean;
};

export type EntityProposalSelectionOptions = {
  localCanPropose: boolean;
  trustedLocalCrossJurisdiction: boolean;
  trustedLocalEntityTxs: EntityTx[];
  checkpoint(label: string): void;
};

const addCertifiedJRange = (
  env: RuntimeState,
  replica: EntityReplica,
  trustedLocalCrossJurisdiction: boolean,
  certificate: NonNullable<ReturnType<typeof buildJPrefixCertificate>>,
): Extract<EntityTx, { type: 'j_event' }> | null => {
  if (!replica.jPrefixRound) return null;
  replica.jPrefixRound.certificate = certificate;
  if (certificate.selected.scannedThroughHeight <= replica.state.lastFinalizedJHeight) {
    return null;
  }
  const certifiedRange = buildCertifiedJPrefixTx(
    env,
    replica,
    certificate,
    getReplicaProposalLeader(replica).activeValidatorId,
  );
  if (!trustedLocalCrossJurisdiction) {
    replica.mempool = prioritizeScheduledWakeTransactions([
      certifiedRange,
      ...replica.mempool.filter(tx => tx.type !== 'j_event'),
    ]);
  }
  return certifiedRange;
};

export const selectEntityProposal = async (
  env: RuntimeState,
  replica: EntityReplica,
  options: EntityProposalSelectionOptions,
): Promise<EntityProposalSelection> => {
  const hasProposableAccountMempool = hasProposableAccount(replica.state);
  const proposalJPrefixCertificate =
    options.localCanPropose && replica.jPrefixRound
      ? buildJPrefixCertificate(replica.state, replica.jPrefixRound.attestations)
      : null;
  const certifiedJRange = proposalJPrefixCertificate
    ? addCertifiedJRange(
        env,
        replica,
        options.trustedLocalCrossJurisdiction,
        proposalJPrefixCertificate,
      )
    : null;
  const jPrefixProposalBlocked =
    options.localCanPropose &&
    !proposalJPrefixCertificate &&
    (entityRequiresJPrefixCertificate(replica.state) ||
      hasPendingLocalJEvent(replica.state, replica.jHistory));
  const shouldRollFrozenBaseJPrefixRound = isFrozenBaseJPrefixRollAuthorized(
    replica,
    proposalJPrefixCertificate,
  );
  const trustedProposalTxs = certifiedJRange
    ? [certifiedJRange, ...options.trustedLocalEntityTxs]
    : options.trustedLocalEntityTxs;
  const proposalSelection =
    options.localCanPropose && !jPrefixProposalBlocked
      ? await selectProposableEntityTxs(
          env,
          replica.state,
          options.trustedLocalCrossJurisdiction ? trustedProposalTxs : replica.mempool,
        )
      : {
          txs: [],
          currentAuthorityReady: false,
          ...(jPrefixProposalBlocked ? { reason: 'J_PREFIX_QUORUM_REQUIRED' } : {}),
        };
  options.checkpoint('selection');

  // A frozen-base roll may only open the next J-prefix round. Mixing ordinary
  // work into it would advance Entity state past an honest observed J event.
  const proposalTxs = shouldRollFrozenBaseJPrefixRound ? [] : proposalSelection.txs;
  if (nodeProcess?.env?.['XLN_STORAGE_DEBUG_REPLICA_META'] === '1') {
    entityLog.info('replica_meta.selection_debug', {
      entityId: replica.entityId,
      entityHeight: replica.state.height,
      runtimeHeight: env.height,
      mempool: replica.mempool.map(tx => tx.type),
      selected: proposalTxs.map(tx => tx.type),
      reason: proposalSelection.reason ?? null,
    });
  }
  if (
    options.trustedLocalCrossJurisdiction &&
    proposalTxs.length !== trustedProposalTxs.length
  ) {
    throw new Error(
      `CROSS_J_LOCAL_COMMAND_PARTIAL_FRAME_FORBIDDEN:${replica.entityId}:` +
        `selected=${proposalTxs.length}:required=${trustedProposalTxs.length}`,
    );
  }
  if (proposalSelection.reason) {
    entityLog.debug('proposal.authority_gate', {
      reason: proposalSelection.reason,
      selected: proposalTxs.map(tx => tx.type),
      pending: replica.mempool.map(tx => tx.type),
    });
  }
  return {
    hasProposableAccountMempool,
    isSingleSigner: isSingleSignerEntity(replica.state),
    proposalJPrefixCertificate,
    proposalSelection,
    proposalTxs,
    shouldRollFrozenBaseJPrefixRound,
  };
};
