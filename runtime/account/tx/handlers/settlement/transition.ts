import { ethers } from 'ethers';

import type { AccountReplica, AccountState, AccountTx, SettlementDiff, SettlementOp, SettlementWorkspace } from '../../../../types/account';
import { cloneAccountReplica } from '../../../state/state-clone';
import { computeCanonicalMerkleRoot } from '../../../commitment/state-root';
import { deriveDelta } from '../../../utils';
import {
  assertSettlementTokenId,
  compileOps,
  getMinimumSafeSettlementNonce,
} from '../../../../protocol/settlement/operations';
import { createStructuredLogger } from '../../../../infra/logger';
import { addHold, getHold, releaseHold } from '../../hold-utils';
import {
  createDisputeProofHashWithNonce,
  createSettlementHashWithNonce,
} from '../../../../protocol/dispute/proof-builder';
import { buildAccountProofBodyFromJurisdictions, getAccountStateDomain } from '../../../consensus/helpers';
import type { AccountConsensusContext } from '../../../consensus/context';
import {
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../../../../protocol/dispute/arguments';
import { projectAccountAfterSettlement } from '../../../settlement/settlement-projection';
import type {
  AccountTxRejection,
  ApplyAccountTxResult,
} from '../../apply-types';

type SettleTransitionTx = Extract<AccountTx, { type: 'settle_transition' }>;
type UpsertTransition = Extract<SettleTransitionTx['data'], { kind: 'upsert' }>;

export const hasPendingSettlementTransition = (
  account: Pick<AccountReplica, 'mempool' | 'pendingFrame'>,
): boolean =>
  account.mempool.some((tx) => tx.type === 'settle_transition') ||
  Boolean(account.pendingFrame?.accountTxs.some((tx) => tx.type === 'settle_transition'));

type HoldPlan = Readonly<{
  tokenId: number;
  left: bigint;
  right: bigint;
}>;

const transitionLog = createStructuredLogger('account.settle');
const WORKSPACE_DOMAIN = 'xln:settlement-workspace:v1';

class SettlementSealNonceMismatchError extends Error {
  readonly rejection: AccountTxRejection;

  constructor(
    message: string,
    suppliedNonce: number,
    requiredNonce: number,
    basis: AccountTxRejection['basis'],
  ) {
    super(message);
    this.rejection = {
      kind: 'settlement_seal_nonce_mismatch',
      suppliedNonce,
      requiredNonce,
      basis,
    };
  }
}

const assertVersion = (revision: number): void => {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`SETTLEMENT_WORKSPACE_VERSION_INVALID:${String(revision)}`);
  }
};

const assertWorkspaceHash = (value: string, context: string): string => {
  if (!ethers.isHexString(value, 32)) throw new Error(`${context}:${String(value)}`);
  return value.toLowerCase();
};

const assertSettlementOps = (ops: readonly SettlementOp[]): void => {
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('SETTLEMENT_WORKSPACE_OPS_EMPTY');
  for (const [index, op] of ops.entries()) {
    assertSettlementTokenId(op.tokenId, `workspace-op=${index}`);
    if (op.type === 'r2c' || op.type === 'c2r' || op.type === 'r2r') {
      if (typeof op.amount !== 'bigint' || op.amount <= 0n) {
        throw new Error(`SETTLEMENT_WORKSPACE_AMOUNT_INVALID:index=${index}`);
      }
      continue;
    }
    if (op.type === 'rawDiff') {
      if (
        typeof op.leftDiff !== 'bigint' ||
        typeof op.rightDiff !== 'bigint' ||
        typeof op.collateralDiff !== 'bigint' ||
        typeof op.ondeltaDiff !== 'bigint'
      ) {
        throw new Error(`SETTLEMENT_WORKSPACE_RAW_DIFF_INVALID:index=${index}`);
      }
      continue;
    }
    if (op.type !== 'forgive') {
      const unknown = op as { type?: unknown };
      throw new Error(`SETTLEMENT_WORKSPACE_OP_INVALID:index=${index}:type=${String(unknown.type)}`);
    }
  }
};

const canonicalWorkspaceBody = (
  account: Pick<AccountState, 'leftEntity' | 'rightEntity'>,
  workspace: Pick<SettlementWorkspace, 'revision' | 'ops' | 'lastModifiedByLeft' | 'executorIsLeft' | 'memo'>,
) => ({
  domain: WORKSPACE_DOMAIN,
  leftEntity: account.leftEntity.toLowerCase(),
  rightEntity: account.rightEntity.toLowerCase(),
  revision: workspace.revision,
  ops: workspace.ops,
  lastModifiedByLeft: workspace.lastModifiedByLeft,
  executorIsLeft: workspace.executorIsLeft,
  ...(workspace.memo !== undefined ? { memo: workspace.memo } : {}),
});

export const createSettlementWorkspaceHash = (
  account: Pick<AccountState, 'leftEntity' | 'rightEntity'>,
  workspace: Pick<SettlementWorkspace, 'revision' | 'ops' | 'lastModifiedByLeft' | 'executorIsLeft' | 'memo'>,
): string => computeCanonicalMerkleRoot('settlement.workspace', [
  ['body', canonicalWorkspaceBody(account, workspace)],
]);

export const assertCanonicalSettlementWorkspace = (
  account: Pick<AccountState, 'leftEntity' | 'rightEntity'>,
  workspace: SettlementWorkspace,
): string => {
  const stored = assertWorkspaceHash(workspace.workspaceHash, 'SETTLEMENT_WORKSPACE_HASH_INVALID');
  const expected = createSettlementWorkspaceHash(account, workspace).toLowerCase();
  if (stored !== expected) throw new Error(`SETTLEMENT_WORKSPACE_HASH_CORRUPTION:${stored}:${expected}`);
  return expected;
};

const holdPlan = (diffs: readonly SettlementDiff[]): HoldPlan[] => diffs.map((diff) => ({
  tokenId: diff.tokenId,
  left: diff.leftDiff < 0n ? -diff.leftDiff : 0n,
  right: diff.rightDiff < 0n ? -diff.rightDiff : 0n,
}));

const releaseWorkspaceHolds = (
  draft: AccountReplica,
  workspace: SettlementWorkspace,
): Set<number> => {
  const changed = new Set<number>();
  const { diffs } = compileOps(workspace.ops, workspace.lastModifiedByLeft);
  for (const plan of holdPlan(diffs)) {
    if (plan.left === 0n && plan.right === 0n) continue;
    const delta = draft.state.deltas.get(plan.tokenId);
    if (!delta) throw new Error(`SETTLEMENT_HOLD_DELTA_MISSING:release:token=${plan.tokenId}`);
    const leftError = releaseHold(
      delta,
      'left',
      plan.left,
      (hold, amount) => `SETTLEMENT_HOLD_UNDERFLOW:left:token=${plan.tokenId}:hold=${hold}:release=${amount}`,
    );
    if (leftError) throw new Error(leftError);
    const rightError = releaseHold(
      delta,
      'right',
      plan.right,
      (hold, amount) => `SETTLEMENT_HOLD_UNDERFLOW:right:token=${plan.tokenId}:hold=${hold}:release=${amount}`,
    );
    if (rightError) throw new Error(rightError);
    changed.add(plan.tokenId);
  }
  return changed;
};

const addWorkspaceHolds = (
  draft: AccountReplica,
  workspace: SettlementWorkspace,
): Set<number> => {
  const changed = new Set<number>();
  const { diffs } = compileOps(workspace.ops, workspace.lastModifiedByLeft);
  for (const plan of holdPlan(diffs)) {
    if (plan.left === 0n && plan.right === 0n) continue;
    const delta = draft.state.deltas.get(plan.tokenId);
    if (!delta) throw new Error(`SETTLEMENT_HOLD_DELTA_MISSING:add:token=${plan.tokenId}`);
    const workspaceDiff = diffs.find((diff) => diff.tokenId === plan.tokenId);
    const leftReserveDeposit = (workspaceDiff?.leftDiff ?? 0n) < 0n && (workspaceDiff?.collateralDiff ?? 0n) > 0n;
    const rightReserveDeposit = (workspaceDiff?.rightDiff ?? 0n) < 0n && (workspaceDiff?.collateralDiff ?? 0n) > 0n;
    if (!leftReserveDeposit && plan.left > deriveDelta(delta, true).outCapacity) {
      throw new Error(`SETTLEMENT_HOLD_CAPACITY:left:token=${plan.tokenId}`);
    }
    if (!rightReserveDeposit && plan.right > deriveDelta(delta, false).outCapacity) {
      throw new Error(`SETTLEMENT_HOLD_CAPACITY:right:token=${plan.tokenId}`);
    }
    const leftError = addHold(delta, 'left', plan.left);
    if (leftError) throw new Error(leftError);
    const rightError = addHold(delta, 'right', plan.right);
    if (rightError) throw new Error(rightError);
    changed.add(plan.tokenId);
  }
  return changed;
};

const assertCurrentWorkspace = (
  account: AccountReplica,
  revision: number,
  suppliedHash: string,
): SettlementWorkspace => {
  assertVersion(revision);
  const workspace = account.state.settlementWorkspace;
  if (!workspace) throw new Error('SETTLEMENT_WORKSPACE_MISSING');
  const currentHash = assertCanonicalSettlementWorkspace(account.state, workspace);
  const requestedHash = assertWorkspaceHash(suppliedHash, 'SETTLEMENT_WORKSPACE_TARGET_HASH_INVALID');
  if (workspace.revision !== revision) {
    throw new Error(`SETTLEMENT_WORKSPACE_VERSION_MISMATCH:${workspace.revision}:${revision}`);
  }
  if (currentHash !== requestedHash) {
    throw new Error(`SETTLEMENT_WORKSPACE_TARGET_HASH_MISMATCH:${currentHash}:${requestedHash}`);
  }
  return workspace;
};

const assertSettlementNonce = (value: number, context: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${context}:${String(value)}`);
  return value;
};

const assertExactHanko = (value: string | undefined, context: string): string => {
  if (!value || !ethers.isHexString(value) || value === '0x') throw new Error(context);
  return value;
};

const assertSameOptionalHanko = (
  existing: string | undefined,
  supplied: string,
  context: string,
): void => {
  if (existing !== undefined && existing.toLowerCase() !== supplied.toLowerCase()) {
    throw new Error(context);
  }
};

const assertSettlementSealNonce = (
  draft: AccountReplica,
  workspace: SettlementWorkspace,
  settlementNonce: number,
): void => {
  const minimumSafeNonce = getMinimumSafeSettlementNonce(draft);
  if (workspace.nonceAtSign !== undefined) {
    if (workspace.nonceAtSign !== settlementNonce) {
      throw new SettlementSealNonceMismatchError(
        `SETTLEMENT_SEAL_NONCE_MISMATCH:${workspace.nonceAtSign}:${settlementNonce}`,
        settlementNonce,
        workspace.nonceAtSign,
        'workspace',
      );
    }
    return;
  }
  // A bilateral seal must use the exact locally derived nonce. Tolerance here
  // would turn a replica/catch-up bug into two valid on-chain authorizations.
  if (settlementNonce !== minimumSafeNonce) {
    throw new SettlementSealNonceMismatchError(
      `SETTLEMENT_SEAL_NONCE_MISMATCH:${settlementNonce}:${minimumSafeNonce}` +
      `:j=${Number(draft.state.jNonce ?? 0)}` +
      `:next=${Number(draft.proofHeader.nextProofNonce ?? 0)}` +
      `:local=${Number(draft.currentDisputeProofNonce ?? 0)}` +
      `:peer=${Number(draft.counterpartyDisputeProofNonce ?? 0)}`,
      settlementNonce,
      minimumSafeNonce,
      'account',
    );
  }
};

const prepareSettlementSeal = (
  draft: AccountReplica,
  transition: Extract<SettleTransitionTx['data'], { kind: 'seal' }>,
  context: AccountConsensusContext,
) => {
  const workspace = assertCurrentWorkspace(draft, transition.revision, transition.workspaceHash);
  if (workspace.status === 'submitted') throw new Error('SETTLEMENT_SEAL_SUBMITTED_FORBIDDEN');
  const settlementNonce = assertSettlementNonce(
    transition.settlementNonce,
    'SETTLEMENT_SEAL_NONCE_INVALID',
  );
  assertSettlementSealNonce(draft, workspace, settlementNonce);

  const domain = getAccountStateDomain(draft.state);
  const { diffs, forgiveTokenIds } = compileOps(workspace.ops, workspace.lastModifiedByLeft);
  const expectedSettlementHash = createSettlementHashWithNonce(
    draft.state,
    diffs,
    forgiveTokenIds,
    domain,
    settlementNonce,
  );
  const suppliedSettlementHash = assertWorkspaceHash(
    transition.settlementHash,
    'SETTLEMENT_SEAL_HASH_INVALID',
  );
  if (suppliedSettlementHash !== expectedSettlementHash.toLowerCase()) {
    throw new Error(`SETTLEMENT_SEAL_HASH_MISMATCH:${suppliedSettlementHash}:${expectedSettlementHash}`);
  }
  if (
    workspace.settlementHash !== undefined &&
    workspace.settlementHash.toLowerCase() !== expectedSettlementHash.toLowerCase()
  ) {
    throw new Error(`SETTLEMENT_SEAL_PINNED_HASH_MISMATCH:${workspace.settlementHash}:${expectedSettlementHash}`);
  }

  const postNonce = assertSettlementNonce(
    transition.postProof.nonce,
    'POST_SETTLEMENT_PROOF_NONCE_INVALID',
  );
  if (postNonce !== settlementNonce + 1) {
    throw new Error(`POST_SETTLEMENT_PROOF_NONCE_MISMATCH:${postNonce}:${settlementNonce + 1}`);
  }
  const projectedPostSettlement = projectAccountAfterSettlement(
    draft,
    diffs,
    forgiveTokenIds,
  );
  const { proofBodyHash, proofBodyStruct } = buildAccountProofBodyFromJurisdictions(
    context,
    projectedPostSettlement,
  );
  if (transition.postProof.proofBodyHash.toLowerCase() !== proofBodyHash.toLowerCase()) {
    throw new Error(
      `POST_SETTLEMENT_PROOF_BODY_HASH_MISMATCH:${transition.postProof.proofBodyHash}:${proofBodyHash}`,
    );
  }
  const expectedDisputeHash = createDisputeProofHashWithNonce(
    draft.state,
    proofBodyHash,
    domain,
    postNonce,
    transition.postProof.proposerIsLeft,
  );
  if (transition.postProof.disputeHash.toLowerCase() !== expectedDisputeHash.toLowerCase()) {
    throw new Error(
      `POST_SETTLEMENT_DISPUTE_HASH_MISMATCH:${transition.postProof.disputeHash}:${expectedDisputeHash}`,
    );
  }
  const pinnedPostProof = workspace.postSettlementDisputeProof;
  if (
    pinnedPostProof &&
    (
      pinnedPostProof.nonce !== postNonce ||
      pinnedPostProof.proofBodyHash.toLowerCase() !== proofBodyHash.toLowerCase() ||
      pinnedPostProof.disputeHash.toLowerCase() !== expectedDisputeHash.toLowerCase() ||
      pinnedPostProof.proposerIsLeft !== transition.postProof.proposerIsLeft
    )
  ) {
    throw new Error('POST_SETTLEMENT_PROOF_PIN_MISMATCH');
  }
  return {
    workspace,
    settlementNonce,
    diffs,
    forgiveTokenIds,
    proofBodyHash,
    proofBodyStruct,
    postNonce,
    projectedPostSettlement,
    expectedSettlementHash,
    expectedDisputeHash,
    proposerIsLeft: transition.postProof.proposerIsLeft,
    pinnedPostProof,
  };
};

type PreparedSettlementSeal = ReturnType<typeof prepareSettlementSeal>;

const verifySettlementSealHankos = async (
  draft: AccountReplica,
  transition: Extract<SettleTransitionTx['data'], { kind: 'seal' }>,
  byLeft: boolean,
  context: AccountConsensusContext,
  prepared: PreparedSettlementSeal,
  registeredBoardHash?: string,
): Promise<{ postHanko: string; settlementHanko?: string }> => {
  const sourceEntity = byLeft ? draft.state.leftEntity : draft.state.rightEntity;
  const sealBoardHash = await context.resolveSettlementBoardAuthority(
    sourceEntity,
    registeredBoardHash,
  );
  const postHanko = assertExactHanko(
    transition.postProof.hanko,
    'POST_SETTLEMENT_PROOF_HANKO_MISSING',
  );
  // Post-settlement proof is evidence about a state the previous board
  // legitimately signed; `Account.sol:1063` accepts it for the full grace.
  const verifiedPost = await context.verifyHanko(
    postHanko,
    prepared.expectedDisputeHash,
    sourceEntity,
    {
      ...(sealBoardHash ? { registeredBoardHash: sealBoardHash } : {}),
      allowPreviousBoard: true,
    },
  );
  if (!verifiedPost.valid || verifiedPost.entityId?.toLowerCase() !== sourceEntity.toLowerCase()) {
    throw new Error('POST_SETTLEMENT_PROOF_HANKO_INVALID');
  }

  const sourceIsExecutor = prepared.workspace.executorIsLeft === byLeft;
  let settlementHanko: string | undefined;
  if (sourceIsExecutor) {
    if (transition.settlementHanko !== undefined) {
      throw new Error('SETTLEMENT_EXECUTOR_HANKO_FORBIDDEN');
    }
  } else {
    settlementHanko = assertExactHanko(
      transition.settlementHanko,
      'SETTLEMENT_NONEXECUTOR_HANKO_MISSING',
    );
    // Cooperative settlement creates fresh financial state. `Account.sol:894`
    // verifies it with `verifyCurrentHankoSignature`, so a rotated-out board
    // must not seal it here either - otherwise the bilateral state advances
    // off-chain on a signature the jurisdiction will reject.
    const verifiedSettlement = await context.verifyHanko(
      settlementHanko,
      prepared.expectedSettlementHash,
      sourceEntity,
      {
        ...(sealBoardHash ? { registeredBoardHash: sealBoardHash } : {}),
        allowPreviousBoard: false,
      },
    );
    if (!verifiedSettlement.valid || verifiedSettlement.entityId?.toLowerCase() !== sourceEntity.toLowerCase()) {
      throw new Error('SETTLEMENT_NONEXECUTOR_HANKO_INVALID');
    }
  }
  return { postHanko, ...(settlementHanko ? { settlementHanko } : {}) };
};

const commitSettlementSeal = (
  draft: AccountReplica,
  byLeft: boolean,
  timestamp: number,
  prepared: PreparedSettlementSeal,
  verified: { postHanko: string; settlementHanko?: string },
): void => {
  const {
    workspace,
    settlementNonce,
    diffs,
    forgiveTokenIds,
    proofBodyHash,
    proofBodyStruct,
    postNonce,
    projectedPostSettlement,
    expectedSettlementHash,
    expectedDisputeHash,
    pinnedPostProof,
  } = prepared;
  const sourcePostHanko = byLeft
    ? pinnedPostProof?.leftHanko
    : pinnedPostProof?.rightHanko;
  const { postHanko, settlementHanko } = verified;
  assertSameOptionalHanko(sourcePostHanko, postHanko, 'POST_SETTLEMENT_PROOF_EQUIVOCATION');
  const sourceSettlementHanko = byLeft ? workspace.leftHanko : workspace.rightHanko;
  if (settlementHanko) {
    assertSameOptionalHanko(sourceSettlementHanko, settlementHanko, 'SETTLEMENT_SEAL_EQUIVOCATION');
  }

  workspace.compiledDiffs = diffs;
  workspace.compiledForgiveTokenIds = forgiveTokenIds;
  workspace.nonceAtSign = settlementNonce;
  workspace.settlementHash = expectedSettlementHash;
  workspace.postSettlementDisputeProof = {
    disputeHash: expectedDisputeHash,
    proofBodyHash,
    nonce: postNonce,
    proposerIsLeft: prepared.proposerIsLeft,
    ...(pinnedPostProof?.leftHanko ? { leftHanko: pinnedPostProof.leftHanko } : {}),
    ...(pinnedPostProof?.rightHanko ? { rightHanko: pinnedPostProof.rightHanko } : {}),
    ...(byLeft ? { leftHanko: postHanko } : { rightHanko: postHanko }),
  };
  if (settlementHanko) {
    if (byLeft) workspace.leftHanko = settlementHanko;
    else workspace.rightHanko = settlementHanko;
  }
  const nonexecutorHanko = workspace.executorIsLeft ? workspace.rightHanko : workspace.leftHanko;
  workspace.status = nonexecutorHanko &&
    workspace.postSettlementDisputeProof.leftHanko &&
    workspace.postSettlementDisputeProof.rightHanko
    ? 'ready_to_submit'
    : 'awaiting_counterparty';
  workspace.lastUpdatedAt = timestamp;

  draft.disputeProofBodiesByHash ??= {};
  draft.disputeProofBodiesByHash[proofBodyHash] = proofBodyStruct;
  draft.disputeProofNoncesByHash ??= {};
  draft.disputeProofNoncesByHash[proofBodyHash] = postNonce;
  storeDisputeArgumentSnapshot(
    draft,
    captureDisputeArgumentSnapshot(
      projectedPostSettlement,
      proofBodyHash,
      postNonce,
      prepared.proposerIsLeft,
      proofBodyStruct,
    ),
  );
};

const applySettlementSeal = async (
  draft: AccountReplica,
  transition: Extract<SettleTransitionTx['data'], { kind: 'seal' }>,
  byLeft: boolean,
  timestamp: number,
  context: AccountConsensusContext | undefined,
  registeredBoardHash?: string,
): Promise<void> => {
  if (!context) throw new Error('SETTLEMENT_SEAL_CONTEXT_MISSING');
  const prepared = prepareSettlementSeal(draft, transition, context);
  const verified = await verifySettlementSealHankos(
    draft,
    transition,
    byLeft,
    context,
    prepared,
    registeredBoardHash,
  );
  // All hashes and both authority domains are proven before the first write.
  // This ordering is the Account-level atomicity boundary for settlement seals.
  commitSettlementSeal(draft, byLeft, timestamp, prepared, verified);
};

const buildUpsertWorkspace = (
  account: AccountReplica,
  transition: UpsertTransition,
  byLeft: boolean,
  timestamp: number,
): SettlementWorkspace => {
  assertVersion(transition.revision);
  assertSettlementOps(transition.ops);
  if (typeof transition.executorIsLeft !== 'boolean') {
    throw new Error('SETTLEMENT_WORKSPACE_EXECUTOR_INVALID');
  }
  compileOps(transition.ops, byLeft);
  const current = account.state.settlementWorkspace;
  if (transition.revision === 1) {
    if (current) throw new Error('SETTLEMENT_WORKSPACE_ALREADY_EXISTS');
    if (transition.previousWorkspaceHash !== undefined) {
      throw new Error('SETTLEMENT_WORKSPACE_PREVIOUS_HASH_UNEXPECTED');
    }
  } else {
    if (!current) throw new Error('SETTLEMENT_WORKSPACE_PREVIOUS_MISSING');
    if (current.leftHanko || current.rightHanko) throw new Error('SETTLEMENT_WORKSPACE_SIGNED_UPDATE_FORBIDDEN');
    if (current.revision + 1 !== transition.revision) {
      throw new Error(`SETTLEMENT_WORKSPACE_NON_CONTIGUOUS_VERSION:${current.revision}:${transition.revision}`);
    }
    const currentHash = assertCanonicalSettlementWorkspace(account.state, current);
    const previousHash = assertWorkspaceHash(
      transition.previousWorkspaceHash ?? '',
      'SETTLEMENT_WORKSPACE_PREVIOUS_HASH_INVALID',
    );
    if (currentHash !== previousHash) {
      throw new Error(`SETTLEMENT_WORKSPACE_PREVIOUS_HASH_MISMATCH:${currentHash}:${previousHash}`);
    }
  }
  const workspace: SettlementWorkspace = {
    workspaceHash: '',
    ops: transition.ops.map((op) => ({ ...op })),
    lastModifiedByLeft: byLeft,
    status: 'awaiting_counterparty',
    ...(transition.memo !== undefined ? { memo: transition.memo } : {}),
    revision: transition.revision,
    createdAt: current?.createdAt ?? timestamp,
    lastUpdatedAt: timestamp,
    executorIsLeft: transition.executorIsLeft,
  };
  workspace.workspaceHash = createSettlementWorkspaceHash(account.state, workspace);
  return workspace;
};

const commitDraft = (
  account: AccountReplica,
  draft: AccountReplica,
  changedTokens: ReadonlySet<number>,
): void => {
  for (const tokenId of changedTokens) {
    const source = draft.state.deltas.get(tokenId);
    const target = account.state.deltas.get(tokenId);
    if (!source || !target) throw new Error(`SETTLEMENT_HOLD_COMMIT_DELTA_MISSING:token=${tokenId}`);
    target.leftHold = getHold(source, 'left');
    target.rightHold = getHold(source, 'right');
  }
  if (draft.state.settlementWorkspace) account.state.settlementWorkspace = draft.state.settlementWorkspace;
  else delete account.state.settlementWorkspace;
};

// AccountSettled is bilateral Account consensus too. If it wins a retry race,
// release the exact workspace holds before removing the workspace body.
export function clearFinalizedSettlementWorkspace(account: AccountReplica): void {
  const draft = cloneAccountReplica(account);
  const workspace = draft.state.settlementWorkspace;
  if (!workspace) return;
  assertCanonicalSettlementWorkspace(draft.state, workspace);
  const changed = workspace.status === 'submitted'
    ? new Set<number>()
    : releaseWorkspaceHolds(draft, workspace);
  delete draft.state.settlementWorkspace;
  commitDraft(account, draft, changed);
}

export const getSignedSettlementWorkspaceTxError = (
  account: AccountReplica,
  tx: AccountTx,
): string | undefined => {
  const workspace = account.state.settlementWorkspace;
  if (
    !workspace ||
    (!workspace.settlementHash && !workspace.leftHanko && !workspace.rightHanko && !workspace.postSettlementDisputeProof)
  ) return undefined;
  if (tx.type === 'j_event_claim') return undefined;
  if (tx.type === 'settle_transition' && (tx.data.kind === 'seal' || tx.data.kind === 'submit')) return undefined;
  return `SETTLEMENT_SIGNED_ACCOUNT_FROZEN:${tx.type}`;
};

export async function handleSettleTransition(
  account: AccountReplica,
  tx: SettleTransitionTx,
  byLeft: boolean,
  timestamp: number,
  context?: AccountConsensusContext,
  registeredBoardHash?: string,
): Promise<ApplyAccountTxResult> {
  try {
    const draft = cloneAccountReplica(account);
    const changed = new Set<number>();
    const transition = tx.data;
    if (transition.kind === 'upsert') {
      const previous = draft.state.settlementWorkspace;
      const next = buildUpsertWorkspace(draft, transition, byLeft, timestamp);
      if (previous) {
        for (const tokenId of releaseWorkspaceHolds(draft, previous)) changed.add(tokenId);
      }
      draft.state.settlementWorkspace = next;
      for (const tokenId of addWorkspaceHolds(draft, next)) changed.add(tokenId);
      commitDraft(account, draft, changed);
      transitionLog.debug('workspace.upserted', { revision: next.revision, hash: next.workspaceHash });
      return { success: true, events: [`Settlement workspace v${next.revision} committed`] };
    }

    if (transition.kind === 'seal') {
      await applySettlementSeal(draft, transition, byLeft, timestamp, context, registeredBoardHash);
      commitDraft(account, draft, changed);
      account.disputeProofBodiesByHash = structuredClone(draft.disputeProofBodiesByHash ?? {});
      account.disputeProofNoncesByHash = { ...(draft.disputeProofNoncesByHash ?? {}) };
      account.disputeArgumentSnapshotsByHash = structuredClone(draft.disputeArgumentSnapshotsByHash ?? {});
      return { success: true, events: [`Settlement workspace v${transition.revision} sealed`] };
    }

    const workspace = assertCurrentWorkspace(draft, transition.revision, transition.workspaceHash);
    if (transition.kind === 'submit') {
      if (workspace.status === 'submitted') throw new Error('SETTLEMENT_WORKSPACE_ALREADY_SUBMITTED');
      if (byLeft !== workspace.executorIsLeft) throw new Error('SETTLEMENT_SUBMIT_EXECUTOR_MISMATCH');
      const counterpartyHanko = byLeft ? workspace.rightHanko : workspace.leftHanko;
      if (!counterpartyHanko) throw new Error('SETTLEMENT_SUBMIT_COUNTERPARTY_HANKO_MISSING');
      if (
        workspace.status !== 'ready_to_submit' ||
        !workspace.postSettlementDisputeProof?.leftHanko ||
        !workspace.postSettlementDisputeProof.rightHanko
      ) {
        throw new Error('SETTLEMENT_SUBMIT_POST_PROOF_INCOMPLETE');
      }
      for (const tokenId of releaseWorkspaceHolds(draft, workspace)) changed.add(tokenId);
      workspace.status = 'submitted';
      workspace.lastUpdatedAt = timestamp;
      commitDraft(account, draft, changed);
      return { success: true, events: [`Settlement workspace v${workspace.revision} submitted`] };
    }

    if (workspace.status === 'submitted') throw new Error('SETTLEMENT_CLEAR_SUBMITTED_FORBIDDEN');
    if (
      workspace.settlementHash || workspace.leftHanko || workspace.rightHanko ||
      workspace.postSettlementDisputeProof
    ) {
      throw new Error('SETTLEMENT_CLEAR_SIGNED_FORBIDDEN');
    }
    for (const tokenId of releaseWorkspaceHolds(draft, workspace)) changed.add(tokenId);
    delete draft.state.settlementWorkspace;
    commitDraft(account, draft, changed);
    return { success: true, events: [`Settlement workspace v${workspace.revision} cleared`] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    transitionLog.warn('workspace.transition_rejected', { kind: tx.data.kind, error: message });
    return {
      success: false,
      events: [],
      error: message,
      ...(error instanceof SettlementSealNonceMismatchError
        ? { rejection: error.rejection }
        : {}),
    };
  }
}
