/**
 * Account frame proposal path. This module owns local mempool validation,
 * frame construction, and the hash manifest that Entity consensus certifies.
 */

import type { AccountReplica, AccountTx } from '../../../types/account';
import type { AccountConsensusContext } from '../context';
import { removeCommittedTxsFromMempool } from '../../../protocol/state/tx-multiset';
import { getPerfMs } from '../../../infra/time';
import { HEAVY_LOGS } from '../../../infra/debug-flags';
import { createStructuredLogger, shortId } from '../../../infra/logger';
import type { ProposeAccountFrameResult } from '../types';
import { proposeAccountFrameIdle } from '../result';
import { cumulativeMarksToPhases } from '../../../infra/performance/profile';
import { isRuntimePerfProfileEnabled, readRuntimePerfSlowMs } from '../../../infra/performance/runtime-flags';
import { validateProposalTransactions } from './transactions';
import { buildProposalFrame } from './frame';
import { prepareProposalProof } from './proof';
import { finalizeAccountProposal } from './finalize';
import { prepareProposalAdmission } from './admission';

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

export async function proposeAccountFrame(
  context: AccountConsensusContext,
  account: AccountReplica,
  entityFrameTimestamp: number,
  entityJHeight?: number, // Optional: J-height from entity state for HTLC consensus
  selectedMempoolTxs?: readonly AccountTx[],
): Promise<ProposeAccountFrameResult> {
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
  );
  if (!frameBuild.ok) return frameBuild.result;
  const { frame: newFrame } = frameBuild;

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
    validation,
    events,
    checkpointProfile,
  );
  // Timing is operational telemetry and never affects proposal validity.
  logProposalProfile(
    proof,
    frameBuild,
    counterparty,
    optimisticBatch,
    profileCheckpoints,
    profileStartMs,
  );
  return finalResult;
}
