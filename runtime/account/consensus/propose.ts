/**
 * Account frame proposal path. This module owns local mempool validation,
 * frame construction, and the hash manifest that Entity consensus certifies.
 */

import type { AccountState, AccountTx, RuntimeState } from '../../types';
import { removeCommittedTxsFromMempool } from '../../state-helpers';
import { getPerfMs, HEAVY_LOGS } from '../../utils';
import { createStructuredLogger, shortId } from '../../infra/logger';
import type { ProposeAccountFrameResult } from './types';
import type { AccountJClaimNodeStore } from '../../types/account-j-claims';
import { cumulativeMarksToPhases } from '../../infra/perf-profile';
import { isRuntimePerfProfileEnabled, readRuntimePerfSlowMs } from '../../infra/perf-runtime-flags';
import { validateProposalTransactions } from './proposal-transactions';
import { buildProposalFrame } from './proposal-frame';
import { prepareProposalProof } from './proposal-proof';
import { finalizeAccountProposal } from './proposal-finalize';
import { prepareProposalAdmission } from './proposal-admission';

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
  account: AccountState,
  validation: ProposalValidation,
): ProposeAccountFrameResult | undefined => {
  if (validation.validTxs.length > 0) return undefined;
  const accountChanged = validation.txsToRemove.length > 0;
  if (accountChanged) {
    account.mempool = removeCommittedTxsFromMempool(account.mempool, validation.txsToRemove);
  }
  const result: ProposeAccountFrameResult = {
    success: false,
    error: validation.deferredTxCount > 0
      ? `Transactions deferred until signed settlement finalizes: ${validation.deferredTxCount}`
      : 'All transactions failed validation',
    events: validation.events,
    ...(validation.failedHtlcLocks.length > 0
      ? { failedHtlcLocks: validation.failedHtlcLocks }
      : {}),
    ...(accountChanged ? { accountChanged: true } : {}),
  };
  return result;
};

const logProposalProfile = (
  proof: Awaited<ReturnType<typeof prepareProposalProof>> & { success: true },
  frame: Awaited<ReturnType<typeof buildProposalFrame>> & { success: true },
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
  account: AccountState,
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
  env: RuntimeState,
  account: AccountState,
  entityFrameTimestamp: number,
  entityJHeight?: number, // Optional: J-height from entity state for HTLC consensus
  accountJClaimNodeStore?: AccountJClaimNodeStore,
  selectedMempoolTxs?: readonly AccountTx[],
): Promise<ProposeAccountFrameResult> {
  const profileStartMs = getPerfMs();
  const profileCheckpoints: Record<string, number> = {};
  const checkpointProfile = (label: string): void => {
    profileCheckpoints[label] = Math.round(getPerfMs() - profileStartMs);
  };
  const admission = prepareProposalAdmission(
    env,
    account,
    entityFrameTimestamp,
    entityJHeight,
    selectedMempoolTxs,
  );
  if (!admission.success) return admission.result;
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
    env,
    account: account,
    proposalWindow,
    frameTimestamp,
    frameJHeight,
    ...(accountJClaimNodeStore ? { jClaimNodeStore: accountJClaimNodeStore } : {}),
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
  if (!frameBuild.success) return frameBuild.result;
  const { frame: newFrame } = frameBuild;

  const proof = await prepareProposalProof(
    env,
    account,
    clonedMachine,
    events,
    checkpointProfile,
  );
  if (!proof.success) return proof.result;
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
