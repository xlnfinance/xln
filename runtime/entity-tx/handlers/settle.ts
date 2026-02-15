/**
 * Settlement Workspace Handlers (V1 — Typed Ops)
 *
 * Ops-based settlement: propose/update with SettlementOp[], compile to diffs at approve.
 *
 * Flow:
 * 1. settle_propose: Either party creates workspace with ops[]
 * 2. settle_update: Either party replaces ops[] (clears hankos)
 * 3. settle_approve: Counterparty of lastModifier compiles ops → diffs, signs
 * 4. settle_execute: Executor submits compiled diffs to jBatch
 * 5. settle_reject: Clears workspace without executing
 */

import type { EntityState, EntityTx, EntityInput, SettlementWorkspace, SettlementDiff, SettlementOp, AccountInput } from '../../types';
import { cloneEntityState, addMessage, getAccountPerspective } from '../../state-helpers';
import { initJBatch, batchAddSettlement } from '../../j-batch';
import { isLeftEntity } from '../../entity-id-utils';
import type { Env, HankoString } from '../../types';
import { createSettlementHashWithNonce, createDisputeProofHashWithNonce, buildAccountProofBody } from '../../proof-builder';
import { signHashesAsSingleEntity } from '../../hanko-signing';
import { compileOps } from '../../settlement-ops';

import type { AccountMachine } from '../../types';

/**
 * Sign nonce+1 dispute proof for post-settlement validity.
 */
async function signPostSettlementDisputeProof(
  env: Env,
  entityState: EntityState,
  account: AccountMachine,
  onChainNonce: number,
): Promise<{ hanko: HankoString; proofBodyHash: string; nonce: number } | null> {
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction?.depositoryAddress) return null;
  const signerId = entityState.config.validators[0];
  if (!signerId) return null;

  try {
    const { proofBodyHash } = buildAccountProofBody(account);
    const disputeHash = createDisputeProofHashWithNonce(
      account, proofBodyHash, jurisdiction.depositoryAddress, onChainNonce + 1
    );
    const hankos = await signHashesAsSingleEntity(env, entityState.entityId, signerId, [disputeHash]);
    if (!hankos[0]) return null;
    return { hanko: hankos[0], proofBodyHash, nonce: onChainNonce + 1 };
  } catch (e) {
    console.warn(`⚠️ Post-settlement dispute proof signing failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Convert settlement diffs to hold format for accountTx
 */
function diffsToHoldFormat(diffs: SettlementDiff[]): Array<{
  tokenId: number;
  leftWithdrawing: bigint;
  rightWithdrawing: bigint;
}> {
  return diffs.map(diff => ({
    tokenId: diff.tokenId,
    leftWithdrawing: diff.leftDiff < 0n ? -diff.leftDiff : 0n,
    rightWithdrawing: diff.rightDiff < 0n ? -diff.rightDiff : 0n,
  }));
}

type MempoolOp = { accountId: string; tx: import('../../types').AccountTx };

/**
 * Create settle_hold or settle_release mempoolOp for frame-atomic application
 */
function createSettlementHoldOp(
  accountId: string,
  diffs: SettlementDiff[],
  workspaceVersion: number,
  action: 'set' | 'release'
): MempoolOp | null {
  const holdDiffs = diffsToHoldFormat(diffs);
  const hasWithdrawals = holdDiffs.some(d => d.leftWithdrawing > 0n || d.rightWithdrawing > 0n);
  if (!hasWithdrawals) {
    console.log(`⏭️ SETTLE-HOLD: No withdrawals to ${action} for workspace v${workspaceVersion}`);
    return null;
  }

  const tx = action === 'set'
    ? { type: 'settle_hold' as const, data: { workspaceVersion, diffs: holdDiffs } }
    : { type: 'settle_release' as const, data: { workspaceVersion, diffs: holdDiffs } };

  console.log(`📥 SETTLE-${action.toUpperCase()} op created for frame consensus (workspace v${workspaceVersion})`);
  return { accountId, tx };
}

/**
 * Convert V1-compat diffs to rawDiff ops (auto-conversion for backward compat)
 */
function diffsToOps(data: { ops?: SettlementOp[]; diffs?: SettlementDiff[]; forgiveTokenIds?: number[] }): SettlementOp[] {
  if (data.ops && data.ops.length > 0) return data.ops;
  const ops: SettlementOp[] = [];
  if (data.diffs) {
    for (const d of data.diffs) {
      ops.push({ type: 'rawDiff', tokenId: d.tokenId, leftDiff: d.leftDiff, rightDiff: d.rightDiff, collateralDiff: d.collateralDiff, ondeltaDiff: d.ondeltaDiff });
    }
  }
  if (data.forgiveTokenIds) {
    for (const tokenId of data.forgiveTokenIds) {
      ops.push({ type: 'forgive', tokenId });
    }
  }
  return ops;
}

/**
 * settle_propose: Create a new settlement workspace with typed ops
 */
export async function handleSettlePropose(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_propose' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[]; mempoolOps: MempoolOp[] }> {
  const { counterpartyEntityId, executorIsLeft: execParam, memo } = entityTx.data;
  const ops = diffsToOps(entityTx.data);
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];

  console.log(`⚖️ settle_propose: ${entityState.entityId.slice(-4)} → ${counterpartyEntityId.slice(-4)}`);

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  if (account.settlementWorkspace) throw new Error(`Settlement workspace already exists. Use settle_update or settle_reject first.`);

  const isLeft = isLeftEntity(entityState.entityId, counterpartyEntityId);

  // Validate: compileOps runs on proposer path (guard 1)
  const { diffs } = compileOps(ops, isLeft);

  const workspace: SettlementWorkspace = {
    ops,
    lastModifiedByLeft: isLeft,
    status: 'awaiting_counterparty',
    ...(memo && { memo }),
    version: 1,
    createdAt: newState.timestamp,
    lastUpdatedAt: newState.timestamp,
    executorIsLeft: execParam ?? !isLeft, // Default: counterparty executes
  };

  account.settlementWorkspace = workspace;

  // Ring-fence using compiled diffs
  const holdOp = createSettlementHoldOp(counterpartyEntityId, diffs, 1, 'set');
  if (holdOp) mempoolOps.push(holdOp);

  console.log(`✅ settle_propose: Workspace created (version 1, ${ops.length} ops)`);
  addMessage(newState, `⚖️ Settlement proposed to ${counterpartyEntityId.slice(-4)} - awaiting response`);

  // Send ops to counterparty
  const settleAction: AccountInput['settleAction'] = {
    type: 'propose',
    ops,
    executorIsLeft: workspace.executorIsLeft,
    ...(memo && { memo }),
    version: 1,
  };

  outputs.push({
    entityId: counterpartyEntityId,
    entityTxs: [{
      type: 'accountInput',
      data: {
        fromEntityId: entityState.entityId,
        toEntityId: counterpartyEntityId,
        settleAction,
      }
    }]
  });

  return { newState, outputs, mempoolOps };
}

/**
 * settle_update: Update existing workspace ops
 * Guard 2: Clears signatures, compiledDiffs, postSettlementDisputeProof
 * Guard 7: Releases OLD holds before setting new holds
 */
export async function handleSettleUpdate(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_update' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[]; mempoolOps: MempoolOp[] }> {
  const { counterpartyEntityId, executorIsLeft: execParam, memo } = entityTx.data;
  const ops = diffsToOps(entityTx.data);
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];

  console.log(`⚖️ settle_update: ${entityState.entityId.slice(-4)} → ${counterpartyEntityId.slice(-4)}`);

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  if (!account.settlementWorkspace) throw new Error(`No settlement workspace to update. Use settle_propose first.`);

  // Guard 2: Cannot update after signing
  if (account.settlementWorkspace.leftHanko || account.settlementWorkspace.rightHanko) {
    throw new Error(`Cannot update after signing. Use settle_reject to start over.`);
  }

  const isLeft = isLeftEntity(entityState.entityId, counterpartyEntityId);

  // Validate new ops (guard 1: dual-side validation)
  const { diffs: newDiffs } = compileOps(ops, isLeft);

  // Guard 7: Release OLD holds using OLD compile context
  const oldVersion = account.settlementWorkspace.version;
  const oldOps = account.settlementWorkspace.ops;
  const oldLastModifiedByLeft = account.settlementWorkspace.lastModifiedByLeft;
  const { diffs: oldDiffs } = compileOps(oldOps, oldLastModifiedByLeft);
  const releaseOp = createSettlementHoldOp(counterpartyEntityId, oldDiffs, oldVersion, 'release');
  if (releaseOp) mempoolOps.push(releaseOp);

  const newVersion = oldVersion + 1;

  // Update workspace — clear all cached/signed state (guard 2)
  account.settlementWorkspace.ops = ops;
  account.settlementWorkspace.lastModifiedByLeft = isLeft;
  if (memo) account.settlementWorkspace.memo = memo;
  account.settlementWorkspace.version = newVersion;
  account.settlementWorkspace.lastUpdatedAt = newState.timestamp;
  account.settlementWorkspace.status = 'awaiting_counterparty';
  delete account.settlementWorkspace.leftHanko;
  delete account.settlementWorkspace.rightHanko;
  delete account.settlementWorkspace.compiledDiffs;
  delete account.settlementWorkspace.compiledForgiveTokenIds;
  delete account.settlementWorkspace.postSettlementDisputeProof;

  // Guard 3: executorIsLeft can change only if no hankos exist (already ensured above)
  if (execParam !== undefined) {
    account.settlementWorkspace.executorIsLeft = execParam;
  }

  // Set NEW holds using new compile context
  const holdOp = createSettlementHoldOp(counterpartyEntityId, newDiffs, newVersion, 'set');
  if (holdOp) mempoolOps.push(holdOp);

  console.log(`✅ settle_update: Workspace updated (version ${newVersion}, ${ops.length} ops)`);
  addMessage(newState, `⚖️ Settlement updated (v${newVersion})`);

  // Send update to counterparty
  const settleAction: AccountInput['settleAction'] = {
    type: 'update',
    ops,
    executorIsLeft: account.settlementWorkspace.executorIsLeft,
    ...(account.settlementWorkspace.memo && { memo: account.settlementWorkspace.memo }),
    version: newVersion,
  };

  outputs.push({
    entityId: counterpartyEntityId,
    entityTxs: [{
      type: 'accountInput',
      data: {
        fromEntityId: entityState.entityId,
        toEntityId: counterpartyEntityId,
        settleAction,
      }
    }]
  });

  return { newState, outputs, mempoolOps };
}

/**
 * settle_approve: Compile ops → diffs, sign, cache compiled result
 *
 * Gate: Cannot approve your own proposal (lastModifiedByLeft === iAmLeft → throw)
 * Guard 3: Lock executorIsLeft after first hanko
 */
export async function handleSettleApprove(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_approve' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[]; mempoolOps: MempoolOp[]; hashesToSign?: Array<{ hash: string; type: 'settlement'; context: string }> }> {
  const { counterpartyEntityId } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];

  console.log(`⚖️ settle_approve: ${entityState.entityId.slice(-4)} signing settlement with ${counterpartyEntityId.slice(-4)}`);

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  if (!account.settlementWorkspace) throw new Error(`No settlement workspace to approve.`);

  const workspace = account.settlementWorkspace;
  const { iAmLeft } = getAccountPerspective(account, entityState.entityId);

  // Gate: Cannot approve your own proposal
  if (workspace.lastModifiedByLeft === iAmLeft) {
    throw new Error(`Cannot approve your own proposal - counterparty must approve first`);
  }

  // Check if we already signed
  const myHanko = iAmLeft ? workspace.leftHanko : workspace.rightHanko;
  if (myHanko) throw new Error(`Already signed this workspace.`);

  // Compile ops → diffs (using lastModifiedByLeft as proposer perspective)
  const { diffs, forgiveTokenIds } = compileOps(workspace.ops, workspace.lastModifiedByLeft);

  // Cache compiled result
  workspace.compiledDiffs = diffs;
  workspace.compiledForgiveTokenIds = forgiveTokenIds;

  // Sign with on-chain nonce + 1
  const onChainNonce = account.onChainSettlementNonce ?? 0;
  const signedNonce = onChainNonce + 1;
  workspace.nonceAtSign = signedNonce;

  console.log(`⚖️ Using settlement nonce: ${signedNonce} (onChain=${onChainNonce})`);

  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction) throw new Error('No jurisdiction configured');

  // Guard 5: Sign over compiled diffs (on-chain hash unchanged)
  const settlementHash = createSettlementHashWithNonce(account, diffs, jurisdiction.depositoryAddress, signedNonce);

  const signerId = entityState.config.validators[0];
  if (!signerId) throw new Error('No validator configured for entity');

  const hankos = await signHashesAsSingleEntity(env, entityState.entityId, signerId, [settlementHash]);
  const hanko = hankos[0];
  if (!hanko) throw new Error(`Failed to generate settlement hanko for ${signerId.slice(-4)}`);

  // Store our hanko
  if (iAmLeft) {
    workspace.leftHanko = hanko;
  } else {
    workspace.rightHanko = hanko;
  }

  // Post-settlement dispute proof
  const disputeResult = await signPostSettlementDisputeProof(env, newState, account, signedNonce);
  if (disputeResult) {
    if (!workspace.postSettlementDisputeProof) {
      workspace.postSettlementDisputeProof = {
        proofBodyHash: disputeResult.proofBodyHash,
        nonce: disputeResult.nonce,
      };
    }
    if (iAmLeft) {
      workspace.postSettlementDisputeProof.leftHanko = disputeResult.hanko;
    } else {
      workspace.postSettlementDisputeProof.rightHanko = disputeResult.hanko;
    }
    console.log(`✅ Nonce+1 dispute proof signed (nonce=${disputeResult.nonce})`);
  }

  // Update status — only one signature needed (counterparty's)
  workspace.status = 'awaiting_counterparty';
  console.log(`✅ settle_approve: Signed - awaiting executor to submit`);
  addMessage(newState, `⚖️ Settlement signed - ready for execution`);

  // Send approval to counterparty
  const settleAction: AccountInput['settleAction'] = {
    type: 'approve',
    hanko,
    version: workspace.version,
    nonceAtSign: workspace.nonceAtSign,
  };

  outputs.push({
    entityId: counterpartyEntityId,
    entityTxs: [{
      type: 'accountInput',
      data: {
        fromEntityId: entityState.entityId,
        toEntityId: counterpartyEntityId,
        settleAction,
      }
    }]
  });

  const hashesToSign: Array<{ hash: string; type: 'settlement'; context: string }> = [
    { hash: settlementHash, type: 'settlement', context: `settlement:${counterpartyEntityId.slice(-8)}:nonce:${onChainNonce}` },
  ];

  return { newState, outputs, mempoolOps, hashesToSign };
}

/**
 * settle_execute: Recompile from ops (guard 4), assert match, submit to jBatch
 */
export async function handleSettleExecute(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_execute' }>,
  _env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[]; mempoolOps: MempoolOp[] }> {
  const { counterpartyEntityId } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];

  console.log(`⚖️ settle_execute: ${entityState.entityId.slice(-4)} executing settlement with ${counterpartyEntityId.slice(-4)}`);

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  if (!account.settlementWorkspace) throw new Error(`No settlement workspace to execute.`);

  const workspace = account.settlementWorkspace;

  // Need counterparty's hanko for on-chain validation
  const { iAmLeft } = getAccountPerspective(account, entityState.entityId);
  const counterpartyHanko = iAmLeft ? workspace.rightHanko : workspace.leftHanko;
  if (!counterpartyHanko) {
    throw new Error(`Missing counterparty hanko for settlement execution (iAmLeft=${iAmLeft})`);
  }

  // Guard 4: Recompile from ops and assert match against cached
  const { diffs, forgiveTokenIds } = compileOps(workspace.ops, workspace.lastModifiedByLeft);
  if (workspace.compiledDiffs) {
    const cached = workspace.compiledDiffs;
    if (diffs.length !== cached.length) {
      throw new Error(`Recompiled diffs length mismatch: ${diffs.length} vs ${cached.length}`);
    }
    for (let i = 0; i < diffs.length; i++) {
      if (diffs[i].tokenId !== cached[i].tokenId ||
          diffs[i].leftDiff !== cached[i].leftDiff ||
          diffs[i].rightDiff !== cached[i].rightDiff ||
          diffs[i].collateralDiff !== cached[i].collateralDiff ||
          diffs[i].ondeltaDiff !== cached[i].ondeltaDiff) {
        throw new Error(`Recompiled diff mismatch at index ${i}`);
      }
    }
  }

  // Initialize jBatch if needed
  if (!newState.jBatchState) {
    newState.jBatchState = initJBatch();
  }

  const isLeft = isLeftEntity(entityState.entityId, counterpartyEntityId);
  const leftEntity = isLeft ? entityState.entityId : counterpartyEntityId;
  const rightEntity = isLeft ? counterpartyEntityId : entityState.entityId;

  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction?.entityProviderAddress) throw new Error('No entityProvider configured in jurisdiction');

  batchAddSettlement(
    newState.jBatchState,
    leftEntity,
    rightEntity,
    diffs,
    forgiveTokenIds,
    counterpartyHanko!,
    jurisdiction.entityProviderAddress,
    '0x',
    workspace.nonceAtSign ?? account.proofHeader.nonce,
    entityState.entityId
  );

  console.log(`✅ settle_execute: Added to jBatch (${diffs.length} diffs)`);

  // Release holds
  const releaseOp = createSettlementHoldOp(counterpartyEntityId, diffs, workspace.version, 'release');
  if (releaseOp) mempoolOps.push(releaseOp);

  account.settlementWorkspace.status = 'submitted';
  addMessage(newState, `✅ Settlement executed (${diffs.length} diffs) - use j_broadcast to commit`);

  return { newState, outputs, mempoolOps };
}

/**
 * settle_reject: Clear workspace without executing
 */
export async function handleSettleReject(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_reject' }>,
  env: Env
): Promise<{ newState: EntityState; outputs: EntityInput[]; mempoolOps: MempoolOp[] }> {
  const { counterpartyEntityId, reason } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const mempoolOps: MempoolOp[] = [];

  console.log(`⚖️ settle_reject: ${entityState.entityId.slice(-4)} rejecting settlement with ${counterpartyEntityId.slice(-4)}`);

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);

  if (!account.settlementWorkspace) {
    console.log(`⚖️ settle_reject: No workspace to reject (already cleared)`);
    return { newState, outputs, mempoolOps };
  }

  // Release holds using compiled diffs
  const { diffs } = compileOps(account.settlementWorkspace.ops, account.settlementWorkspace.lastModifiedByLeft);
  const wsVersion = account.settlementWorkspace.version;
  const releaseOp = createSettlementHoldOp(counterpartyEntityId, diffs, wsVersion, 'release');
  if (releaseOp) mempoolOps.push(releaseOp);

  delete account.settlementWorkspace;

  console.log(`✅ settle_reject: Workspace cleared`);
  addMessage(newState, `❌ Settlement rejected${reason ? `: ${reason}` : ''}`);

  const settleAction: AccountInput['settleAction'] = {
    type: 'reject',
    ...(reason && { memo: reason }),
  };

  outputs.push({
    entityId: counterpartyEntityId,
    entityTxs: [{
      type: 'accountInput',
      data: {
        fromEntityId: entityState.entityId,
        toEntityId: counterpartyEntityId,
        settleAction,
      }
    }]
  });

  return { newState, outputs, mempoolOps };
}

/**
 * Process incoming settleAction from AccountInput (counterparty receive path)
 *
 * Guard 1: compileOps runs on receive path too (dual-side validation)
 */
export async function processSettleAction(
  account: import('../../types').AccountMachine,
  settleAction: NonNullable<AccountInput['settleAction']>,
  fromEntityId: string,
  myEntityId: string,
  entityTimestamp: number,
  env?: Env,
  entityState?: EntityState,
): Promise<{ success: boolean; message: string; autoApproveOutput?: EntityInput }> {
  const { iAmLeft } = getAccountPerspective(account, myEntityId);
  const theyAreLeft = !iAmLeft;

  switch (settleAction.type) {
    case 'propose': {
      if (account.settlementWorkspace) {
        return { success: false, message: 'Workspace already exists' };
      }

      const ops = settleAction.ops || [];

      // Guard 1: Validate ops on receive path
      const { diffs } = compileOps(ops, theyAreLeft);

      const workspace: SettlementWorkspace = {
        ops,
        lastModifiedByLeft: theyAreLeft,
        status: 'awaiting_counterparty',
        ...(settleAction.memo && { memo: settleAction.memo }),
        version: settleAction.version || 1,
        createdAt: entityTimestamp,
        lastUpdatedAt: entityTimestamp,
        executorIsLeft: settleAction.executorIsLeft ?? theyAreLeft,
      };

      account.settlementWorkspace = workspace;

      console.log(`📥 Received settle_propose from ${fromEntityId.slice(-4)} (${ops.length} ops)`);

      // Auto-approve: compile then check safety
      let autoApproveOutput: EntityInput | undefined;
      if (env && entityState && canAutoApproveWorkspace(workspace, iAmLeft)) {
        console.log(`✅ Auto-approving settlement from ${fromEntityId.slice(-4)}`);
        try {
          const onChainNonce = account.onChainSettlementNonce ?? 0;
          const signedNonce = onChainNonce + 1;
          workspace.nonceAtSign = signedNonce;

          // Cache compiled diffs
          const { diffs: compiledDiffs, forgiveTokenIds } = compileOps(ops, workspace.lastModifiedByLeft);
          workspace.compiledDiffs = compiledDiffs;
          workspace.compiledForgiveTokenIds = forgiveTokenIds;

          const jurisdiction = entityState.config.jurisdiction;
          if (jurisdiction?.depositoryAddress) {
            const settlementHash = createSettlementHashWithNonce(
              account, compiledDiffs, jurisdiction.depositoryAddress, signedNonce
            );

            const signerId = entityState.config.validators[0];
            if (signerId) {
              const hankos = await signHashesAsSingleEntity(env, myEntityId, signerId, [settlementHash]);
              const hanko = hankos[0];
              if (hanko) {
                if (iAmLeft) {
                  workspace.leftHanko = hanko;
                } else {
                  workspace.rightHanko = hanko;
                }
                workspace.status = 'awaiting_counterparty';

                autoApproveOutput = {
                  entityId: fromEntityId,
                  entityTxs: [{
                    type: 'accountInput',
                    data: {
                      fromEntityId: myEntityId,
                      toEntityId: fromEntityId,
                      settleAction: {
                        type: 'approve' as const,
                        hanko,
                        version: workspace.version,
                        nonceAtSign: signedNonce,
                      },
                    }
                  }]
                };
                console.log(`✅ Auto-approve: signed settlement hanko (nonce=${signedNonce})`);

                const disputeResult = await signPostSettlementDisputeProof(env, entityState, account, signedNonce);
                if (disputeResult) {
                  if (!workspace.postSettlementDisputeProof) {
                    workspace.postSettlementDisputeProof = {
                      proofBodyHash: disputeResult.proofBodyHash,
                      nonce: disputeResult.nonce,
                    };
                  }
                  if (iAmLeft) {
                    workspace.postSettlementDisputeProof.leftHanko = disputeResult.hanko;
                  } else {
                    workspace.postSettlementDisputeProof.rightHanko = disputeResult.hanko;
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn(`⚠️ Auto-approve signing failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return {
        success: true,
        message: `Settlement proposed by ${fromEntityId.slice(-4)}${autoApproveOutput ? ' (auto-approved)' : ''}`,
        autoApproveOutput,
      };
    }

    case 'update': {
      if (!account.settlementWorkspace) {
        return { success: false, message: 'No workspace to update' };
      }

      if (account.settlementWorkspace.leftHanko || account.settlementWorkspace.rightHanko) {
        return { success: false, message: 'Cannot update after signing' };
      }

      const ops = settleAction.ops || account.settlementWorkspace.ops;

      // Guard 1: Validate on receive path
      compileOps(ops, theyAreLeft);

      account.settlementWorkspace.ops = ops;
      account.settlementWorkspace.lastModifiedByLeft = theyAreLeft;
      if (settleAction.memo) account.settlementWorkspace.memo = settleAction.memo;
      account.settlementWorkspace.version = settleAction.version || account.settlementWorkspace.version + 1;
      account.settlementWorkspace.lastUpdatedAt = entityTimestamp;
      // Guard 2: Clear cached compiled state
      delete account.settlementWorkspace.compiledDiffs;
      delete account.settlementWorkspace.compiledForgiveTokenIds;
      delete account.settlementWorkspace.postSettlementDisputeProof;
      // Guard 3: executorIsLeft update OK since no hankos
      if (settleAction.executorIsLeft !== undefined) {
        account.settlementWorkspace.executorIsLeft = settleAction.executorIsLeft;
      }

      console.log(`📥 Received settle_update from ${fromEntityId.slice(-4)} (v${account.settlementWorkspace.version})`);
      return { success: true, message: `Settlement updated to v${account.settlementWorkspace.version}` };
    }

    case 'approve': {
      if (!account.settlementWorkspace) {
        return { success: false, message: 'No workspace to approve' };
      }

      if (!settleAction.hanko) {
        return { success: false, message: 'No hanko provided' };
      }

      // Store their hanko + nonce
      if (theyAreLeft) {
        account.settlementWorkspace.leftHanko = settleAction.hanko;
      } else {
        account.settlementWorkspace.rightHanko = settleAction.hanko;
      }
      if (settleAction.nonceAtSign != null) {
        account.settlementWorkspace.nonceAtSign = settleAction.nonceAtSign;
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
      delete account.settlementWorkspace;
      console.log(`📥 Received settle_reject from ${fromEntityId.slice(-4)}: ${settleAction.memo || 'no reason'}`);
      return { success: true, message: `Settlement rejected by ${fromEntityId.slice(-4)}` };
    }

    case 'execute': {
      return { success: false, message: 'Execute is a local operation' };
    }

    default:
      return { success: false, message: `Unknown settleAction type` };
  }
}

/**
 * Auto-approve logic for end users (operates on compiled diffs)
 */
export function userAutoApprove(diff: SettlementDiff, iAmLeft: boolean): boolean {
  const myReserveDiff = iAmLeft ? diff.leftDiff : diff.rightDiff;
  if (myReserveDiff < 0n) return false;
  if (myReserveDiff > 0n) return true;
  if (iAmLeft) return diff.ondeltaDiff >= 0n;
  return diff.ondeltaDiff <= 0n;
}

/**
 * Check if workspace ops are safe to auto-approve (compiles then checks)
 */
export function canAutoApproveWorkspace(workspace: SettlementWorkspace, iAmLeft: boolean): boolean {
  const { diffs } = compileOps(workspace.ops, workspace.lastModifiedByLeft);
  return diffs.every(diff => userAutoApprove(diff, iAmLeft));
}
