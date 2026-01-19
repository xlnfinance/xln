/**
 * Settlement Workspace Handlers
 *
 * These handlers manage the bilateral settlement negotiation workspace.
 * Settlement workspace is a shared editing area for proposing, updating,
 * approving, and executing cooperative state updates.
 *
 * Flow:
 * 1. settle_propose: Either party creates workspace with initial diffs
 * 2. settle_update: Either party can update diffs (replaces current)
 * 3. settle_approve: Either party signs (bumps coopNonce to invalidate old disputes)
 * 4. settle_execute: Adds approved settlement to jBatch
 * 5. settle_reject: Clears workspace without executing
 *
 * Conservation Law: leftDiff + rightDiff + collateralDiff = 0 (enforced by Account.sol)
 */

import type { EntityState, EntityTx, EntityInput, SettlementWorkspace, SettlementDiff, AccountInput } from '../../types';
import { cloneEntityState, addMessage, resolveEntityProposerId, getAccountPerspective } from '../../state-helpers';
import { initJBatch, batchAddSettlement } from '../../j-batch';
import { isLeftEntity } from '../../entity-id-utils';
import type { Env, HankoString } from '../../types';
import { createSettlementHash } from '../../proof-builder';
import { signHashesAsSingleEntity } from '../../hanko-signing';

// Validate conservation law for all diffs
function validateDiffs(diffs: SettlementDiff[]): void {
  for (const diff of diffs) {
    const sum = diff.leftDiff + diff.rightDiff + diff.collateralDiff;
    if (sum !== 0n) {
      throw new Error(`Conservation law violated: leftDiff + rightDiff + collateralDiff = ${sum} (must be 0)`);
    }
  }
}

/**
 * settle_propose: Create a new settlement workspace
 */
export async function handleSettlePropose(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_propose' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { counterpartyEntityId, diffs, forgiveTokenIds, memo } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  console.log(`⚖️ settle_propose: ${entityState.entityId.slice(-4)} → ${counterpartyEntityId.slice(-4)}`);

  // Validate diffs
  validateDiffs(diffs);

  // Get or validate account exists
  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) {
    throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  }

  // Check if workspace already exists
  if (account.settlementWorkspace) {
    throw new Error(`Settlement workspace already exists. Use settle_update or settle_reject first.`);
  }

  // Determine canonical left/right
  const isLeft = isLeftEntity(entityState.entityId, counterpartyEntityId);

  // Create workspace
  const workspace: SettlementWorkspace = {
    diffs,
    forgiveTokenIds: forgiveTokenIds || [],
    insuranceRegs: [],
    initiatedBy: isLeft ? 'left' : 'right',
    status: 'awaiting_counterparty',
    memo,
    version: 1,
    createdAt: env.timestamp,
    lastUpdatedAt: env.timestamp,
  };

  account.settlementWorkspace = workspace;

  console.log(`✅ settle_propose: Workspace created (version 1)`);
  addMessage(newState, `⚖️ Settlement proposed to ${counterpartyEntityId.slice(-4)} - awaiting response`);

  // Send workspace to counterparty via AccountInput
  const targetProposerId = resolveEntityProposerId(env, counterpartyEntityId, 'settle_propose');

  const settleAction: AccountInput['settleAction'] = {
    type: 'propose',
    diffs,
    forgiveTokenIds: forgiveTokenIds || [],
    memo,
    version: 1,
  };

  outputs.push({
    entityId: counterpartyEntityId,
    signerId: targetProposerId,
    entityTxs: [{
      type: 'accountInput',
      data: {
        fromEntityId: entityState.entityId,
        toEntityId: counterpartyEntityId,
        settleAction,
      }
    }]
  });

  return { newState, outputs };
}

/**
 * settle_update: Update existing workspace diffs
 */
export async function handleSettleUpdate(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_update' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { counterpartyEntityId, diffs, forgiveTokenIds, memo } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  console.log(`⚖️ settle_update: ${entityState.entityId.slice(-4)} → ${counterpartyEntityId.slice(-4)}`);

  // Validate diffs
  validateDiffs(diffs);

  // Get account and workspace
  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) {
    throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  }

  if (!account.settlementWorkspace) {
    throw new Error(`No settlement workspace to update. Use settle_propose first.`);
  }

  // Cannot update after either party has signed
  if (account.settlementWorkspace.leftHanko || account.settlementWorkspace.rightHanko) {
    throw new Error(`Cannot update after signing. Use settle_reject to start over.`);
  }

  // Update workspace (replaces diffs entirely)
  account.settlementWorkspace.diffs = diffs;
  account.settlementWorkspace.forgiveTokenIds = forgiveTokenIds || account.settlementWorkspace.forgiveTokenIds;
  account.settlementWorkspace.memo = memo ?? account.settlementWorkspace.memo;
  account.settlementWorkspace.version += 1;
  account.settlementWorkspace.lastUpdatedAt = env.timestamp;
  account.settlementWorkspace.status = 'awaiting_counterparty';

  console.log(`✅ settle_update: Workspace updated (version ${account.settlementWorkspace.version})`);
  addMessage(newState, `⚖️ Settlement updated (v${account.settlementWorkspace.version})`);

  // Send update to counterparty
  const targetProposerId = resolveEntityProposerId(env, counterpartyEntityId, 'settle_update');

  const settleAction: AccountInput['settleAction'] = {
    type: 'update',
    diffs,
    forgiveTokenIds: account.settlementWorkspace.forgiveTokenIds,
    memo: account.settlementWorkspace.memo,
    version: account.settlementWorkspace.version,
  };

  outputs.push({
    entityId: counterpartyEntityId,
    signerId: targetProposerId,
    entityTxs: [{
      type: 'accountInput',
      data: {
        fromEntityId: entityState.entityId,
        toEntityId: counterpartyEntityId,
        settleAction,
      }
    }]
  });

  return { newState, outputs };
}

/**
 * settle_approve: Sign the current workspace state
 * CRITICAL: This bumps cooperativeNonce to invalidate older dispute proofs
 */
export async function handleSettleApprove(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_approve' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { counterpartyEntityId } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  console.log(`⚖️ settle_approve: ${entityState.entityId.slice(-4)} signing settlement with ${counterpartyEntityId.slice(-4)}`);

  // Get account and workspace
  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) {
    throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  }

  if (!account.settlementWorkspace) {
    throw new Error(`No settlement workspace to approve.`);
  }

  const workspace = account.settlementWorkspace;
  const { iAmLeft } = getAccountPerspective(account, entityState.entityId);

  // Check if we already signed
  const myHanko = iAmLeft ? workspace.leftHanko : workspace.rightHanko;
  if (myHanko) {
    throw new Error(`Already signed this workspace.`);
  }

  // CRITICAL: Bump cooperativeNonce BEFORE signing
  // This invalidates any older dispute proofs that used lower nonces
  account.proofHeader.cooperativeNonce += 1;
  workspace.cooperativeNonceAtSign = account.proofHeader.cooperativeNonce;

  console.log(`⚖️ Bumped cooperativeNonce to ${account.proofHeader.cooperativeNonce}`);

  // Create settlement hash for signing
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction) {
    throw new Error('No jurisdiction configured');
  }

  const settlementHash = createSettlementHash(account, workspace.diffs, jurisdiction.depositoryAddress);

  // Get signer ID for this entity (first validator for single-signer entities)
  const signerId = entityState.config.validators[0];
  if (!signerId) {
    throw new Error('No validator configured for entity');
  }

  // Sign the settlement
  const hankos = await signHashesAsSingleEntity(
    env,
    entityState.entityId,
    signerId,
    [settlementHash]
  );
  const hanko = hankos[0];

  // Store our hanko
  if (iAmLeft) {
    workspace.leftHanko = hanko;
  } else {
    workspace.rightHanko = hanko;
  }

  // Update status
  const otherHanko = iAmLeft ? workspace.rightHanko : workspace.leftHanko;
  if (otherHanko) {
    workspace.status = 'ready_to_submit';
    console.log(`✅ settle_approve: Both parties signed - ready to submit`);
    addMessage(newState, `✅ Settlement fully signed - ready to execute`);
  } else {
    workspace.status = 'awaiting_counterparty';
    console.log(`✅ settle_approve: We signed - awaiting counterparty`);
    addMessage(newState, `⚖️ Settlement signed - awaiting counterparty signature`);
  }

  // Send approval to counterparty
  const targetProposerId = resolveEntityProposerId(env, counterpartyEntityId, 'settle_approve');

  const settleAction: AccountInput['settleAction'] = {
    type: 'approve',
    hanko,
    version: workspace.version,
  };

  outputs.push({
    entityId: counterpartyEntityId,
    signerId: targetProposerId,
    entityTxs: [{
      type: 'accountInput',
      data: {
        fromEntityId: entityState.entityId,
        toEntityId: counterpartyEntityId,
        settleAction,
      }
    }]
  });

  return { newState, outputs };
}

/**
 * settle_execute: Add approved settlement to jBatch and clear workspace
 */
export async function handleSettleExecute(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_execute' }>,
  _env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { counterpartyEntityId } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  console.log(`⚖️ settle_execute: ${entityState.entityId.slice(-4)} executing settlement with ${counterpartyEntityId.slice(-4)}`);

  // Get account and workspace
  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) {
    throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  }

  if (!account.settlementWorkspace) {
    throw new Error(`No settlement workspace to execute.`);
  }

  const workspace = account.settlementWorkspace;

  // Require both signatures
  if (!workspace.leftHanko || !workspace.rightHanko) {
    throw new Error(`Settlement not fully signed. leftHanko=${!!workspace.leftHanko}, rightHanko=${!!workspace.rightHanko}`);
  }

  // Initialize jBatch if needed
  if (!newState.jBatchState) {
    newState.jBatchState = initJBatch();
  }

  // Determine canonical left/right
  const isLeft = isLeftEntity(entityState.entityId, counterpartyEntityId);
  const leftEntity = isLeft ? entityState.entityId : counterpartyEntityId;
  const rightEntity = isLeft ? counterpartyEntityId : entityState.entityId;

  // Use counterparty's hanko for the settlement signature (we already have ours)
  // The settlement sig field expects the OTHER party's signature
  const { iAmLeft } = getAccountPerspective(account, entityState.entityId);
  const counterpartyHanko = iAmLeft ? workspace.rightHanko : workspace.leftHanko;

  // Add to jBatch
  batchAddSettlement(
    newState.jBatchState,
    leftEntity,
    rightEntity,
    workspace.diffs,
    workspace.forgiveTokenIds,
    workspace.insuranceRegs,
    counterpartyHanko!
  );

  console.log(`✅ settle_execute: Added to jBatch`);
  console.log(`   Left: ${leftEntity.slice(-4)}, Right: ${rightEntity.slice(-4)}`);
  console.log(`   Diffs: ${workspace.diffs.length}`);

  // Clear workspace
  delete account.settlementWorkspace;

  addMessage(newState, `✅ Settlement executed (${workspace.diffs.length} diffs) - use j_broadcast to commit`);

  return { newState, outputs };
}

/**
 * settle_reject: Clear workspace without executing
 */
export async function handleSettleReject(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_reject' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[] }> {
  const { counterpartyEntityId, reason } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];

  console.log(`⚖️ settle_reject: ${entityState.entityId.slice(-4)} rejecting settlement with ${counterpartyEntityId.slice(-4)}`);

  // Get account
  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) {
    throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  }

  if (!account.settlementWorkspace) {
    console.log(`⚖️ settle_reject: No workspace to reject (already cleared)`);
    return { newState, outputs };
  }

  // Clear workspace
  delete account.settlementWorkspace;

  console.log(`✅ settle_reject: Workspace cleared`);
  addMessage(newState, `❌ Settlement rejected${reason ? `: ${reason}` : ''}`);

  // Notify counterparty
  const targetProposerId = resolveEntityProposerId(env, counterpartyEntityId, 'settle_reject');

  const settleAction: AccountInput['settleAction'] = {
    type: 'reject',
    memo: reason,
  };

  outputs.push({
    entityId: counterpartyEntityId,
    signerId: targetProposerId,
    entityTxs: [{
      type: 'accountInput',
      data: {
        fromEntityId: entityState.entityId,
        toEntityId: counterpartyEntityId,
        settleAction,
      }
    }]
  });

  return { newState, outputs };
}

/**
 * Process incoming settleAction from AccountInput
 * Called by account handler when AccountInput contains settleAction
 */
export function processSettleAction(
  account: import('../../types').AccountMachine,
  settleAction: NonNullable<AccountInput['settleAction']>,
  fromEntityId: string,
  myEntityId: string,
  env: Env
): { success: boolean; message: string } {
  const { iAmLeft } = getAccountPerspective(account, myEntityId);
  const theyAreLeft = !iAmLeft;

  switch (settleAction.type) {
    case 'propose': {
      // Counterparty proposed new workspace
      if (account.settlementWorkspace) {
        return { success: false, message: 'Workspace already exists' };
      }

      const workspace: SettlementWorkspace = {
        diffs: settleAction.diffs || [],
        forgiveTokenIds: settleAction.forgiveTokenIds || [],
        insuranceRegs: [],
        initiatedBy: theyAreLeft ? 'left' : 'right',
        status: 'awaiting_counterparty',
        memo: settleAction.memo,
        version: settleAction.version || 1,
        createdAt: env.timestamp,
        lastUpdatedAt: env.timestamp,
      };

      account.settlementWorkspace = workspace;
      console.log(`📥 Received settle_propose from ${fromEntityId.slice(-4)}`);
      return { success: true, message: `Settlement proposed by ${fromEntityId.slice(-4)}` };
    }

    case 'update': {
      // Counterparty updated workspace
      if (!account.settlementWorkspace) {
        return { success: false, message: 'No workspace to update' };
      }

      if (account.settlementWorkspace.leftHanko || account.settlementWorkspace.rightHanko) {
        return { success: false, message: 'Cannot update after signing' };
      }

      account.settlementWorkspace.diffs = settleAction.diffs || account.settlementWorkspace.diffs;
      account.settlementWorkspace.forgiveTokenIds = settleAction.forgiveTokenIds || account.settlementWorkspace.forgiveTokenIds;
      account.settlementWorkspace.memo = settleAction.memo ?? account.settlementWorkspace.memo;
      account.settlementWorkspace.version = settleAction.version || account.settlementWorkspace.version + 1;
      account.settlementWorkspace.lastUpdatedAt = env.timestamp;

      console.log(`📥 Received settle_update from ${fromEntityId.slice(-4)} (v${account.settlementWorkspace.version})`);
      return { success: true, message: `Settlement updated to v${account.settlementWorkspace.version}` };
    }

    case 'approve': {
      // Counterparty signed
      if (!account.settlementWorkspace) {
        return { success: false, message: 'No workspace to approve' };
      }

      if (!settleAction.hanko) {
        return { success: false, message: 'No hanko provided' };
      }

      // Store their hanko
      if (theyAreLeft) {
        account.settlementWorkspace.leftHanko = settleAction.hanko;
      } else {
        account.settlementWorkspace.rightHanko = settleAction.hanko;
      }

      // Update status
      const myHanko = iAmLeft ? account.settlementWorkspace.leftHanko : account.settlementWorkspace.rightHanko;
      if (myHanko) {
        account.settlementWorkspace.status = 'ready_to_submit';
      }

      console.log(`📥 Received settle_approve from ${fromEntityId.slice(-4)}`);
      return { success: true, message: `Counterparty signed settlement` };
    }

    case 'reject': {
      // Counterparty rejected - clear workspace
      delete account.settlementWorkspace;
      console.log(`📥 Received settle_reject from ${fromEntityId.slice(-4)}: ${settleAction.memo || 'no reason'}`);
      return { success: true, message: `Settlement rejected by ${fromEntityId.slice(-4)}` };
    }

    case 'execute': {
      // This shouldn't come via AccountInput - execute is local
      return { success: false, message: 'Execute is a local operation' };
    }

    default:
      return { success: false, message: `Unknown settleAction type` };
  }
}

/**
 * Auto-approve logic for end users
 * Returns true if the settlement is safe to auto-approve
 *
 * Safety rules:
 * - If my reserve decreases: REJECT (they're taking from me)
 * - If my reserve increases: APPROVE (I'm gaining)
 * - If reserve unchanged, check ondelta direction for my benefit
 */
export function userAutoApprove(diff: SettlementDiff, iAmLeft: boolean): boolean {
  const myReserveDiff = iAmLeft ? diff.leftDiff : diff.rightDiff;

  // My reserve decreases → REJECT (they're taking from me)
  if (myReserveDiff < 0n) {
    return false;
  }

  // My reserve increases → APPROVE (I'm gaining)
  if (myReserveDiff > 0n) {
    return true;
  }

  // Reserve unchanged, check ondelta
  // ondelta tracks LEFT's share of collateral
  // For LEFT: positive ondeltaDiff means I gain attribution
  // For RIGHT: negative ondeltaDiff means LEFT loses (I gain)
  if (iAmLeft) {
    return diff.ondeltaDiff >= 0n;
  } else {
    return diff.ondeltaDiff <= 0n;
  }
}

/**
 * Check if all diffs in workspace are safe to auto-approve
 */
export function canAutoApproveWorkspace(workspace: SettlementWorkspace, iAmLeft: boolean): boolean {
  for (const diff of workspace.diffs) {
    if (!userAutoApprove(diff, iAmLeft)) {
      return false;
    }
  }
  return true;
}
