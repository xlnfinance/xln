import { ethers } from 'ethers';

import type {
  AccountReplica,
  AccountTx,
  RuntimeState,
  SettlementDiff,
  SettlementOp,
  SettlementWorkspace,
} from '../../../types';
import { cloneAccountState } from '../../state-clone';
import { computeCanonicalMerkleRoot } from '../../state-root';
import { deriveDelta } from '../../utils';
import { compileOps, getMinimumSafeSettlementNonce } from '../../../protocol/settlement/operations';
import { createStructuredLogger } from '../../../infra/logger';
import { addHold, getHold, releaseHold } from '../hold-utils';
import {
  createDisputeProofHashWithNonce,
  createSettlementHashWithNonce,
} from '../../../protocol/dispute/proof-builder';
import { getEntityConfigBoardHash, verifyHankoForHash } from '../../../hanko/signing';
import { buildAccountProofBodyFromEnv, getAccountStateDomain } from '../../consensus/helpers';
import { resolveSigningCertifiedBoardHash } from '../../../jurisdiction/board-registry';
import {
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../../../protocol/dispute/arguments';
import { projectAccountAfterSettlement } from '../../settlement-projection';
import type {
  AccountTxRejection,
  ApplyAccountTxResult,
} from '../apply-types';

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
    if (!Number.isSafeInteger(op.tokenId) || op.tokenId < 0) {
      throw new Error(`SETTLEMENT_WORKSPACE_TOKEN_INVALID:index=${index}:token=${String(op.tokenId)}`);
    }
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
  account: Pick<AccountReplica, 'leftEntity' | 'rightEntity'>,
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
  account: Pick<AccountReplica, 'leftEntity' | 'rightEntity'>,
  workspace: Pick<SettlementWorkspace, 'revision' | 'ops' | 'lastModifiedByLeft' | 'executorIsLeft' | 'memo'>,
): string => computeCanonicalMerkleRoot('settlement.workspace', [
  ['body', canonicalWorkspaceBody(account, workspace)],
]);

export const assertCanonicalSettlementWorkspace = (
  account: Pick<AccountReplica, 'leftEntity' | 'rightEntity'>,
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
    const delta = draft.deltas.get(plan.tokenId);
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
    const delta = draft.deltas.get(plan.tokenId);
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
  const workspace = account.settlementWorkspace;
  if (!workspace) throw new Error('SETTLEMENT_WORKSPACE_MISSING');
  const currentHash = assertCanonicalSettlementWorkspace(account, workspace);
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

const resolveSettlementSealBoardAuthority = async (
  env: RuntimeState,
  sourceEntity: string,
  certifiedCounterpartyBoardHash?: string,
): Promise<string | undefined> => {
  if (certifiedCounterpartyBoardHash) return certifiedCounterpartyBoardHash;
  const localStates = [...env.eReplicas.values()]
    .map((replica) => replica.state)
    .filter((state) => state.entityId.toLowerCase() === sourceEntity.toLowerCase());
  if (localStates.length === 0) return undefined;
  const configuredBoardHashes = new Set(
    await Promise.all(localStates.map(async (state) => (
      await getEntityConfigBoardHash(env, state.config)
    ).toLowerCase())),
  );
  if (configuredBoardHashes.size !== 1) {
    throw new Error(`SETTLEMENT_SEAL_LOCAL_BOARD_DIVERGENCE:${sourceEntity}`);
  }
  const configuredBoardHash = [...configuredBoardHashes][0]!;
  if (configuredBoardHash === sourceEntity.toLowerCase()) return undefined;
  const localState = localStates[0]!;
  const certifiedBoardHash = resolveSigningCertifiedBoardHash(
    env,
    sourceEntity,
    localState.config.jurisdiction,
  );
  if (!certifiedBoardHash) throw new Error(`SETTLEMENT_SEAL_BOARD_AUTHORITY_MISSING:${sourceEntity}`);
  if (certifiedBoardHash.toLowerCase() !== configuredBoardHash) {
    throw new Error(
      `SETTLEMENT_SEAL_BOARD_AUTHORITY_MISMATCH:${sourceEntity}:${certifiedBoardHash}:${configuredBoardHash}`,
    );
  }
  return certifiedBoardHash;
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
      `:j=${Number(draft.jNonce ?? 0)}` +
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
  env: RuntimeState,
) => {
  const workspace = assertCurrentWorkspace(draft, transition.revision, transition.workspaceHash);
  if (workspace.status === 'submitted') throw new Error('SETTLEMENT_SEAL_SUBMITTED_FORBIDDEN');
  const settlementNonce = assertSettlementNonce(
    transition.settlementNonce,
    'SETTLEMENT_SEAL_NONCE_INVALID',
  );
  assertSettlementSealNonce(draft, workspace, settlementNonce);

  const domain = getAccountStateDomain(draft);
  const { diffs, forgiveTokenIds } = compileOps(workspace.ops, workspace.lastModifiedByLeft);
  const expectedSettlementHash = createSettlementHashWithNonce(
    draft,
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
  const { proofBodyHash, proofBodyStruct } = buildAccountProofBodyFromEnv(env, projectedPostSettlement);
  if (transition.postProof.proofBodyHash.toLowerCase() !== proofBodyHash.toLowerCase()) {
    throw new Error(
      `POST_SETTLEMENT_PROOF_BODY_HASH_MISMATCH:${transition.postProof.proofBodyHash}:${proofBodyHash}`,
    );
  }
  const expectedDisputeHash = createDisputeProofHashWithNonce(
    draft,
    proofBodyHash,
    domain,
    postNonce,
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
      pinnedPostProof.disputeHash.toLowerCase() !== expectedDisputeHash.toLowerCase()
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
    pinnedPostProof,
  };
};

type PreparedSettlementSeal = ReturnType<typeof prepareSettlementSeal>;

const verifySettlementSealHankos = async (
  draft: AccountReplica,
  transition: Extract<SettleTransitionTx['data'], { kind: 'seal' }>,
  byLeft: boolean,
  env: RuntimeState,
  prepared: PreparedSettlementSeal,
  registeredBoardHash?: string,
): Promise<{ postHanko: string; settlementHanko?: string }> => {
  const sourceEntity = byLeft ? draft.leftEntity : draft.rightEntity;
  const sealBoardHash = await resolveSettlementSealBoardAuthority(
    env,
    sourceEntity,
    registeredBoardHash,
  );
  const postHanko = assertExactHanko(
    transition.postProof.hanko,
    'POST_SETTLEMENT_PROOF_HANKO_MISSING',
  );
  const verifiedPost = await verifyHankoForHash(
    postHanko,
    prepared.expectedDisputeHash,
    sourceEntity,
    env,
    sealBoardHash ? { registeredBoardHash: sealBoardHash } : undefined,
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
    const verifiedSettlement = await verifyHankoForHash(
      settlementHanko,
      prepared.expectedSettlementHash,
      sourceEntity,
      env,
      sealBoardHash ? { registeredBoardHash: sealBoardHash } : undefined,
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
      proofBodyStruct,
    ),
  );
};

const applySettlementSeal = async (
  draft: AccountReplica,
  transition: Extract<SettleTransitionTx['data'], { kind: 'seal' }>,
  byLeft: boolean,
  timestamp: number,
  env: RuntimeState | undefined,
  registeredBoardHash?: string,
): Promise<void> => {
  if (!env) throw new Error('SETTLEMENT_SEAL_ENV_MISSING');
  const prepared = prepareSettlementSeal(draft, transition, env);
  const verified = await verifySettlementSealHankos(
    draft,
    transition,
    byLeft,
    env,
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
  const current = account.settlementWorkspace;
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
    const currentHash = assertCanonicalSettlementWorkspace(account, current);
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
  workspace.workspaceHash = createSettlementWorkspaceHash(account, workspace);
  return workspace;
};

const commitDraft = (
  account: AccountReplica,
  draft: AccountReplica,
  changedTokens: ReadonlySet<number>,
): void => {
  for (const tokenId of changedTokens) {
    const source = draft.deltas.get(tokenId);
    const target = account.deltas.get(tokenId);
    if (!source || !target) throw new Error(`SETTLEMENT_HOLD_COMMIT_DELTA_MISSING:token=${tokenId}`);
    target.leftHold = getHold(source, 'left');
    target.rightHold = getHold(source, 'right');
  }
  if (draft.settlementWorkspace) account.settlementWorkspace = draft.settlementWorkspace;
  else delete account.settlementWorkspace;
};

// AccountSettled is bilateral Account consensus too. If it wins a retry race,
// release the exact workspace holds before removing the workspace body.
export function clearFinalizedSettlementWorkspace(account: AccountReplica): void {
  const draft = cloneAccountState(account);
  const workspace = draft.settlementWorkspace;
  if (!workspace) return;
  assertCanonicalSettlementWorkspace(draft, workspace);
  const changed = workspace.status === 'submitted'
    ? new Set<number>()
    : releaseWorkspaceHolds(draft, workspace);
  delete draft.settlementWorkspace;
  commitDraft(account, draft, changed);
}

export const getSignedSettlementWorkspaceTxError = (
  account: AccountReplica,
  tx: AccountTx,
): string | undefined => {
  const workspace = account.settlementWorkspace;
  if (
    !workspace ||
    (!workspace.settlementHash && !workspace.leftHanko && !workspace.rightHanko && !workspace.postSettlementDisputeProof)
  ) return undefined;
  if (tx.type === 'j_event_claim' || tx.type === 'reopen_disputed') return undefined;
  if (tx.type === 'settle_transition' && (tx.data.kind === 'seal' || tx.data.kind === 'submit')) return undefined;
  return `SETTLEMENT_SIGNED_ACCOUNT_FROZEN:${tx.type}`;
};

export async function handleSettleTransition(
  account: AccountReplica,
  tx: SettleTransitionTx,
  byLeft: boolean,
  timestamp: number,
  env?: RuntimeState,
  registeredBoardHash?: string,
): Promise<ApplyAccountTxResult> {
  try {
    const draft = cloneAccountState(account);
    const changed = new Set<number>();
    const transition = tx.data;
    if (transition.kind === 'upsert') {
      const previous = draft.settlementWorkspace;
      const next = buildUpsertWorkspace(draft, transition, byLeft, timestamp);
      if (previous) {
        for (const tokenId of releaseWorkspaceHolds(draft, previous)) changed.add(tokenId);
      }
      draft.settlementWorkspace = next;
      for (const tokenId of addWorkspaceHolds(draft, next)) changed.add(tokenId);
      commitDraft(account, draft, changed);
      transitionLog.debug('workspace.upserted', { revision: next.revision, hash: next.workspaceHash });
      return { success: true, events: [`Settlement workspace v${next.revision} committed`] };
    }

    if (transition.kind === 'seal') {
      await applySettlementSeal(draft, transition, byLeft, timestamp, env, registeredBoardHash);
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
    delete draft.settlementWorkspace;
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
