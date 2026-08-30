/**
 * Account frame proposal path. This module owns local mempool validation,
 * frame construction, and the hash manifest that Entity consensus certifies.
 */

import { peekAccountStateRoot } from '../../commitment/state-root';
import {
  preparedCommitCoversTxs,
  preparedCommitKey,
  preparedCommitLeavesPrivateStateUntouched,
  rememberPreparedProposalCommit,
} from './prepared-commit';
import type { AccountFrame, AccountOutput, AccountReplica, AccountTx } from '../../../types/account';
import type { ApplyAccountTxOk } from '../../tx/apply-types';
import type { AccountConsensusContext } from '../context';
import { removeCommittedTxsFromMempool } from '../../../protocol/state/tx-multiset';
import { getPerfMs } from '../../../support/time';
import { HEAVY_LOGS } from '../../../support/debug-flags';
import { createStructuredLogger, shortId } from '../../../support/logger';
import type { ProposeAccountFrameResult } from '../types';
import { proposeAccountFrameIdle } from '../result';
import { cumulativeMarksToPhases } from '../../../support/performance/profile';
import { isRuntimePerfProfileEnabled, readRuntimePerfSlowMs } from '../../../support/performance/runtime-flags';
import { validateProposalTransactions } from './transactions';
import { buildProposalFrame } from './frame';
import { prepareProposalProof } from './proof';
import { finalizeAccountProposal } from './finalize';
import { prepareProposalAdmission } from './admission';
import { traceHltSwapProposalOutcomes } from '../../../support/performance/account-delivery-trace';

const accountLog = createStructuredLogger('account');
const ACCOUNT_PROPOSAL_PROFILE =
  typeof process !== 'undefined' && process.env?.['XLN_ACCOUNT_PROPOSAL_PROFILE'] === '1';
const ACCOUNT_PROPOSAL_SLOW_MS = Math.max(
  0,
  Number(typeof process !== 'undefined' ? process.env?.['XLN_ACCOUNT_PROPOSAL_SLOW_MS'] || '250' : '250'),
);
const accountProposalProfileEnabled = (): boolean =>
  ACCOUNT_PROPOSAL_PROFILE || isRuntimePerfProfileEnabled('XLN_ACCOUNT_PROPOSAL_PROFILE');
const accountProposalSlowMs = (): number =>
  readRuntimePerfSlowMs('XLN_ACCOUNT_PROPOSAL_SLOW_MS', ACCOUNT_PROPOSAL_SLOW_MS);

type ProposalValidation = Awaited<ReturnType<typeof validateProposalTransactions>>;

const finishEmptyProposal = (
  account: AccountReplica,
  validation: ProposalValidation,
): ProposeAccountFrameResult | undefined => {
  if (validation.validTxs.length > 0) return undefined;
  const accountChanged = validation.txsToRemove.length > 0;
  if (accountChanged) {
    account.mempool = removeCommittedTxsFromMempool(account.mempool, validation.txsToRemove);
  }
  const result: ProposeAccountFrameResult = proposeAccountFrameIdle({
    message: validation.deferredTxCount > 0
      ? `Transactions deferred until signed settlement finalizes: ${validation.deferredTxCount}`
      : 'All transactions failed validation',
    events: validation.events,
    proposalDroppedTransactions: validation.droppedTransactions,
    ...(validation.failedHtlcLocks.length > 0
      ? { failedHtlcLocks: validation.failedHtlcLocks }
      : {}),
    ...(accountChanged ? { accountChanged: true as const } : {}),
  });
  return result;
};

const logProposalProfile = (
  proof: Awaited<ReturnType<typeof prepareProposalProof>> & { ok: true },
  frame: Awaited<ReturnType<typeof buildProposalFrame>> & { ok: true },
  counterparty: string,
  optimisticBatch: boolean,
  profileCheckpoints: Record<string, number>,
  profileStartMs: number,
): void => {
  const totalMs = Math.round(getPerfMs() - profileStartMs);
  if (!accountProposalProfileEnabled() && totalMs < accountProposalSlowMs()) return;
  accountLog.info('proposal.profile', {
    entity: shortId(proof.signingEntityId, 8),
    counterparty: shortId(counterparty, 8),
    height: frame.frame.height,
    txs: frame.frame.accountTxs.length,
    txTypes: Array.from(new Set(frame.frame.accountTxs.map(tx => tx.type))).sort(),
    optimisticBatch,
    totalMs,
    phases: cumulativeMarksToPhases(profileCheckpoints, totalMs),
    stateRoot: frame.stateRootTiming,
  });
};

const logProposalAdmission = (
  account: AccountReplica,
  proposalWindow: readonly AccountTx[],
): void => {
  if (!HEAVY_LOGS) return;
  accountLog.debug('proof.header', {
    from: shortId(account.proofHeader.fromEntity, 8),
    to: shortId(account.proofHeader.toEntity, 8),
  });
  accountLog.debug('mempool.before_process', {
    proposalWindow: proposalWindow.length,
    mempool: account.mempool.length,
    txs: proposalWindow.map(tx => tx.type),
  });
};

/** The proposer's own validated transition is reused at ACK when the live root still matches. */
const rememberProposalForAck = (
  account: AccountReplica,
  candidate: AccountReplica,
  newFrame: AccountFrame,
  validation: {
    candidateEffects: AccountOutput[];
    txResults: ApplyAccountTxOk[];
    timedOutHashlocks: string[];
    applyUs: number;
  },
): void => {
  if (!preparedCommitCoversTxs(newFrame.accountTxs)) return;
  if (!preparedCommitLeavesPrivateStateUntouched(account, candidate)) return;
  const baseRoot = peekAccountStateRoot(account.state);
  if (baseRoot === undefined) return;
  rememberPreparedProposalCommit(preparedCommitKey(account, newFrame.stateHash), {
    baseRoot,
    state: candidate.state,
    accountStateRoot: newFrame.accountStateRoot,
    candidateEffects: validation.candidateEffects,
    txResults: validation.txResults,
    timedOutHashlocks: validation.timedOutHashlocks,
    applyUs: validation.applyUs,
  });
};

const executeAuthoritativeProposal = async (
  context: AccountConsensusContext,
  account: AccountReplica,
  entityFrameTimestamp: number,
  entityJHeight: number | undefined,
  selectedMempoolTxs: readonly AccountTx[] | undefined,
): Promise<ProposeAccountFrameResult | null> => {
  const authorityScope = context.accountAuthorityExecutionScope;
  if (authorityScope === undefined) return null;
  const delegated = await authorityScope.executeAccountProposal({
    collectorFrameId: String(context.accountAuthorityFrameId ?? ''),
    account,
    timestamp: entityFrameTimestamp,
    jHeight: entityJHeight ?? account.state.lastFinalizedJHeight ?? 0,
    entityTimestamp: entityFrameTimestamp,
    finalizedJHeight: entityJHeight ?? account.state.lastFinalizedJHeight ?? 0,
    selectionIsWholeMempool: selectedMempoolTxs === undefined
      || selectedMempoolTxs.length === account.mempool.length,
  });
  if (delegated !== null) return delegated;
  await authorityScope.beforeTypeScriptAccountExecution(
    'proposeAccountFrame',
    account.proofHeader.toEntity,
  );
  return null;
};

export async function proposeAccountFrame(
  context: AccountConsensusContext,
  account: AccountReplica,
  entityFrameTimestamp: number,
  entityJHeight?: number, // Optional: J-height from entity state for HTLC consensus
  selectedMempoolTxs?: readonly AccountTx[],
): Promise<ProposeAccountFrameResult> {
  const delegated = await executeAuthoritativeProposal(
    context,
    account,
    entityFrameTimestamp,
    entityJHeight,
    selectedMempoolTxs,
  );
  if (delegated !== null) return delegated;
  const profileStartMs = getPerfMs();
  const profileCheckpoints: Record<string, number> = {};
  const checkpointProfile = (label: string): void => {
    profileCheckpoints[label] = Math.round(getPerfMs() - profileStartMs);
  };
  const admission = prepareProposalAdmission(
    {
      runtimeTimestamp: context.runtimeTimestamp,
      quietLogs: context.quietLogs,
    },
    account,
    entityFrameTimestamp,
    entityJHeight,
    selectedMempoolTxs,
  );
  if (!admission.ok) return admission.result;
  const {
    counterparty,
    events,
    proposalWindow,
    frameTimestamp,
    frameJHeight,
  } = admission;
  checkpointProfile('admission');
  logProposalAdmission(account, proposalWindow);
  const validation = await validateProposalTransactions({
    consensusContext: context,
    account: account,
    proposalWindow,
    frameTimestamp,
    frameJHeight,
    jClaimNodeStore: context.jClaimNodeStore,
  });
  traceHltSwapProposalOutcomes(proposalWindow, validation.droppedTransactions);

  const {
    clonedMachine,
    validTxs,
    validMempoolTxs,
    txsToRemove,
    optimisticBatch,
  } = validation;
  checkpointProfile('validateTxs');

  const emptyProposal = finishEmptyProposal(account, validation);
  if (emptyProposal) return emptyProposal;

  const frameBuild = await buildProposalFrame(
    account,
    clonedMachine,
    validTxs,
    frameTimestamp,
    frameJHeight,
    events,
    checkpointProfile,
    accountProposalProfileEnabled(),
  );
  if (!frameBuild.ok) return frameBuild.result;
  const { frame: newFrame } = frameBuild;
  rememberProposalForAck(account, clonedMachine, newFrame, validation);

  const proof = await prepareProposalProof(
    context,
    account,
    clonedMachine,
    events,
    checkpointProfile,
  );
  if (!proof.ok) return proof.result;
  const finalResult = finalizeAccountProposal(
    account,
    clonedMachine,
    newFrame,
    proof,
    counterparty,
    validMempoolTxs,
    txsToRemove,
    validation.droppedTransactions,
    validation,
    events,
    checkpointProfile,
  );
  logProposalProfile(proof, frameBuild, counterparty, optimisticBatch, profileCheckpoints, profileStartMs);
  return finalResult;
}
