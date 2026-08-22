import { haltRuntimeFailure } from "../../../protocol/errors/failure-taxonomy";

import {
  buildCertifiedJPrefixTx,
  buildJPrefixCertificate,
  entityRequiresJPrefixCertificate,
  hasPendingLocalJEvent,
  isFrozenBaseJPrefixRollAuthorized,
} from '../../../jurisdiction/machine/history/j-prefix-consensus';
import { nodeProcess } from '../../../support/process/runtime-process';
import type { EntityReplica } from '../../types';
import type { EntityRuntimeContext } from '../../runtime-context';
import type { EntityTx } from '../../../types/entity-tx';
import { hasProposableAccount } from '../account/work-index';
import { prioritizeScheduledWakeTransactions } from '../input/merge';
import { getReplicaProposalLeader } from '../leader';
import { entityLog } from '../entity-log';
import { isSingleSignerEntity } from '../replica-validation';
import { selectProposableEntityTxs } from './policy';
import {
  getPendingBoardHandoverConfig,
  withBoardAuthority,
} from '../authority/board-handover';

export type EntityProposalSelection = {
  accountWorkOnly: boolean;
  hasProposableAccountMempool: boolean;
  isSingleSigner: boolean;
  proposalJPrefixCertificate: ReturnType<typeof buildJPrefixCertificate>;
  proposalSelection: Awaited<ReturnType<typeof selectProposableEntityTxs>>;
  proposalTxs: EntityTx[];
  requiredTxPrefixCount?: number;
  shouldRollFrozenBaseJPrefixRound: boolean;
};

export type EntityProposalSelectionOptions = {
  localCanPropose: boolean;
  trustedLocalCrossJurisdiction: boolean;
  trustedLocalEntityTxs: EntityTx[];
  accountWorkOnly: boolean;
  /** Runtime-authenticated atomic AccountInput that this staged frame must evaluate. */
  requiredEntityTx?: EntityTx;
  checkpoint(label: string): void;
};

const addCertifiedJRange = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  authorityReplica: EntityReplica,
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
    authorityReplica,
    certificate,
    getReplicaProposalLeader(authorityReplica).activeValidatorId,
  );
  if (!trustedLocalCrossJurisdiction) {
    replica.mempool = prioritizeScheduledWakeTransactions([
      certifiedRange,
      ...replica.mempool.filter(tx => tx.type !== 'j_event'),
    ]);
  }
  return certifiedRange;
};

const logReplicaMetaSelection = (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  proposalTxs: readonly EntityTx[],
  requiredTxIndex: number,
  reason: string | undefined,
): void => {
  if (nodeProcess?.env?.['XLN_STORAGE_DEBUG_REPLICA_META'] !== '1') return;
  entityLog.info('replica_meta.selection_debug', {
    entityId: replica.entityId,
    entityHeight: replica.state.height,
    runtimeHeight: env.state.height,
    mempool: replica.mempool.map(tx => tx.type),
    selected: proposalTxs.map(tx => tx.type),
    requiredTxPrefixCount: requiredTxIndex >= 0 ? requiredTxIndex + 1 : 0,
    reason: reason ?? null,
  });
};

export const selectEntityProposal = async (
  env: EntityRuntimeContext,
  replica: EntityReplica,
  options: EntityProposalSelectionOptions,
): Promise<EntityProposalSelection> => {
  const pendingConfig = getPendingBoardHandoverConfig(replica.state, replica.mempool);
  const authorityReplica = pendingConfig
    ? { ...replica, state: withBoardAuthority(replica.state, pendingConfig) }
    : replica;
  const hasProposableAccountMempool = hasProposableAccount(replica.state);
  const proposalJPrefixCertificate =
    options.localCanPropose && replica.jPrefixRound
      ? buildJPrefixCertificate(authorityReplica.state, replica.jPrefixRound.attestations)
      : null;
  const certifiedJRange = proposalJPrefixCertificate
    ? addCertifiedJRange(
        env,
        replica,
        authorityReplica,
        options.trustedLocalCrossJurisdiction,
        proposalJPrefixCertificate,
      )
    : null;
  const jPrefixProposalBlocked =
    options.localCanPropose &&
    !proposalJPrefixCertificate &&
    (entityRequiresJPrefixCertificate(authorityReplica.state) ||
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
          options.accountWorkOnly
            ? []
            : options.trustedLocalCrossJurisdiction
              ? trustedProposalTxs
              : replica.mempool,
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
  const requiredTxIndex = options.requiredEntityTx
    ? proposalTxs.indexOf(options.requiredEntityTx)
    : -1;
  if (options.requiredEntityTx && requiredTxIndex < 0) {
    throw haltRuntimeFailure(
      'RUNTIME_CROSS_J_ATOMIC_ACCOUNT_INPUT_NOT_SELECTED',
      `RUNTIME_CROSS_J_ATOMIC_ACCOUNT_INPUT_NOT_SELECTED:${replica.entityId}:` +
        `mempool=${replica.mempool.length}:selected=${proposalTxs.length}:` +
        `reason=${proposalSelection.reason ?? 'none'}`,
    );
  }
  logReplicaMetaSelection(env, replica, proposalTxs, requiredTxIndex, proposalSelection.reason);
  if (
    options.trustedLocalCrossJurisdiction &&
    proposalTxs.length !== trustedProposalTxs.length
  ) {
    throw haltRuntimeFailure("CROSS_J_LOCAL_COMMAND_PARTIAL_FRAME_FORBIDDEN", `CROSS_J_LOCAL_COMMAND_PARTIAL_FRAME_FORBIDDEN:${replica.entityId}:` +
        `selected=${proposalTxs.length}:required=${trustedProposalTxs.length}`);
  }
  if (proposalSelection.reason) {
    entityLog.debug('proposal.authority_gate', {
      reason: proposalSelection.reason,
      selected: proposalTxs.map(tx => tx.type),
      pending: replica.mempool.map(tx => tx.type),
    });
  }
  return {
    accountWorkOnly: options.accountWorkOnly,
    hasProposableAccountMempool,
    isSingleSigner: isSingleSignerEntity(authorityReplica.state),
    proposalJPrefixCertificate,
    proposalSelection,
    proposalTxs,
    ...(requiredTxIndex >= 0
      ? { requiredTxPrefixCount: requiredTxIndex + 1 }
      : {}),
    shouldRollFrozenBaseJPrefixRound,
  };
};

/**
 * Internal Account-work is a causal retry, not a timer frame. If the sibling
 * cross-j registration is not committed yet, the isolated preview creates no
 * Account proposal and must be discarded without advancing Entity height or
 * writing an empty frame to WAL. A later committed sibling registration is the
 * only event allowed to trigger another attempt.
 */
export const shouldKeepPreparedEntityFrame = (
  selection: Pick<
    EntityProposalSelection,
    'accountWorkOnly' | 'proposalTxs' | 'shouldRollFrozenBaseJPrefixRound'
  >,
  accountsToProposeFramesCount: number,
): boolean =>
  !selection.accountWorkOnly ||
  selection.proposalTxs.length > 0 ||
  selection.shouldRollFrozenBaseJPrefixRound ||
  accountsToProposeFramesCount > 0;
