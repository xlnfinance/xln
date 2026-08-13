import { haltRuntimeFailure } from "../../../../protocol/errors/failure-taxonomy";

import { ethers } from 'ethers';

import type { AccountReplica } from '../../../../types/account';
import type { EntityState } from '../../../types';
import type { EntityTx } from '../../../../types/entity-tx';
import type { ProofBodyStruct } from '../../../../../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { addMessage } from '../../../frame-events';
import { initJBatch } from '../../../../jurisdiction/machine/batch';
import { isCrossJurisdictionTerminalStatus } from '../../../../extensions/cross-j';
import { freezeAccountForDispute } from '../../../../account/consensus/dispute/policy';
import { BATCH_ABI } from '../../../../protocol/dispute/proof-body';
import {
  collectDisputeEvidenceReadinessIssues,
  hasQueuedDisputeStart,
} from './shared';

type StartTx = Extract<EntityTx, { type: 'disputeStart' }>;

const DELTA_BATCH_PARAM = ethers.ParamType.from(BATCH_ABI);
const ABI_CODER = ethers.AbiCoder.defaultAbiCoder();

export const validateCrossJurisdictionDisputeRoute = (
  state: EntityState,
  tx: StartTx,
): void => {
  const routeId = tx.data.crossJurisdictionRouteId;
  if (!routeId) return;
  const route = state.crossJurisdictionSwaps?.get(routeId);
  if (!route || route.orderId !== routeId) {
    throw haltRuntimeFailure("DISPUTE_START_CROSS_J_ROUTE_MISSING", `DISPUTE_START_CROSS_J_ROUTE_MISSING:${routeId}`);
  }
  const localEntityId = state.entityId.toLowerCase();
  const counterpartyId = tx.data.counterpartyEntityId.toLowerCase();
  const accountPairMatches = (left: string, right: string): boolean =>
    (left.toLowerCase() === localEntityId && right.toLowerCase() === counterpartyId)
    || (right.toLowerCase() === localEntityId && left.toLowerCase() === counterpartyId);
  const isSourceAccount = accountPairMatches(
    route.source.entityId,
    route.source.counterpartyEntityId,
  );
  const isTargetAccount = accountPairMatches(
    route.target.entityId,
    route.target.counterpartyEntityId,
  );
  // Either signer of a bilateral Account may start its clock. Restricting this
  // check to the user-facing direction breaks must-close when an online Hub
  // force-starts the sibling leg for an offline user. A route that maps the
  // same Account onto both legs is ambiguous and is rejected rather than
  // silently choosing one financial role.
  if (isSourceAccount === isTargetAccount) {
    throw haltRuntimeFailure("DISPUTE_START_CROSS_J_ROUTE_ROLE_MISMATCH", `DISPUTE_START_CROSS_J_ROUTE_ROLE_MISMATCH:${routeId}`);
  }
  if (isCrossJurisdictionTerminalStatus(route.status)) {
    throw haltRuntimeFailure("DISPUTE_START_CROSS_J_ROUTE_INACTIVE", `DISPUTE_START_CROSS_J_ROUTE_INACTIVE:${routeId}:${route.status}`);
  }
  // Owner invariant: a cross-j swap leg is defined by paired registry pulls.
  // Without source+target pull commitments there is nothing for applyPull to
  // settle from the reveal registry — reject before drafting disputeStart.
  if (!route.sourcePull || !route.targetPull) {
    throw haltRuntimeFailure("DISPUTE_START_CROSS_J_PULLS_MISSING", `DISPUTE_START_CROSS_J_PULLS_MISSING:${routeId}`);
  }
};

/**
 * Cross-j ProofBody must encode ≥1 DeltaTransformer pull.
 *
 * Why: registry settlement only runs inside applyPull. A signed ProofBody that
 * carries only payments/swaps on a route-bound disputeStart would finalize
 * without consulting hashLadderRegistrations — silent wrong economics. Opaque custom
 * transformers are ignored here; they are not the pull settlement path.
 */
/**
 * True when the signed ProofBody encodes at least one canonical Pull.
 *
 * An ABI-compatible custom transformer is still opaque executable logic: its
 * tuple shape does not grant it DeltaTransformer timing semantics. Conversely,
 * malformed bytes addressed to the canonical DeltaTransformer must fail loud,
 * exactly as Solidity abi.decode would, rather than being misclassified as a
 * pull-free proof eligible for the role-gated non-starter acceptance path.
 */
export const proofBodyHasPulls = (
  proofBody: ProofBodyStruct,
  canonicalDeltaTransformerAddress: string,
): boolean => {
  if (!ethers.isAddress(canonicalDeltaTransformerAddress)) {
    throw haltRuntimeFailure("DISPUTE_DELTA_TRANSFORMER_ADDRESS_INVALID", `DISPUTE_DELTA_TRANSFORMER_ADDRESS_INVALID:${canonicalDeltaTransformerAddress}`);
  }
  const canonicalAddress = canonicalDeltaTransformerAddress.toLowerCase();
  for (const [transformerIndex, transformer] of proofBody.transformers.entries()) {
    if (String(transformer.transformerAddress).toLowerCase() !== canonicalAddress) continue;
    try {
      const decoded = ABI_CODER.decode([DELTA_BATCH_PARAM], transformer.encodedBatch)[0] as {
        pull: readonly unknown[];
      };
      if (decoded.pull.length > 0) return true;
    } catch (error) {
      throw haltRuntimeFailure("DISPUTE_CANONICAL_DELTA_BATCH_INVALID", `DISPUTE_CANONICAL_DELTA_BATCH_INVALID:${transformerIndex}:` +
        `${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return false;
};

export const assertCrossJurisdictionDisputeProofHasPulls = (
  proofBody: ProofBodyStruct,
  routeId: string,
  canonicalDeltaTransformerAddress: string,
): void => {
  if (!proofBodyHasPulls(proofBody, canonicalDeltaTransformerAddress)) {
    throw haltRuntimeFailure("DISPUTE_START_CROSS_J_PROOF_PULLS_MISSING", `DISPUTE_START_CROSS_J_PROOF_PULLS_MISSING:${routeId}`);
  }
};

export const admitDisputeStart = (
  state: EntityState,
  counterpartyId: string,
): AccountReplica | null => {
  state.jBatchState ??= initJBatch();
  if (state.jBatchState.sentBatch) {
    addMessage(
      state,
      `ℹ️ disputeStart queued to current batch while sentBatch nonce=${state.jBatchState.sentBatch.entityNonce} is still pending`,
    );
  }
  const account = state.accounts.get(counterpartyId);
  if (!account) {
    addMessage(state, `❌ No account with ${counterpartyId.slice(-4)} - cannot start dispute`);
    return null;
  }
  const status = account.status ?? 'active';
  if (status === 'disputed') {
    addMessage(state, `❌ Account with ${counterpartyId.slice(-4)} is disputed - reopen required`);
    return null;
  }
  if (status !== 'dispute_preparing') {
    addMessage(
      state,
      `❌ Account with ${counterpartyId.slice(-4)} must enter dispute preparation before disputeStart`,
    );
    return null;
  }
  freezeAccountForDispute(account, true);
  const readinessIssues = collectDisputeEvidenceReadinessIssues(
    account,
    Number(state.timestamp ?? 0),
  );
  if (readinessIssues.length > 0) {
    addMessage(
      state,
      `⏳ disputeStart blocked until evidence is stable for ${counterpartyId.slice(-4)}: ${readinessIssues.join('; ')}`,
    );
    return null;
  }
  if (hasQueuedDisputeStart(state, counterpartyId)) {
    addMessage(
      state,
      `ℹ️ disputeStart already queued for ${counterpartyId.slice(-4)} (awaiting batch lifecycle)`,
    );
    return null;
  }
  return account;
};
