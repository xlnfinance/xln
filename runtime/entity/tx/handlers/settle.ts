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

import type {
  AccountFrame,
  AccountTx,
  EntityInput,
  EntityState,
  EntityTx,
  SettlementDiff,
  SettlementWorkspace,
} from '../../../types';
import { cloneEntityState } from '../../../state-helpers';
import { getAccountPerspective } from '../../../account/perspective';
import { addMessage } from '../../frame-events';
import { initJBatch, batchAddSettlement } from '../../../jurisdiction/batch';
import { isLeftEntity } from '../../id';
import type { RuntimeState, HashToSign } from '../../../types';
import { createSettlementHashWithNonce, createDisputeProofHashWithNonce } from '../../../protocol/dispute/proof-builder';
import { verifyHankoForHash } from '../../../hanko/signing';
import {
  compileOps,
  getNextSettlementNonce,
  userAutoApprove,
} from '../../../protocol/settlement/operations';
export { userAutoApprove };
import { createStructuredLogger, shortId } from '../../../infra/logger';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../../jurisdiction/board-registry';
import {
  assertCanonicalSettlementWorkspace,
  hasPendingSettlementTransition,
} from '../../../account/tx/handlers/settle-transition';
import { projectAccountAfterSettlement } from '../../../account/settlement-projection';
import { buildAccountProofBodyFromEnv } from '../../../account/consensus/helpers';

import type { AccountState } from '../../../types';

const settleLog = createStructuredLogger('entity.settle');

const buildPostSettlementDisputeProof = (
  env: RuntimeState,
  entityState: EntityState,
  account: AccountState,
  settlementNonce: number,
  diffs: readonly SettlementDiff[],
  forgiveTokenIds: readonly number[],
): { proofBodyHash: string; disputeHash: string; nonce: number } => {
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction?.depositoryAddress) throw new Error('POST_SETTLEMENT_JURISDICTION_MISSING');
  const nonce = settlementNonce + 1;
  const projected = projectAccountAfterSettlement(account, diffs, forgiveTokenIds);
  const { proofBodyHash } = buildAccountProofBodyFromEnv(env, projected);
  const disputeHash = createDisputeProofHashWithNonce(
    account,
    proofBodyHash,
    { chainId: Number(jurisdiction.chainId), depositoryAddress: jurisdiction.depositoryAddress },
    nonce,
  );
  return { proofBodyHash, disputeHash, nonce };
};

type SettlementSealTx = Extract<
  Extract<AccountTx, { type: 'settle_transition' }>['data'],
  { kind: 'seal' }
>;

type SettlementHashToSign = HashToSign & { type: 'settlement' | 'dispute' };

type SettlementSealDraft = {
  tx: Extract<AccountTx, { type: 'settle_transition' }>;
  hashesToSign: SettlementHashToSign[];
};

export const buildSettlementSealDraft = (
  account: AccountState,
  entityState: EntityState,
  counterpartyEntityId: string,
  env: RuntimeState,
): SettlementSealDraft => {
  const workspace = account.settlementWorkspace;
  if (!workspace) throw new Error('SETTLEMENT_WORKSPACE_MISSING');
  const workspaceHash = assertCanonicalSettlementWorkspace(account, workspace);
  if (workspace.status === 'submitted') throw new Error('SETTLEMENT_SEAL_SUBMITTED_FORBIDDEN');
  const { iAmLeft } = getAccountPerspective(account, entityState.entityId);
  const existingPostHanko = iAmLeft
    ? workspace.postSettlementDisputeProof?.leftHanko
    : workspace.postSettlementDisputeProof?.rightHanko;
  if (existingPostHanko) throw new Error('SETTLEMENT_SIDE_ALREADY_SEALED');

  const settlementNonce = workspace.nonceAtSign ?? getNextSettlementNonce(account);
  if (!Number.isSafeInteger(settlementNonce) || settlementNonce < 1) {
    throw new Error(`SETTLEMENT_SIGNED_NONCE_INVALID:${String(settlementNonce)}`);
  }
  const { diffs, forgiveTokenIds } = compileOps(workspace.ops, workspace.lastModifiedByLeft);
  const jurisdiction = entityState.config.jurisdiction;
  if (!jurisdiction?.depositoryAddress) throw new Error('SETTLEMENT_JURISDICTION_MISSING');
  const settlementHash = createSettlementHashWithNonce(
    account,
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
  const data: SettlementSealTx = {
    kind: 'seal',
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

type AccountTxTarget = { accountId: string; tx: import('../../../types').AccountTx };

const assertNoPendingSettlementTransition = (account: AccountState): void => {
  if (hasPendingSettlementTransition(account)) throw new Error('SETTLEMENT_TRANSITION_ALREADY_PENDING');
};

/**
 * settle_propose: Queue a new settlement workspace for Account consensus
 */
export async function handleSettlePropose(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_propose' }>,
  _env: RuntimeState
): Promise<{ newState: EntityState; outputs: EntityInput[]; accountTxs: AccountTxTarget[] }> {
  const { counterpartyEntityId, executorIsLeft: execParam, memo, ops } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  settleLog.debug('propose.start', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  if (account.settlementWorkspace) {
    const revision = account.settlementWorkspace.revision;
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
  _env: RuntimeState
): Promise<{ newState: EntityState; outputs: EntityInput[]; accountTxs: AccountTxTarget[] }> {
  const { counterpartyEntityId, executorIsLeft: execParam, memo, ops } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  settleLog.debug('update.start', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  if (!account.settlementWorkspace) throw new Error(`No settlement workspace to update. Use settle_propose first.`);
  assertNoPendingSettlementTransition(account);

  // Guard 2: Cannot update after signing
  if (account.settlementWorkspace.leftHanko || account.settlementWorkspace.rightHanko) {
    throw new Error(`Cannot update after signing. Use settle_reject to start over.`);
  }

  const isLeft = isLeftEntity(entityState.entityId, counterpartyEntityId);

  // Validate new ops (guard 1: dual-side validation)
  compileOps(ops, isLeft);
  const workspace = account.settlementWorkspace;
  const previousWorkspaceHash = assertCanonicalSettlementWorkspace(account, workspace);
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
  _env: RuntimeState
): Promise<{ newState: EntityState; outputs: EntityInput[]; accountTxs: AccountTxTarget[]; hashesToSign?: Array<{ hash: string; type: 'settlement' | 'dispute'; context: string }> }> {
  const { counterpartyEntityId, workspaceHash: requestedWorkspaceHash } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  settleLog.debug('approve.start', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);
  if (!account.settlementWorkspace) throw new Error(`No settlement workspace to approve.`);
  assertNoPendingSettlementTransition(account);
  if (account.settlementWorkspace.status === 'submitted') {
    addMessage(newState, `⏭️ settle_execute skipped: workspace already submitted`);
    settleLog.debug('execute.skip_already_submitted', { counterparty: shortId(counterpartyEntityId) });
    return { newState, outputs, accountTxs };
  }
  const canonicalWorkspaceHash = assertCanonicalSettlementWorkspace(
    account,
    account.settlementWorkspace,
  );
  if (requestedWorkspaceHash !== canonicalWorkspaceHash) {
    throw new Error(
      `SETTLEMENT_APPROVAL_WORKSPACE_HASH_MISMATCH:${requestedWorkspaceHash}:${canonicalWorkspaceHash}`,
    );
  }
  newState.deferredAccountProposals ??= new Map();
  const existing = newState.deferredAccountProposals.get(counterpartyEntityId);
  if (existing && existing !== canonicalWorkspaceHash) {
    throw new Error(`SETTLEMENT_APPROVAL_ALREADY_DEFERRED:${existing}:${canonicalWorkspaceHash}`);
  }
  newState.deferredAccountProposals.set(counterpartyEntityId, canonicalWorkspaceHash);
  settleLog.debug('approve.deferred_until_account_idle', {
    side: getAccountPerspective(account, entityState.entityId).iAmLeft ? 'left' : 'right',
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
  env: RuntimeState,
  entityState: EntityState,
  account: AccountState,
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
    account,
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
    throw new Error(`SETTLEMENT_NOT_FULLY_SEALED:${workspace.status}`);
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
  );
  if (
    postProof.proofBodyHash.toLowerCase() !== expectedPostProof.proofBodyHash.toLowerCase() ||
    postProof.disputeHash.toLowerCase() !== expectedPostProof.disputeHash.toLowerCase()
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

const verifySettlementHanko = async (
  env: RuntimeState,
  entityState: EntityState,
  hanko: string,
  hash: string,
  entityId: string,
  context: string,
): Promise<void> => {
  const boardHash = resolveObserverCertifiedBoardHash(
    entityState,
    getCertifiedBoardNodeStore(env),
    entityId,
  );
  const verified = await verifyHankoForHash(
    hanko as import('../../../types').HankoString,
    hash,
    entityId,
    env,
    boardHash ? { registeredBoardHash: boardHash } : undefined,
  );
  if (!verified.valid || verified.entityId?.toLowerCase() !== entityId.toLowerCase()) {
    throw new Error(`${context}_HANKO_INVALID`);
  }
};

const verifySettlementExecutionHankos = async (
  env: RuntimeState,
  entityState: EntityState,
  account: AccountState,
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
  );
  await verifySettlementHanko(
    env,
    entityState,
    prepared.postProof.leftHanko!,
    prepared.expectedPostProof.disputeHash,
    account.leftEntity,
    'POST_SETTLEMENT_LEFT',
  );
  await verifySettlementHanko(
    env,
    entityState,
    prepared.postProof.rightHanko!,
    prepared.expectedPostProof.disputeHash,
    account.rightEntity,
    'POST_SETTLEMENT_RIGHT',
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
  try {
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
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('pending broadcast')) {
      throw error;
    }
    addMessage(state, '⏭️ settle_execute skipped: jBatch sentBatch pending');
    settleLog.warn('execute.skip_pending_broadcast', {
      counterparty: shortId(counterpartyEntityId),
    });
    return false;
  }
  return true;
};

export async function handleSettleExecute(
  entityState: EntityState,
  entityTx: Extract<EntityTx, { type: 'settle_execute' }>,
  env: RuntimeState
): Promise<{ newState: EntityState; outputs: EntityInput[]; accountTxs: AccountTxTarget[] }> {
  const { counterpartyEntityId, disableC2RShortcut = false } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  settleLog.debug('execute.start', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) {
    addMessage(newState, `⏭️ settle_execute skipped: no account with ${counterpartyEntityId.slice(-4)}`);
    settleLog.warn('execute.skip_no_account', { counterparty: shortId(counterpartyEntityId) });
    return { newState, outputs, accountTxs };
  }
  if (!account.settlementWorkspace) {
    addMessage(newState, `⏭️ settle_execute skipped: no workspace with ${counterpartyEntityId.slice(-4)}`);
    settleLog.warn('execute.skip_no_workspace', { counterparty: shortId(counterpartyEntityId) });
    return { newState, outputs, accountTxs };
  }

  const workspace = account.settlementWorkspace;
  assertNoPendingSettlementTransition(account);
  const workspaceHash = assertCanonicalSettlementWorkspace(account, workspace);
  if (workspace.status === 'submitted') {
    addMessage(newState, `⏭️ settle_execute skipped: settlement already submitted`);
    settleLog.warn('execute.skip_already_submitted', { counterparty: shortId(counterpartyEntityId) });
    return { newState, outputs, accountTxs };
  }

  const { iAmLeft } = getAccountPerspective(account, entityState.entityId);
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
  _env: RuntimeState
): Promise<{ newState: EntityState; outputs: EntityInput[]; accountTxs: AccountTxTarget[] }> {
  const { counterpartyEntityId, reason } = entityTx.data;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  const accountTxs: AccountTxTarget[] = [];

  settleLog.debug('reject.start', { entity: shortId(entityState.entityId), counterparty: shortId(counterpartyEntityId) });

  const account = newState.accounts.get(counterpartyEntityId);
  if (!account) throw new Error(`No account with ${counterpartyEntityId.slice(-4)}`);

  if (!account.settlementWorkspace) {
    settleLog.debug('reject.no_workspace', { counterparty: shortId(counterpartyEntityId) });
    return { newState, outputs, accountTxs };
  }
  assertNoPendingSettlementTransition(account);
  if (
    account.settlementWorkspace.settlementHash ||
    account.settlementWorkspace.leftHanko ||
    account.settlementWorkspace.rightHanko ||
    account.settlementWorkspace.postSettlementDisputeProof
  ) {
    throw new Error('SETTLEMENT_REJECT_SIGNED_FORBIDDEN');
  }
  const workspaceHash = assertCanonicalSettlementWorkspace(account, account.settlementWorkspace);
  accountTxs.push({
    accountId: counterpartyEntityId,
    tx: {
      type: 'settle_transition',
      data: {
        kind: 'clear',
        revision: account.settlementWorkspace.revision,
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
  account: AccountState,
  accountTx: AccountTx,
  committedFrame: AccountFrame,
  counterpartyEntityId: string,
  entityState: EntityState,
  _env: RuntimeState,
): Promise<CommittedSettlementFollowup> {
  const empty = (): CommittedSettlementFollowup => ({ outputs: [], accountTxs: [], hashesToSign: [] });
  if (
    accountTx.type !== 'settle_transition' ||
    (accountTx.data.kind !== 'upsert' && accountTx.data.kind !== 'seal')
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
  if (typeof committedFrame.byLeft !== 'boolean') throw new Error('SETTLEMENT_COMMITTED_FRAME_SIDE_MISSING');
  const workspace = account.settlementWorkspace;
  if (!workspace) throw new Error('SETTLEMENT_COMMITTED_WORKSPACE_MISSING');
  const workspaceHash = assertCanonicalSettlementWorkspace(account, workspace);
  if (workspace.revision !== accountTx.data.revision) {
    throw new Error(`SETTLEMENT_COMMITTED_VERSION_MISMATCH:${workspace.revision}:${accountTx.data.revision}`);
  }
  const { iAmLeft } = getAccountPerspective(account, entityState.entityId);
  if (committedFrame.byLeft === iAmLeft) return empty();
  const localPostHanko = iAmLeft
    ? workspace.postSettlementDisputeProof?.leftHanko
    : workspace.postSettlementDisputeProof?.rightHanko;
  if (localPostHanko || hasPendingSettlementTransition(account)) return empty();

  // A side may seal automatically only when the exact ops are locally safe, or
  // when that side authored the already-committed workspace body. Forgiveness
  // therefore always waits for one explicit counterparty approval.
  const locallyAuthored = workspace.lastModifiedByLeft === iAmLeft;
  if (!locallyAuthored && !canAutoApproveWorkspace(workspace, iAmLeft)) return empty();

  settleLog.debug('committed.auto_seal.start', {
    from: shortId(counterpartyEntityId),
    revision: workspace.revision,
    workspaceHash,
  });
  entityState.deferredAccountProposals ??= new Map();
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
  if (workspace.ops.some((op) => op.type === 'forgive')) return false;
  const { diffs } = compileOps(workspace.ops, workspace.lastModifiedByLeft);
  return diffs.every(diff => userAutoApprove(diff, iAmLeft));
}
