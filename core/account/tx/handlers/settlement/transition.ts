import { ethers } from 'ethers';

import type { AccountReplica, AccountState, AccountTx, Delta, SettlementDiff, SettlementOp, SettlementWorkspace } from '../../../../types/account';
import { computeCanonicalMerkleRoot } from '../../../commitment/state-root';
import { deriveDelta } from '../../../utils';
import {
  assertSettlementTokenId,
  compileOps,
  getMinimumSafeSettlementNonce,
} from '../../../../protocol/settlement/operations';
import { createStructuredLogger } from '../../../../support/logger';
import { addHold, releaseHold } from '../../hold-utils';
import {
  createDisputeProofHashWithNonce,
  createSettlementHashWithNonce,
} from '../../../../protocol/dispute/proof-builder';
import { buildAccountProofBodyFromJurisdictions, getAccountStateDomain } from '../../../consensus/helpers';
import type { AccountConsensusContext } from '../../../consensus/context';
import { projectSettlementDeltaOverrides } from '../../../settlement/settlement-projection';
import { ACCOUNT_TX_REJECTION_CODES } from '../../apply-types';
import type {
  AccountTxRejection,
  ApplyAccountTxResult,
} from '../../apply-types';
import {
  accountTxApplied,
  accountTxRejected,
  settlementHankoNonceRejection,
} from '../../apply-result';
import {
  assertSettlementWorkspacePhase,
  isUnsignedSettlementWorkspace,
  type UnsignedSettlementWorkspace,
} from './workspace-views';
import {
  isAccountDraftReplica,
  type AccountDraftReplica,
} from '../../../state/account-state-draft';
import { requirePersistentAccountStateMap } from '../../../state/persistent-state-map';

type SettleTransitionTx = Extract<AccountTx, { type: 'settle_transition' }>;
type UpsertTransition = Extract<SettleTransitionTx['data'], { kind: 'upsert' }>;
type SettlementHankoNonceRejection = Extract<
  AccountTxRejection,
  { kind: 'settlement_hanko_nonce_mismatch' }
>;

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

class SettlementHankoNonceMismatchError extends Error {
  readonly rejection: SettlementHankoNonceRejection;

  constructor(
    message: string,
    suppliedNonce: number,
    requiredNonce: number,
    basis: SettlementHankoNonceRejection['basis'],
  ) {
    super(message);
    this.rejection = settlementHankoNonceRejection(
      message,
      suppliedNonce,
      requiredNonce,
      basis,
    );
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

type SettlementDeltaPlan = Map<number, Delta>;

const deltaForPlan = (
  draft: AccountReplica,
  planned: SettlementDeltaPlan,
  tokenId: number,
  operation: 'add' | 'release',
): Delta => {
  const plannedDelta = planned.get(tokenId);
  if (plannedDelta) return plannedDelta;
  const committed = draft.state.deltas.get(tokenId);
  if (!committed) {
    throw new Error(`SETTLEMENT_HOLD_DELTA_MISSING:${operation}:token=${tokenId}`);
  }
  const owned = { ...committed };
  planned.set(tokenId, owned);
  return owned;
};

/**
 * Plan hold changes on owned leaf copies. A rejected settlement tx must not
 * mutate the surrounding Account transition, so publication happens only
 * after every hold/capacity check succeeds.
 */
const planWorkspaceHoldRelease = (
  draft: AccountReplica,
  workspace: SettlementWorkspace,
  planned: SettlementDeltaPlan,
): void => {
  const { diffs } = compileOps(workspace.ops, workspace.lastModifiedByLeft);
  for (const plan of holdPlan(diffs)) {
    if (plan.left === 0n && plan.right === 0n) continue;
    const delta = deltaForPlan(draft, planned, plan.tokenId, 'release');
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
  }
};

const planWorkspaceHoldAdd = (
  draft: AccountReplica,
  workspace: SettlementWorkspace,
  planned: SettlementDeltaPlan,
): void => {
  const { diffs } = compileOps(workspace.ops, workspace.lastModifiedByLeft);
  for (const plan of holdPlan(diffs)) {
    if (plan.left === 0n && plan.right === 0n) continue;
    const delta = deltaForPlan(draft, planned, plan.tokenId, 'add');
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
  }
};

const publishSettlementDeltaPlan = (
  draft: AccountReplica,
  planned: SettlementDeltaPlan,
): void => {
  if (isAccountDraftReplica(draft)) {
    for (const [tokenId, delta] of planned) draft.state.deltas.put(tokenId, delta);
    return;
  }
  let deltas = requirePersistentAccountStateMap(draft.state.deltas, 'deltas');
  for (const [tokenId, delta] of planned) deltas = deltas.updated(tokenId, delta);
  draft.state.deltas = deltas;
};

const assertCurrentWorkspace = (
  account: AccountReplica,
  revision: number,
  suppliedHash: string,
): SettlementWorkspace => {
  assertVersion(revision);
  const workspace = account.state.settlementWorkspace;
  if (!workspace) throw new Error('SETTLEMENT_WORKSPACE_MISSING');
  assertSettlementWorkspacePhase(workspace, 'SETTLEMENT_WORKSPACE');
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

const assertSettlementHankoNonce = (
  draft: AccountReplica,
  workspace: SettlementWorkspace,
  settlementNonce: number,
): void => {
  const minimumSafeNonce = getMinimumSafeSettlementNonce(draft);
  if (workspace.nonceAtSign !== undefined) {
    if (workspace.nonceAtSign !== settlementNonce) {
      throw new SettlementHankoNonceMismatchError(
        `SETTLEMENT_HANKO_NONCE_MISMATCH:${workspace.nonceAtSign}:${settlementNonce}`,
        settlementNonce,
        workspace.nonceAtSign,
        'workspace',
      );
    }
    return;
  }
  // A bilateral Hanko must use the exact locally derived nonce. Tolerance here
  // would turn a replica/catch-up bug into two valid on-chain authorizations.
  if (settlementNonce !== minimumSafeNonce) {
    throw new SettlementHankoNonceMismatchError(
      `SETTLEMENT_HANKO_NONCE_MISMATCH:${settlementNonce}:${minimumSafeNonce}` +
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

const prepareSettlementHanko = (
  draft: AccountReplica,
  transition: Extract<SettleTransitionTx['data'], { kind: 'hanko' }>,
  context: AccountConsensusContext,
) => {
  const workspace = assertCurrentWorkspace(draft, transition.revision, transition.workspaceHash);
  if (workspace.status === 'submitted') throw new Error('SETTLEMENT_HANKO_SUBMITTED_FORBIDDEN');
  const settlementNonce = assertSettlementNonce(
    transition.settlementNonce,
    'SETTLEMENT_HANKO_NONCE_INVALID',
  );
  assertSettlementHankoNonce(draft, workspace, settlementNonce);

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
    'SETTLEMENT_HANKO_HASH_INVALID',
  );
  if (suppliedSettlementHash !== expectedSettlementHash.toLowerCase()) {
    throw new Error(`SETTLEMENT_HANKO_HASH_MISMATCH:${suppliedSettlementHash}:${expectedSettlementHash}`);
  }
  if (
    workspace.settlementHash !== undefined &&
    workspace.settlementHash.toLowerCase() !== expectedSettlementHash.toLowerCase()
  ) {
    throw new Error(`SETTLEMENT_HANKO_PINNED_HASH_MISMATCH:${workspace.settlementHash}:${expectedSettlementHash}`);
  }

  const postNonce = assertSettlementNonce(
    transition.postProof.nonce,
    'POST_SETTLEMENT_PROOF_NONCE_INVALID',
  );
  if (postNonce !== settlementNonce + 1) {
    throw new Error(`POST_SETTLEMENT_PROOF_NONCE_MISMATCH:${postNonce}:${settlementNonce + 1}`);
  }
  const projectedDeltas = projectSettlementDeltaOverrides(
    draft,
    diffs,
    forgiveTokenIds,
  );
  const { proofBodyHash } = buildAccountProofBodyFromJurisdictions(
    context,
    draft,
    projectedDeltas,
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
    postNonce,
    expectedSettlementHash,
    expectedDisputeHash,
    proposerIsLeft: transition.postProof.proposerIsLeft,
    pinnedPostProof,
  };
};

type PreparedSettlementHanko = ReturnType<typeof prepareSettlementHanko>;

const verifySettlementHankoHankos = async (
  draft: AccountReplica,
  transition: Extract<SettleTransitionTx['data'], { kind: 'hanko' }>,
  byLeft: boolean,
  context: AccountConsensusContext,
  prepared: PreparedSettlementHanko,
  registeredBoardHash?: string,
): Promise<{ postHanko: string; settlementHanko?: string }> => {
  const sourceEntity = byLeft ? draft.state.leftEntity : draft.state.rightEntity;
  const hankoBoardHash = await context.resolveSettlementBoardAuthority(
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
      ...(hankoBoardHash ? { registeredBoardHash: hankoBoardHash } : {}),
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
    // must not attach it here either - otherwise the bilateral state advances
    // off-chain on a signature the jurisdiction will reject.
    const verifiedSettlement = await context.verifyHanko(
      settlementHanko,
      prepared.expectedSettlementHash,
      sourceEntity,
      {
        ...(hankoBoardHash ? { registeredBoardHash: hankoBoardHash } : {}),
        allowPreviousBoard: false,
      },
    );
    if (!verifiedSettlement.valid || verifiedSettlement.entityId?.toLowerCase() !== sourceEntity.toLowerCase()) {
      throw new Error('SETTLEMENT_NONEXECUTOR_HANKO_INVALID');
    }
  }
  return { postHanko, ...(settlementHanko ? { settlementHanko } : {}) };
};

const commitSettlementHanko = (
  draft: AccountDraftReplica,
  byLeft: boolean,
  timestamp: number,
  prepared: PreparedSettlementHanko,
  verified: { postHanko: string; settlementHanko?: string },
): void => {
  const {
    workspace,
    settlementNonce,
    diffs,
    forgiveTokenIds,
    proofBodyHash,
    postNonce,
    expectedSettlementHash,
    expectedDisputeHash,
    pinnedPostProof,
  } = prepared;
  const nextWorkspace: SettlementWorkspace = {
    ...workspace,
    ops: workspace.ops.map((op) => ({ ...op })),
    ...(workspace.compiledDiffs
      ? { compiledDiffs: workspace.compiledDiffs.map((diff) => ({ ...diff })) }
      : {}),
    ...(workspace.compiledForgiveTokenIds
      ? { compiledForgiveTokenIds: [...workspace.compiledForgiveTokenIds] }
      : {}),
    ...(workspace.postSettlementDisputeProof
      ? { postSettlementDisputeProof: { ...workspace.postSettlementDisputeProof } }
      : {}),
  };
  const sourcePostHanko = byLeft
    ? pinnedPostProof?.leftHanko
    : pinnedPostProof?.rightHanko;
  const { postHanko, settlementHanko } = verified;
  assertSameOptionalHanko(sourcePostHanko, postHanko, 'POST_SETTLEMENT_PROOF_EQUIVOCATION');
  const sourceSettlementHanko = byLeft ? nextWorkspace.leftHanko : nextWorkspace.rightHanko;
  if (settlementHanko) {
    assertSameOptionalHanko(sourceSettlementHanko, settlementHanko, 'SETTLEMENT_HANKO_EQUIVOCATION');
  }

  nextWorkspace.compiledDiffs = diffs;
  nextWorkspace.compiledForgiveTokenIds = forgiveTokenIds;
  nextWorkspace.nonceAtSign = settlementNonce;
  nextWorkspace.settlementHash = expectedSettlementHash;
  nextWorkspace.postSettlementDisputeProof = {
    disputeHash: expectedDisputeHash,
    proofBodyHash,
    nonce: postNonce,
    proposerIsLeft: prepared.proposerIsLeft,
    ...(pinnedPostProof?.leftHanko ? { leftHanko: pinnedPostProof.leftHanko } : {}),
    ...(pinnedPostProof?.rightHanko ? { rightHanko: pinnedPostProof.rightHanko } : {}),
    ...(byLeft ? { leftHanko: postHanko } : { rightHanko: postHanko }),
  };
  if (settlementHanko) {
    if (byLeft) nextWorkspace.leftHanko = settlementHanko;
    else nextWorkspace.rightHanko = settlementHanko;
  }
  const nonexecutorHanko = nextWorkspace.executorIsLeft
    ? nextWorkspace.rightHanko
    : nextWorkspace.leftHanko;
  nextWorkspace.status = nonexecutorHanko &&
    nextWorkspace.postSettlementDisputeProof.leftHanko &&
    nextWorkspace.postSettlementDisputeProof.rightHanko
    ? 'ready_to_submit'
    : 'awaiting_counterparty';
  nextWorkspace.lastUpdatedAt = timestamp;

  draft.state.settlementWorkspace = nextWorkspace;
};

const applySettlementHanko = async (
  draft: AccountDraftReplica,
  transition: Extract<SettleTransitionTx['data'], { kind: 'hanko' }>,
  byLeft: boolean,
  timestamp: number,
  context: AccountConsensusContext | undefined,
  registeredBoardHash?: string,
): Promise<void> => {
  if (!context) throw new Error('SETTLEMENT_HANKO_CONTEXT_MISSING');
  const prepared = prepareSettlementHanko(draft, transition, context);
  const verified = await verifySettlementHankoHankos(
    draft,
    transition,
    byLeft,
    context,
    prepared,
    registeredBoardHash,
  );
  // All hashes and both authority domains are proven before the first write.
  // This ordering is the Account-level atomicity boundary for settlement Hankos.
  commitSettlementHanko(draft, byLeft, timestamp, prepared, verified);
};

const buildUpsertWorkspace = (
  account: AccountReplica,
  transition: UpsertTransition,
  byLeft: boolean,
  timestamp: number,
): UnsignedSettlementWorkspace => {
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
  const workspace: UnsignedSettlementWorkspace = {
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

// AccountSettled is bilateral Account consensus too. If it wins a retry race,
// release the exact workspace holds before removing the workspace body.
export function clearFinalizedSettlementWorkspace(account: AccountReplica): void {
  const workspace = account.state.settlementWorkspace;
  if (!workspace) return;
  assertCanonicalSettlementWorkspace(account.state, workspace);
  const planned: SettlementDeltaPlan = new Map();
  if (workspace.status !== 'submitted') {
    planWorkspaceHoldRelease(account, workspace, planned);
  }
  publishSettlementDeltaPlan(account, planned);
  delete account.state.settlementWorkspace;
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
  if (tx.type === 'settle_transition' && (tx.data.kind === 'hanko' || tx.data.kind === 'submit')) return undefined;
  return `SETTLEMENT_SIGNED_ACCOUNT_FROZEN:${tx.type}`;
};

export async function handleSettleTransition(
  account: AccountDraftReplica,
  tx: SettleTransitionTx,
  byLeft: boolean,
  timestamp: number,
  context?: AccountConsensusContext,
  registeredBoardHash?: string,
): Promise<ApplyAccountTxResult> {
  try {
    const transition = tx.data;
    if (transition.kind === 'upsert') {
      const previous = account.state.settlementWorkspace;
      const next = buildUpsertWorkspace(account, transition, byLeft, timestamp);
      const planned: SettlementDeltaPlan = new Map();
      if (previous) {
        planWorkspaceHoldRelease(account, previous, planned);
      }
      planWorkspaceHoldAdd(account, next, planned);
      publishSettlementDeltaPlan(account, planned);
      account.state.settlementWorkspace = next;
      transitionLog.debug('workspace.upserted', { revision: next.revision, hash: next.workspaceHash });
      return accountTxApplied([`Settlement workspace v${next.revision} committed`]);
    }

    if (transition.kind === 'hanko') {
      await applySettlementHanko(account, transition, byLeft, timestamp, context, registeredBoardHash);
      return accountTxApplied([`Settlement workspace v${transition.revision} Hanko attached`]);
    }

    const workspace = assertCurrentWorkspace(account, transition.revision, transition.workspaceHash);
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
      const planned: SettlementDeltaPlan = new Map();
      planWorkspaceHoldRelease(account, workspace, planned);
      const submitted: SettlementWorkspace = {
        ...workspace,
        status: 'submitted',
        lastUpdatedAt: timestamp,
      };
      publishSettlementDeltaPlan(account, planned);
      account.state.settlementWorkspace = submitted;
      return accountTxApplied([`Settlement workspace v${workspace.revision} submitted`]);
    }

    if (workspace.status === 'submitted') throw new Error('SETTLEMENT_CLEAR_SUBMITTED_FORBIDDEN');
    if (!isUnsignedSettlementWorkspace(workspace)) {
      throw new Error('SETTLEMENT_CLEAR_SIGNED_FORBIDDEN');
    }
    const planned: SettlementDeltaPlan = new Map();
    planWorkspaceHoldRelease(account, workspace, planned);
    publishSettlementDeltaPlan(account, planned);
    delete account.state.settlementWorkspace;
    return accountTxApplied([`Settlement workspace v${workspace.revision} cleared`]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    transitionLog.warn('workspace.transition_rejected', { kind: tx.data.kind, error: message });
    return accountTxRejected(
      error instanceof SettlementHankoNonceMismatchError
        ? error.rejection
        : {
            kind: 'validation',
            code: ACCOUNT_TX_REJECTION_CODES.validation,
            message,
          },
      [],
    );
  }
}
