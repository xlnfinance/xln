/**
 * Settlement Workspace Handlers (V1 — Typed Ops)
 *
 * Ops-based settlement: propose/update with SettlementOp[], compile to diffs at approve.
 *
 * Flow:
 * 1. settle_propose: Queue an Account-frame workspace upsert
 * 2. settle_update: Queue an exact previous-hash Account-frame replacement
 * 3. settle_approve: Counterparty of lastModifier compiles ops → diffs, signs
 * 4. settle_execute: Executor submits compiled diffs to jBatch
 * 5. settle_reject: Queue an exact Account-frame clear
 */

import type { AccountFrame, AccountTx, SettlementDiff, SettlementWorkspace , AccountReplica } from '../../../../types/account';
import type { EntityInput, EntityState , HashToSign } from '../../../types';
import type { EntityTx } from '../../../../types/entity-tx';
import { prepareEntityTxState } from '../../../state-clone';
import { ensureEntityCollectionCandidate } from '../../../state/persistent-collection-map';
import { getAccountPerspective } from '../../../../account/state/perspective';
import { addMessage } from '../../../frame-events';
import { initJBatch, batchAddSettlement } from '../../../../jurisdiction/machine/batch';
import { isLeftEntity } from '../../../id';
import type { EntityRuntimeContext } from '../../../runtime-context';
import { createSettlementHashWithNonce, createDisputeProofHashWithNonce } from '../../../../protocol/dispute/proof-builder';
import { verifyHankoForHash } from '../../../../hanko/signing';
import {
  compileOps,
  getNextSettlementNonce,
  userAutoApprove,
} from '../../../../protocol/settlement/operations';
export { userAutoApprove };
import { createStructuredLogger, shortId } from '../../../../support/logger';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../../../jurisdiction/machine/board-registry';
import {
  assertCanonicalSettlementWorkspace,
  createSettlementWorkspaceHash,
  hasPendingSettlementTransition,
} from '../../../../account/tx/handlers/settlement/transition';
import { projectSettlementDeltaOverrides } from '../../../../account/settlement/settlement-projection';
import { buildAccountProofBodyFromJurisdictions } from '../../../../account/consensus/helpers';


const settleLog = createStructuredLogger('entity.settle');

const buildPostSettlementDisputeProof = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  account: AccountReplica,
  settlementNonce: number,
  diffs: readonly SettlementDiff[],
  forgiveTokenIds: readonly number[],
  proposerIsLeft: boolean,
): { proofBodyHash: string; disputeHash: string; nonce: number; proposerIsLeft: boolean } => {
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction?.depositoryAddress) throw new Error('POST_SETTLEMENT_JURISDICTION_MISSING');
  const nonce = settlementNonce + 1;
  const projectedDeltas = projectSettlementDeltaOverrides(account, diffs, forgiveTokenIds);
  const { proofBodyHash } = buildAccountProofBodyFromJurisdictions(
    env.state,
    account,
    projectedDeltas,
  );
  const disputeHash = createDisputeProofHashWithNonce(
    account.state,
    proofBodyHash,
    { chainId: Number(jurisdiction.chainId), depositoryAddress: jurisdiction.depositoryAddress },
    nonce,
    proposerIsLeft,
  );
  return { proofBodyHash, disputeHash, nonce, proposerIsLeft };
};

type SettlementHankoTx = Extract<
  Extract<AccountTx, { type: 'settle_transition' }>['data'],
  { kind: 'hanko' }
>;

type SettlementHashToSign = HashToSign & { type: 'settlement' | 'dispute' };

type SettlementHankoDraft = {
  tx: Extract<AccountTx, { type: 'settle_transition' }>;
  hashesToSign: SettlementHashToSign[];
};

export const buildSettlementHankoDraft = (
  account: AccountReplica,
  entityState: EntityState,
  counterpartyEntityId: string,
  env: EntityRuntimeContext,
): SettlementHankoDraft => {
  const workspace = account.state.settlementWorkspace;
  if (!workspace) throw new Error('SETTLEMENT_WORKSPACE_MISSING');
  const workspaceHash = assertCanonicalSettlementWorkspace(account.state, workspace);
  if (workspace.status === 'submitted') throw new Error('SETTLEMENT_HANKO_SUBMITTED_FORBIDDEN');
  const { iAmLeft } = getAccountPerspective(account.state, entityState.entityId);
  const existingPostHanko = iAmLeft
    ? workspace.postSettlementDisputeProof?.leftHanko
    : workspace.postSettlementDisputeProof?.rightHanko;
  if (existingPostHanko) throw new Error('SETTLEMENT_SIDE_HANKO_ALREADY_ATTACHED');

  const settlementNonce = workspace.nonceAtSign ?? getNextSettlementNonce(account);
  if (!Number.isSafeInteger(settlementNonce) || settlementNonce < 1) {
    throw new Error(`SETTLEMENT_SIGNED_NONCE_INVALID:${String(settlementNonce)}`);
  }
  const { diffs, forgiveTokenIds } = compileOps(workspace.ops, workspace.lastModifiedByLeft);
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction?.depositoryAddress) throw new Error('SETTLEMENT_JURISDICTION_MISSING');
  const settlementHash = createSettlementHashWithNonce(
    account.state,
    diffs,
    forgiveTokenIds,
    { chainId: Number(jurisdiction.chainId), depositoryAddress: jurisdiction.depositoryAddress },
    settlementNonce,
  );
  if (workspace.settlementHash && workspace.settlementHash.toLowerCase() !== settlementHash.toLowerCase()) {
    throw new Error(`SETTLEMENT_SIGNED_HASH_MISMATCH:${workspace.settlementHash}:${settlementHash}`);
  }
  const postProof = buildPostSettlementDisputeProof(
    env,
    entityState,
    account,
    settlementNonce,
    diffs,
    forgiveTokenIds,
    workspace.lastModifiedByLeft,
  );
  const pinnedPostProof = workspace.postSettlementDisputeProof;
  if (
    pinnedPostProof &&
    (
      pinnedPostProof.nonce !== postProof.nonce ||
      pinnedPostProof.proofBodyHash.toLowerCase() !== postProof.proofBodyHash.toLowerCase() ||
      pinnedPostProof.disputeHash.toLowerCase() !== postProof.disputeHash.toLowerCase()
    )
  ) {
    throw new Error('POST_SETTLEMENT_PROOF_PIN_MISMATCH');
  }

  const sourceIsExecutor = workspace.executorIsLeft === iAmLeft;
  const data: SettlementHankoTx = {
    kind: 'hanko',
    revision: workspace.revision,
    workspaceHash,
    settlementNonce,
    settlementHash,
    postProof,
  };
  const hashesToSign: SettlementHashToSign[] = [
    ...(!sourceIsExecutor
      ? [{
          hash: settlementHash,
          type: 'settlement' as const,
          context: `settlement:${counterpartyEntityId.slice(-8)}:nonce:${settlementNonce}`,
        }]
      : []),
    {
      hash: postProof.disputeHash,
      type: 'dispute',
      context: `settlement:${counterpartyEntityId.slice(-8)}:post-dispute:nonce:${postProof.nonce}`,
    },
  ];
  return { tx: { type: 'settle_transition', data }, hashesToSign };
};

type AccountTxTarget = { accountId: string; tx: import('../../../../types/account').AccountTx };

const assertNoPendingSettlementTransition = (account: AccountReplica): void => {
  if (hasPendingSettlementTransition(account)) throw new Error('SETTLEMENT_TRANSITION_ALREADY_PENDING');
};

const ENTITY_ID_PATTERN = /^0x[0-9a-f]{64}$/;
const MAX_SETTLEMENT_CONTINUATION_ACTIONS = 1;

const assertSettlementContinuation = (
  continuation: NonNullable<Extract<EntityTx, { type: 'settle_propose' }>['data']['continuation']>,
): void => {
  if (!Array.isArray(continuation.actions)) {
    throw new Error('SETTLEMENT_CONTINUATION_ACTIONS_INVALID');
  }
  if (continuation.actions.length > MAX_SETTLEMENT_CONTINUATION_ACTIONS) {
    throw new Error(
      `SETTLEMENT_CONTINUATION_ACTION_LIMIT_EXCEEDED:${continuation.actions.length}`,
    );
  }
  if (typeof continuation.broadcast !== 'boolean') {
    throw new Error('SETTLEMENT_CONTINUATION_BROADCAST_INVALID');
  }
  for (const [index, action] of continuation.actions.entries()) {
    if (!Number.isSafeInteger(action.tokenId) || action.tokenId < 0) {
      throw new Error(`SETTLEMENT_CONTINUATION_TOKEN_INVALID:${index}`);
    }
    if (typeof action.amount !== 'bigint' || action.amount <= 0n) {
      throw new Error(`SETTLEMENT_CONTINUATION_AMOUNT_INVALID:${index}`);
    }
    const ids = action.type === 'r2r'
      ? [action.toEntityId]
      : action.type === 'r2e'
        ? [action.receivingEntity]
        : [action.counterpartyId, ...(action.receivingEntityId ? [action.receivingEntityId] : [])];
    if (ids.some((id) => !ENTITY_ID_PATTERN.test(id))) {
      throw new Error(`SETTLEMENT_CONTINUATION_ENTITY_INVALID:${index}`);
    }
  }
};

/**
 * settle_propose: Queue a new settlement workspace for Account consensus
 */
export async function handleSettlePropose(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_propose' }>,
  _env: EntityRuntimeContext,
  mutableFrameState = false,
): Promise<{ newState: EntityState; outputs: EntityInput[]; accountTxs: AccountTxTarget[] }> {
  const { continuation, counterpartyEntityId, executorIsLeft: execParam, memo, ops } = entityTx.data;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  settleLog.debug('propose.start', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  if (account.state.settlementWorkspace) {
    const revision = account.state.settlementWorkspace.revision;
    addMessage(newState, `⏭️ Settlement propose skipped: workspace already exists (v${revision})`);
    settleLog.warn('propose.skip_workspace_exists', { counterparty: shortId(counterpartyEntityId), revision });
    return { newState, outputs, accountTxs };
  }
  assertNoPendingSettlementTransition(account);

  const isLeft = isLeftEntity(entityState.entityId, counterpartyEntityId);

  // Validate: compileOps runs on proposer path (guard 1)
  compileOps(ops, isLeft);
  // The proposer executes by default. That makes the counterparty's approval
  // the only settlement Hanko accepted on-chain; the executor never submits a
  // signature it created itself.
  const executorIsLeft = execParam ?? isLeft;
  if (continuation) {
    assertSettlementContinuation(continuation);
    if (executorIsLeft !== isLeft) {
      throw new Error('SETTLEMENT_CONTINUATION_REQUIRES_LOCAL_EXECUTOR');
    }
    if (newState.settlementContinuations?.has(counterpartyEntityId)) {
      throw new Error(`SETTLEMENT_CONTINUATION_ALREADY_PENDING:${counterpartyEntityId}`);
    }
    const workspaceHash = createSettlementWorkspaceHash(account.state, {
      revision: 1,
      ops,
      lastModifiedByLeft: isLeft,
      executorIsLeft,
      ...(memo !== undefined ? { memo } : {}),
    });
    newState.settlementContinuations = ensureEntityCollectionCandidate(
      newState.settlementContinuations,
      pending => ({ ...pending, actions: pending.actions.map(action => ({ ...action })) }),
    );
    newState.settlementContinuations.set(counterpartyEntityId, {
      workspaceHash,
      actions: structuredClone(continuation.actions),
      broadcast: continuation.broadcast,
    });
  }
  accountTxs.push({
    accountId: counterpartyEntityId,
    tx: {
      type: 'settle_transition',
      data: {
        kind: 'upsert',
        revision: 1,
        ops,
        executorIsLeft,
        ...(memo !== undefined ? { memo } : {}),
      },
    },
  });

  settleLog.debug('propose.created', { revision: 1, ops: ops.length });
  addMessage(newState, `⚖️ Settlement proposal queued for bilateral Account consensus`);

  return { newState, outputs, accountTxs };
}

/**
 * settle_update: Queue an atomic old-release/new-add workspace replacement
 */
export async function handleSettleUpdate(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_update' }>,
  _env: EntityRuntimeContext,
  mutableFrameState = false,
): Promise<{ newState: EntityState; outputs: EntityInput[]; accountTxs: AccountTxTarget[] }> {
  const { counterpartyEntityId, executorIsLeft: execParam, memo, ops } = entityTx.data;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  settleLog.debug('update.start', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  if (!account.state.settlementWorkspace) throw new Error(`No settlement workspace to update. Use settle_propose first.`);
  assertNoPendingSettlementTransition(account);

  // Guard 2: Cannot update after signing
  if (account.state.settlementWorkspace.leftHanko || account.state.settlementWorkspace.rightHanko) {
    throw new Error(`Cannot update after signing. Use settle_reject to start over.`);
  }

  const isLeft = isLeftEntity(entityState.entityId, counterpartyEntityId);

  // Validate new ops (guard 1: dual-side validation)
  compileOps(ops, isLeft);
  const workspace = account.state.settlementWorkspace;
  const previousWorkspaceHash = assertCanonicalSettlementWorkspace(account.state, workspace);
  const newVersion = workspace.revision + 1;
  const effectiveMemo = memo !== undefined ? memo : workspace.memo;
  accountTxs.push({
    accountId: counterpartyEntityId,
    tx: {
      type: 'settle_transition',
      data: {
        kind: 'upsert',
        revision: newVersion,
        previousWorkspaceHash,
        ops,
        executorIsLeft: execParam ?? workspace.executorIsLeft,
        ...(effectiveMemo !== undefined ? { memo: effectiveMemo } : {}),
      },
    },
  });

  settleLog.debug('update.applied', { revision: newVersion, ops: ops.length });
  addMessage(newState, `⚖️ Settlement update v${newVersion} queued for bilateral Account consensus`);

  return { newState, outputs, accountTxs };
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
  _env: EntityRuntimeContext,
  mutableFrameState = false,
): Promise<{ newState: EntityState; outputs: EntityInput[]; accountTxs: AccountTxTarget[]; hashesToSign?: Array<{ hash: string; type: 'settlement' | 'dispute'; context: string }> }> {
  const { counterpartyEntityId, workspaceHash: requestedWorkspaceHash } = entityTx.data;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  settleLog.debug('approve.start', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  if (!account.state.settlementWorkspace) throw new Error(`No settlement workspace to approve.`);
  assertNoPendingSettlementTransition(account);
  if (account.state.settlementWorkspace.status === 'submitted') {
    addMessage(newState, `⏭️ settle_execute skipped: workspace already submitted`);
    settleLog.debug('execute.skip_already_submitted', { counterparty: shortId(counterpartyEntityId) });
    return { newState, outputs, accountTxs };
  }
  const canonicalWorkspaceHash = assertCanonicalSettlementWorkspace(
    account.state,
    account.state.settlementWorkspace,
  );
  if (requestedWorkspaceHash !== canonicalWorkspaceHash) {
    throw new Error(
      `SETTLEMENT_APPROVAL_WORKSPACE_HASH_MISMATCH:${requestedWorkspaceHash}:${canonicalWorkspaceHash}`,
    );
  }
  newState.deferredAccountProposals = ensureEntityCollectionCandidate(
    newState.deferredAccountProposals,
    value => value,
  );
  const existing = newState.deferredAccountProposals.get(counterpartyEntityId);
  if (existing && existing !== canonicalWorkspaceHash) {
    throw new Error(`SETTLEMENT_APPROVAL_ALREADY_DEFERRED:${existing}:${canonicalWorkspaceHash}`);
  }
  newState.deferredAccountProposals.set(counterpartyEntityId, canonicalWorkspaceHash);
  settleLog.debug('approve.deferred_until_account_idle', {
    side: getAccountPerspective(account.state, entityState.entityId).iAmLeft ? 'left' : 'right',
    workspaceHash: canonicalWorkspaceHash,
  });
  addMessage(newState, `⚖️ Settlement approval accepted; waiting for prior Account work`);
  return { newState, outputs, accountTxs };
}

/**
 * settle_execute: Recompile from ops (guard 4), assert match, submit to jBatch
 */
const assertCompiledSettlementDiffs = (
  workspace: SettlementWorkspace,
  diffs: readonly SettlementDiff[],
): void => {
  const cached = workspace.compiledDiffs;
  if (!cached) return;
  if (diffs.length !== cached.length) {
    throw new Error(`Recompiled diffs length mismatch: ${diffs.length} vs ${cached.length}`);
  }
  for (let index = 0; index < diffs.length; index += 1) {
    const next = diffs[index];
    const previous = cached[index];
    if (!next || !previous) throw new Error(`Recompiled diff missing at index ${index}`);
    if (
      next.tokenId !== previous.tokenId ||
      next.leftDiff !== previous.leftDiff ||
      next.rightDiff !== previous.rightDiff ||
      next.collateralDiff !== previous.collateralDiff ||
      next.ondeltaDiff !== previous.ondeltaDiff
    ) {
      throw new Error(`Recompiled diff mismatch at index ${index}`);
    }
  }
};

const prepareSettlementExecution = (
  env: EntityRuntimeContext,
  entityState: EntityState,
  account: AccountReplica,
  workspace: SettlementWorkspace,
) => {
  const { diffs, forgiveTokenIds } = compileOps(
    workspace.ops,
    workspace.lastModifiedByLeft,
  );
  assertCompiledSettlementDiffs(workspace, diffs);
  const signedNonce = workspace.nonceAtSign;
  if (
    typeof signedNonce !== 'number' ||
    !Number.isSafeInteger(signedNonce) ||
    signedNonce < 1
  ) {
    throw new Error(`SETTLEMENT_SIGNED_NONCE_MISSING:${String(signedNonce)}`);
  }
  if (!workspace.settlementHash) throw new Error('SETTLEMENT_SIGNED_HASH_MISSING');
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction?.depositoryAddress || !jurisdiction.entityProviderAddress) {
    throw new Error('SETTLEMENT_JURISDICTION_MISSING');
  }
  const expectedSettlementHash = createSettlementHashWithNonce(
    account.state,
    diffs,
    forgiveTokenIds,
    {
      chainId: Number(jurisdiction.chainId),
      depositoryAddress: jurisdiction.depositoryAddress,
    },
    signedNonce,
  );
  if (expectedSettlementHash.toLowerCase() !== workspace.settlementHash.toLowerCase()) {
    throw new Error(
      `SETTLEMENT_SIGNED_HASH_MISMATCH:${workspace.settlementHash}:` +
      expectedSettlementHash,
    );
  }
  if (workspace.status !== 'ready_to_submit') {
    throw new Error(`SETTLEMENT_HANKOS_INCOMPLETE:${workspace.status}`);
  }
  const postProof = workspace.postSettlementDisputeProof;
  if (!postProof || postProof.nonce !== signedNonce + 1) {
    throw new Error(
      `POST_SETTLEMENT_PROOF_NONCE_MISMATCH:${String(postProof?.nonce)}:` +
      `${signedNonce + 1}`,
    );
  }
  const expectedPostProof = buildPostSettlementDisputeProof(
    env,
    entityState,
    account,
    signedNonce,
    diffs,
    forgiveTokenIds,
    postProof.proposerIsLeft,
  );
  if (
    postProof.proofBodyHash.toLowerCase() !== expectedPostProof.proofBodyHash.toLowerCase() ||
    postProof.disputeHash.toLowerCase() !== expectedPostProof.disputeHash.toLowerCase() ||
    postProof.proposerIsLeft !== expectedPostProof.proposerIsLeft
  ) {
    throw new Error('POST_SETTLEMENT_PROOF_HASH_MISMATCH');
  }
  if (!postProof.leftHanko || !postProof.rightHanko) {
    throw new Error('POST_SETTLEMENT_PROOF_HANKO_MISSING');
  }
  return {
    diffs,
    forgiveTokenIds,
    signedNonce,
    expectedSettlementHash,
    expectedPostProof,
    postProof,
    jurisdiction,
  };
};

type PreparedSettlementExecution = ReturnType<typeof prepareSettlementExecution>;

/**
 * Board authority for a settlement Hanko.
 *
 * `freshMovement` mirrors `Account.sol:894` (cooperative settlement) and
 * `Account.sol:790` (C2R): a cooperative settlement creates new financial
 * state, so only the counterparty's *current* board may authorize it. Accepting
 * a rotated-out board off-chain would commit a bilateral state that
 * `verifyCurrentHankoSignature` then rejects on-chain, leaving the off-chain
 * channel ahead of settled truth.
 *
 * `historicalEvidence` is the post-settlement dispute proof. That is evidence
 * about a state the previous board legitimately signed, and `Account.sol:1063`
 * accepts it for the full grace window, so the runtime must too.
 */
type SettlementHankoAuthority = 'freshMovement' | 'historicalEvidence';

const verifySettlementHanko = async (
  env: EntityRuntimeContext,
  entityState: EntityState,
  hanko: string,
  hash: string,
  entityId: string,
  context: string,
  authority: SettlementHankoAuthority,
): Promise<void> => {
  const boardHash = resolveObserverCertifiedBoardHash(
    entityState,
    getCertifiedBoardNodeStore(env),
    entityId,
  );
  const allowPreviousBoard = authority === 'historicalEvidence';
  const verified = await verifyHankoForHash(
    hanko as import('../../../../types/hanko').HankoString,
    hash,
    entityId,
    env,
    {
      ...(boardHash ? { registeredBoardHash: boardHash } : {}),
      allowPreviousBoard,
      observerState: entityState,
    },
  );
  if (!verified.valid || verified.entityId?.toLowerCase() !== entityId.toLowerCase()) {
    throw new Error(`${context}_HANKO_INVALID`);
  }
};

const verifySettlementExecutionHankos = async (
  env: EntityRuntimeContext,
  entityState: EntityState,
  account: AccountReplica,
  counterpartyEntityId: string,
  counterpartyHanko: string,
  prepared: PreparedSettlementExecution,
): Promise<void> => {
  await verifySettlementHanko(
    env,
    entityState,
    counterpartyHanko,
    prepared.expectedSettlementHash,
    counterpartyEntityId,
    'SETTLEMENT_NONEXECUTOR',
    'freshMovement',
  );
  await verifySettlementHanko(
    env,
    entityState,
    prepared.postProof.leftHanko!,
    prepared.expectedPostProof.disputeHash,
    account.state.leftEntity,
    'POST_SETTLEMENT_LEFT',
    'historicalEvidence',
  );
  await verifySettlementHanko(
    env,
    entityState,
    prepared.postProof.rightHanko!,
    prepared.expectedPostProof.disputeHash,
    account.state.rightEntity,
    'POST_SETTLEMENT_RIGHT',
    'historicalEvidence',
  );
};

const queueSettlementExecution = (
  state: EntityState,
  counterpartyEntityId: string,
  counterpartyHanko: string,
  disableC2RShortcut: boolean,
  prepared: PreparedSettlementExecution,
): boolean => {
  state.jBatchState ??= initJBatch();
  // A nonce-bound settlement cannot wait behind another on-chain batch:
  // finalizing that batch can invalidate every signature prepared here.
  if (state.jBatchState.sentBatch) {
    addMessage(state, '⏭️ settle_execute skipped: jBatch sentBatch pending');
    settleLog.warn('execute.skip_sent_batch_pending', {
      counterparty: shortId(counterpartyEntityId),
    });
    return false;
  }
  const entityIsLeft = isLeftEntity(state.entityId, counterpartyEntityId);
  const leftEntity = entityIsLeft ? state.entityId : counterpartyEntityId;
  const rightEntity = entityIsLeft ? counterpartyEntityId : state.entityId;
  batchAddSettlement(
    state.jBatchState,
    leftEntity,
    rightEntity,
    prepared.diffs,
    prepared.forgiveTokenIds,
    counterpartyHanko,
    prepared.signedNonce,
    state.entityId,
    disableC2RShortcut,
  );
  return true;
};

export async function handleSettleExecute(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_execute' }>,
  env: EntityRuntimeContext,
  mutableFrameState = false,
): Promise<{ newState: EntityState; outputs: EntityInput[]; accountTxs: AccountTxTarget[] }> {
  const { counterpartyEntityId, disableC2RShortcut = false } = entityTx.data;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  settleLog.debug('execute.start', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) {
    addMessage(newState, `⏭️ settle_execute skipped: no account with ${counterpartyEntityId.slice(-4)}`);
    settleLog.warn('execute.skip_no_account', { counterparty: shortId(counterpartyEntityId) });
    return { newState, outputs, accountTxs };
  }
  if (!account.state.settlementWorkspace) {
    addMessage(newState, `⏭️ settle_execute skipped: no workspace with ${counterpartyEntityId.slice(-4)}`);
    settleLog.warn('execute.skip_no_workspace', { counterparty: shortId(counterpartyEntityId) });
    return { newState, outputs, accountTxs };
  }

  const workspace = account.state.settlementWorkspace;
  assertNoPendingSettlementTransition(account);
  const workspaceHash = assertCanonicalSettlementWorkspace(account.state, workspace);
  if (workspace.status === 'submitted') {
    addMessage(newState, `⏭️ settle_execute skipped: settlement already submitted`);
    settleLog.warn('execute.skip_already_submitted', { counterparty: shortId(counterpartyEntityId) });
    return { newState, outputs, accountTxs };
  }

  const { iAmLeft } = getAccountPerspective(account.state, entityState.entityId);
  if (workspace.executorIsLeft !== iAmLeft) {
    throw new Error(`SETTLEMENT_EXECUTOR_MISMATCH:expected=${workspace.executorIsLeft ? 'left' : 'right'}`);
  }
  const counterpartyHanko = iAmLeft ? workspace.rightHanko : workspace.leftHanko;
  if (!counterpartyHanko) {
    addMessage(newState, `⏭️ settle_execute skipped: missing counterparty signature`);
    settleLog.warn('execute.skip_missing_counterparty_hanko', { counterparty: shortId(counterpartyEntityId), iAmLeft });
    return { newState, outputs, accountTxs };
  }
  const prepared = prepareSettlementExecution(
    env,
    entityState,
    account,
    workspace,
  );
  await verifySettlementExecutionHankos(
    env,
    entityState,
    account,
    counterpartyEntityId,
    counterpartyHanko,
    prepared,
  );
  if (
    !queueSettlementExecution(
      newState,
      counterpartyEntityId,
      counterpartyHanko,
      disableC2RShortcut,
      prepared,
    )
  ) {
    return { newState, outputs, accountTxs };
  }
  settleLog.debug('execute.j_batch_added', { diffs: prepared.diffs.length });

  accountTxs.push({
    accountId: counterpartyEntityId,
    tx: {
      type: 'settle_transition',
      data: {
        kind: 'submit',
        revision: workspace.revision,
        workspaceHash,
      },
    },
  });
  addMessage(
    newState,
    `✅ Settlement submission queued (${prepared.diffs.length} diffs) - use j_broadcast to commit`,
  );

  return { newState, outputs, accountTxs };
}

/**
 * settle_reject: Queue an exact workspace clear without executing
 */
export async function handleSettleReject(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_reject' }>,
  _env: EntityRuntimeContext,
  mutableFrameState = false,
): Promise<{ newState: EntityState; outputs: EntityInput[]; accountTxs: AccountTxTarget[] }> {
  const { counterpartyEntityId, reason } = entityTx.data;
  const newState = prepareEntityTxState(entityState, mutableFrameState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  settleLog.debug('reject.start', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);

  if (!account.state.settlementWorkspace) {
    settleLog.debug('reject.no_workspace', { counterparty: shortId(counterpartyEntityId) });
    return { newState, outputs, accountTxs };
  }
  assertNoPendingSettlementTransition(account);
  if (
    account.state.settlementWorkspace.settlementHash ||
    account.state.settlementWorkspace.leftHanko ||
    account.state.settlementWorkspace.rightHanko ||
    account.state.settlementWorkspace.postSettlementDisputeProof
  ) {
    throw new Error('SETTLEMENT_REJECT_SIGNED_FORBIDDEN');
  }
  const workspaceHash = assertCanonicalSettlementWorkspace(account.state, account.state.settlementWorkspace);
  accountTxs.push({
    accountId: counterpartyEntityId,
    tx: {
      type: 'settle_transition',
      data: {
        kind: 'clear',
        revision: account.state.settlementWorkspace.revision,
        workspaceHash,
      },
    },
  });

  settleLog.debug('reject.queued');
  addMessage(newState, `❌ Settlement clear queued${reason ? `: ${reason}` : ''}`);

  return { newState, outputs, accountTxs };
}

type CommittedSettlementFollowup = {
  outputs: EntityInput[];
  accountTxs: AccountTxTarget[];
  hashesToSign: SettlementHashToSign[];
};

/**
 * An automatic counterparty approval is derived only after the upsert Account
 * frame commits. Before that point the workspace is merely local mempool intent
 * and must not be signed or used as canonical settlement state.
 */
export async function processCommittedSettlementTransitionFollowup(
  account: AccountReplica,
  accountTx: AccountTx,
  committedFrame: AccountFrame,
  proposerIsLeft: boolean,
  counterpartyEntityId: string,
  entityState: EntityState,
  _env: EntityRuntimeContext,
): Promise<CommittedSettlementFollowup> {
  const empty = (): CommittedSettlementFollowup => ({ outputs: [], accountTxs: [], hashesToSign: [] });
  if (
    accountTx.type !== 'settle_transition' ||
    (accountTx.data.kind !== 'upsert' && accountTx.data.kind !== 'hanko')
  ) return empty();
  const transitionIndex = committedFrame.accountTxs.indexOf(accountTx);
  if (transitionIndex < 0) throw new Error('SETTLEMENT_COMMITTED_TX_NOT_IN_FRAME');
  const hasLaterTransition = committedFrame.accountTxs
    .slice(transitionIndex + 1)
    .some((tx) => tx.type === 'settle_transition');
  // Account transactions apply sequentially. A single valid frame may replace
  // a workspace more than once; only its final transition describes committed
  // post-state and may trigger a signature. Signing an earlier upsert against
  // final post-state would either fail the Entity frame or authorize stale ops.
  if (hasLaterTransition) return empty();
  const workspace = account.state.settlementWorkspace;
  if (!workspace) throw new Error('SETTLEMENT_COMMITTED_WORKSPACE_MISSING');
  const workspaceHash = assertCanonicalSettlementWorkspace(account.state, workspace);
  if (workspace.revision !== accountTx.data.revision) {
    throw new Error(`SETTLEMENT_COMMITTED_VERSION_MISMATCH:${workspace.revision}:${accountTx.data.revision}`);
  }
  const { iAmLeft } = getAccountPerspective(account.state, entityState.entityId);
  if (proposerIsLeft === iAmLeft) return empty();
  const localPostHanko = iAmLeft
    ? workspace.postSettlementDisputeProof?.leftHanko
    : workspace.postSettlementDisputeProof?.rightHanko;
  if (localPostHanko || hasPendingSettlementTransition(account)) return empty();

  // A side may attach its Hanko automatically only when the exact ops are locally safe, or
  // when that side authored the already-committed workspace body. Forgiveness
  // therefore always waits for one explicit counterparty approval.
  const locallyAuthored = workspace.lastModifiedByLeft === iAmLeft;
  if (!locallyAuthored && !canAutoApproveWorkspace(workspace, iAmLeft)) return empty();

  settleLog.debug('committed.auto_hanko.start', {
    from: shortId(counterpartyEntityId),
    revision: workspace.revision,
    workspaceHash,
  });
  entityState.deferredAccountProposals = ensureEntityCollectionCandidate(
    entityState.deferredAccountProposals,
    value => value,
  );
  const existing = entityState.deferredAccountProposals.get(counterpartyEntityId);
  if (existing && existing !== workspaceHash) {
    throw new Error(`SETTLEMENT_APPROVAL_ALREADY_DEFERRED:${existing}:${workspaceHash}`);
  }
  entityState.deferredAccountProposals.set(counterpartyEntityId, workspaceHash);
  return empty();
}

/**
 * Auto-approve logic for end users (operates on compiled diffs)
 */
/**
 * Check if workspace ops are safe to auto-approve (compiles then checks)
 */
export function canAutoApproveWorkspace(workspace: SettlementWorkspace, iAmLeft: boolean): boolean {
  // Forgiveness and rawDiff are explicit bilateral escape hatches. In
  // particular, rawDiff can move collateral ownership through ondelta while
  // leaving total collateral and reserves unchanged; no generic safety
  // predicate may turn that proposal into the counterparty's signature.
  if (workspace.ops.some((op) => op.type === 'forgive' || op.type === 'rawDiff')) return false;
  const { diffs } = compileOps(workspace.ops, workspace.lastModifiedByLeft);
  return diffs.every(diff => userAutoApprove(diff, iAmLeft));
}
