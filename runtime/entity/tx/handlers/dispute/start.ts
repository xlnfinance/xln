import type { AccountReplica, RuntimeOverlayRecord } from '../../../../types/account';
import type { EntityInput, EntityState } from '../../../types';
import type { EntityRuntimeContext } from '../../../runtime-context';
import type { EntityTx } from '../../../../types/entity-tx';
import { prepareEntityTxState } from '../../../state-clone';
import { addMessage } from '../../../frame-events';
import {
  encodeJBatch,
  batchOpCount,
  J_BATCH_CONTRACT_LIMITS,
} from '../../../../jurisdiction/machine/batch';
import { shortHash, shortId } from '../../../../infra/logger';
import {
  freezeAccountForDispute,
  isDisputeStartedByLeft,
} from '../../../../account/consensus/dispute/policy';
import { disputeLog } from './shared';
import {
  admitDisputeStart,
  assertCrossJurisdictionDisputeProofHasPulls,
  proofBodyHasPulls,
  validateCrossJurisdictionDisputeRoute,
} from './start-admission';
import {
  buildStarterArguments,
  loadStartProof,
  resolveStartNonce,
  type StartEvidence,
} from './start-evidence';
import { verifyStartHanko } from './start-hanko';
import { requireAccountDeltaTransformerAddress } from '../../../../account/consensus/helpers';
import {
  flushDeferredHashLadderReveals,
  queueSourceHubClaimRegistrationsForAccount,
} from '../../j-events-htlc';

type StartTx = Extract<EntityTx, { type: 'disputeStart' }>;

const queuePullDisputeRegistrations = (
  state: EntityState,
  tx: StartTx,
  evidence: StartEvidence,
  outputs: EntityInput[],
  runtimeSeed: string | undefined,
  canonicalDeltaTransformerAddress: string,
): void => {
  flushDeferredHashLadderReveals(state, tx.data.counterpartyEntityId);
  const sourceClaims = queueSourceHubClaimRegistrationsForAccount(
    state,
    tx.data.counterpartyEntityId,
    runtimeSeed,
    evidence.initialProofbody,
    canonicalDeltaTransformerAddress,
  );
  for (const sourceClaim of sourceClaims) {
    if (sourceClaim.result === 'source-window-expired') {
      throw new Error(`DISPUTE_START_SOURCE_CLAIM_WINDOW_IMPOSSIBLE:${sourceClaim.routeId}`);
    }
    if (sourceClaim.result === 'already-queued') continue;
    if (sourceClaim.result === 'deferred-batch-pending' && !state.jBatchState!.sentBatch) {
      throw new Error(`DISPUTE_START_SOURCE_CLAIM_NOT_ATOMIC:${sourceClaim.routeId}`);
    }
    addMessage(
      state,
      sourceClaim.result === 'queued'
        ? `🌉 Cross-j claim ${sourceClaim.routeId}: source reveal bundled with dispute start`
        : `⏳ Cross-j claim ${sourceClaim.routeId}: start/reveal held behind immutable jBatch`,
    );
  }
  state.jBatchState!.autoBroadcastDraft = true;
  if (state.jBatchState!.sentBatch) return;
  const signerId = state.config.validators[0];
  if (!signerId) throw new Error('DISPUTE_START_CROSS_J_BROADCAST_SIGNER_MISSING');
  outputs.push({
    entityId: state.entityId,
    signerId,
    entityTxs: [{ type: 'j_broadcast', data: {} }],
  });
};

const queueDisputeStart = (
  sourceState: EntityState,
  state: EntityState,
  account: AccountReplica,
  tx: StartTx,
  evidence: StartEvidence,
  outputs: EntityInput[],
  runtimeSeed: string | undefined,
  canonicalDeltaTransformerAddress: string,
): void => {
  const batch = state.jBatchState!.batch;
  const hasPulls = proofBodyHasPulls(
    evidence.initialProofbody,
    canonicalDeltaTransformerAddress,
  );
  if (hasPulls && batchOpCount(batch) !== 0) {
    // A Pull-bearing start defines the inclusive reveal second S. Mixing it
    // into an existing mutable draft can exhaust registration capacity after
    // the Account is already frozen, leaving a valid zero-window claim
    // impossible. Require a clean draft so start plus every Account-scoped
    // Source/Target registration is one indivisible processBatch operation.
    throw new Error(
      `DISPUTE_START_PULL_BATCH_NOT_EMPTY:${batchOpCount(batch)}`,
    );
  }
  if (batch.disputeStarts.length >= J_BATCH_CONTRACT_LIMITS.maxDisputeStarts) {
    throw new Error(
      `J_BATCH_LIMIT_EXCEEDED: disputeStarts ${batch.disputeStarts.length + 1}/` +
      `${J_BATCH_CONTRACT_LIMITS.maxDisputeStarts}`,
    );
  }
  if (batchOpCount(batch) + 1 > J_BATCH_CONTRACT_LIMITS.maxTotalOps) {
    throw new Error(
      `J_BATCH_LIMIT_EXCEEDED: disputeStart would exceed total ops ${batchOpCount(batch) + 1}/` +
      `${J_BATCH_CONTRACT_LIMITS.maxTotalOps}`,
    );
  }
  batch.disputeStarts.push({
    counterentity: tx.data.counterpartyEntityId,
    nonce: evidence.signedNonce,
    proposerIsLeft: evidence.proposerIsLeft,
    proofbodyHash: evidence.proofBodyHash,
    initialProofbody: evidence.initialProofbody,
    watchSeed: String(evidence.initialProofbody.watchSeed),
    sig: evidence.counterpartyHanko,
    starterInitialArguments: evidence.starterInitialArguments,
    starterCounterArguments: evidence.starterCounterArguments,
    starterCounterProofCommitment: evidence.starterCounterProofCommitment,
  });
  account.status = 'disputed';
  delete account.disputePrepare;
  freezeAccountForDispute(account, false);
  account.activeDispute ??= {
    startedByLeft: isDisputeStartedByLeft(
      sourceState.entityId,
      account.state.leftEntity,
      account.state.rightEntity,
    ),
    initialProofbodyHash: evidence.proofBodyHash,
    initialNonce: evidence.signedNonce,
    initialProposerIsLeft: evidence.proposerIsLeft,
    // Depository chooses the authoritative timeout at inclusion height.
    disputeTimeout: 0,
    jNonce: evidence.jNonce,
    starterInitialArguments: evidence.starterInitialArguments,
    starterCounterArguments: evidence.starterCounterArguments,
    starterCounterProofCommitment: evidence.starterCounterProofCommitment,
    observedOnChain: false,
    finalizeQueued: false,
  };
  if (hasPulls) {
    // A verified Target witness may have arrived while order removal was still
    // preparing this dispute. Install the exact draft binding first, then pull
    // that evidence into the same start batch. Sealing start alone would lose
    // one block and makes a bilaterally chosen zero-second window unusable.
    // Pull semantics come from the signed ProofBody, never an optional UI
    // route hint. A generic dispute over an Account with Pulls has exactly the
    // same atomic publication requirements as must-close fanout.
    queuePullDisputeRegistrations(
      state,
      tx,
      evidence,
      outputs,
      runtimeSeed,
      canonicalDeltaTransformerAddress,
    );
  }
  encodeJBatch(batch);
};

export const handleDisputeStart = async (
  entityState: EntityState,
  entityTx: StartTx,
  env: EntityRuntimeContext,
  _storageChanges: RuntimeOverlayRecord[] = [],
  mutableFrameState = false,
): Promise<{ newState: EntityState; outputs: EntityInput[] }> => {
  if (entityTx.data.starterCounterArguments !== undefined) {
    throw new Error('DISPUTE_INCREMENTED_ARGUMENT_OVERRIDE_UNSUPPORTED');
  }
  validateCrossJurisdictionDisputeRoute(entityState, entityTx);
  const counterpartyId = entityTx.data.counterpartyEntityId;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  disputeLog.debug('start.begin', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyId),
  });
  const account = admitDisputeStart(newState, counterpartyId);
  if (!account) return { newState, outputs };
  const proof = loadStartProof(entityState, newState, account, counterpartyId);
  if (!proof) return { newState, outputs };
  if (entityTx.data.crossJurisdictionRouteId) {
    assertCrossJurisdictionDisputeProofHasPulls(
      proof.initialProofbody,
      entityTx.data.crossJurisdictionRouteId,
      requireAccountDeltaTransformerAddress(env.state, account.state),
    );
  }
  const nonce = resolveStartNonce(newState, account, counterpartyId, proof.proofBodyHash);
  if (!nonce) return { newState, outputs };
  const argumentsPair = buildStarterArguments(
    newState,
    account,
    counterpartyId,
    proof.proofBodyHash,
    nonce.signedNonce,
    entityTx.data.starterInitialArguments,
    env,
  );
  const evidence: StartEvidence = { ...proof, ...nonce, ...argumentsPair };
  if (!(await verifyStartHanko(entityState, newState, account, counterpartyId, evidence, env))) {
    return { newState, outputs };
  }
  queueDisputeStart(
    entityState,
    newState,
    account,
    entityTx,
    evidence,
    outputs,
    env.runtimeSeed,
    requireAccountDeltaTransformerAddress(env.state, account.state),
  );
  disputeLog.debug('start.jbatch_queued', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyId),
    proofBodyHash: shortHash(evidence.proofBodyHash),
    hankoLen: evidence.counterpartyHanko.length,
    signedNonce: evidence.signedNonce,
  });
  const description = entityTx.data.description;
  addMessage(
    newState,
    `⚔️ Dispute started vs ${counterpartyId.slice(-4)} ${description ? `(${description})` : ''} - account frozen, use jBroadcast to commit`,
  );
  return { newState, outputs };
};
