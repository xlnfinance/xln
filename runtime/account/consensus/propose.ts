/**
 * Account frame proposal path. This module owns local mempool validation,
 * frame construction, frame hanko signing, and dispute-proof signing.
 */

import type { AccountMachine, AccountTx, Env } from '../../types';
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

export async function proposeAccountFrame(
  env: Env,
  accountMachine: AccountMachine,
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
    accountMachine,
    entityFrameTimestamp,
    entityJHeight,
    selectedMempoolTxs,
  );
  if (!admission.success) return admission.result;
  const {
    counterparty,
    quiet,
    events,
    proposalWindow,
    frameTimestamp,
    frameJHeight,
  } = admission;
  checkpointProfile('admission');
  if (HEAVY_LOGS) {
    accountLog.debug('proof.header', {
      from: shortId(accountMachine.proofHeader.fromEntity, 8),
      to: shortId(accountMachine.proofHeader.toEntity, 8),
    });
  }

  if (HEAVY_LOGS) {
    accountLog.debug('mempool.before_process', {
      proposalWindow: proposalWindow.length,
      mempool: accountMachine.mempool.length,
      txs: proposalWindow.map(tx => tx.type),
    });
  }
  const validation = await validateProposalTransactions({
    env,
    account: accountMachine,
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
    deferredTxCount,
    events: validationEvents,
    failedHtlcLocks,
    optimisticBatch,
  } = validation;
  checkpointProfile('validateTxs');

  const accountChangedBeforeProposal = txsToRemove.length > 0;

  if (validTxs.length === 0) {
    if (accountChangedBeforeProposal) {
      accountMachine.mempool = removeCommittedTxsFromMempool(accountMachine.mempool, txsToRemove);
    }
    const earlyResult: {
      success: false;
      error: string;
      events: string[];
      failedHtlcLocks?: Array<{ hashlock: string; reason: string }>;
    } = {
      success: false,
      error:
        deferredTxCount > 0
          ? `Transactions deferred until signed settlement finalizes: ${deferredTxCount}`
          : 'All transactions failed validation',
      events: validationEvents,
    };
    if (failedHtlcLocks.length > 0) earlyResult.failedHtlcLocks = failedHtlcLocks;
    return accountChangedBeforeProposal ? { ...earlyResult, accountChanged: true } : earlyResult;
  }

  const frameBuild = await buildProposalFrame(
    accountMachine,
    clonedMachine,
    validTxs,
    frameTimestamp,
    frameJHeight,
    events,
    checkpointProfile,
  );
  if (!frameBuild.success) return frameBuild.result;
  const { frame: newFrame, stateRootTiming } = frameBuild;

  const proof = await prepareProposalProof(
    env,
    accountMachine,
    clonedMachine,
    newFrame,
    events,
    quiet,
    checkpointProfile,
  );
  if (!proof.success) return proof.result;
  const finalResult = finalizeAccountProposal(
    accountMachine,
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
  const profileTotalMs = Math.round(getPerfMs() - profileStartMs);
  if (accountProposalProfileEnabled() || profileTotalMs >= accountProposalSlowMs()) {
    const profile = {
      entity: shortId(proof.signingEntityId, 8),
      counterparty: shortId(counterparty, 8),
      height: newFrame.height,
      txs: newFrame.accountTxs.length,
      txTypes: Array.from(new Set(newFrame.accountTxs.map(tx => tx.type))).sort(),
      optimisticBatch,
      totalMs: profileTotalMs,
      phases: cumulativeMarksToPhases(profileCheckpoints, profileTotalMs),
      stateRoot: stateRootTiming,
    };
    // Timing is operational telemetry, not a correctness warning.
    accountLog.info('proposal.profile', profile);
  }
  return finalResult;
}
