import type {
  AccountMachine,
  EntityInput,
  EntityState,
  EntityTx,
  Env,
  RuntimeOverlayRecord,
} from '../../../../types';
import type { ProofBodyStruct } from '../../../../../jurisdictions/typechain-types/contracts/Depository.sol/Depository';
import { addMessage, cloneEntityState } from '../../../../state-helpers';
import {
  assertDisputeArgumentsWithinContractLimits,
  assertDisputeProofBodyWithinContractLimits,
  encodeJBatch,
  getBatchSize,
  initJBatch,
  J_BATCH_CONTRACT_LIMITS,
  sanitizeOptionalDisputeStarterArgumentPair,
} from '../../../../jurisdiction/batch';
import {
  createDisputeProofHashWithNonce,
  hashProofBodyStruct,
} from '../../../../protocol/dispute/proof-builder';
import { buildAccountProofBodyFromEnv } from '../../../../account/consensus/helpers';
import { verifyHankoForHash } from '../../../../hanko/signing';
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardHash,
} from '../../../../jurisdiction/board-registry';
import {
  buildDisputeArgumentsForSnapshot,
  requireDisputeArgumentSnapshot,
  type DisputeArgumentSide,
} from '../../../../protocol/dispute/arguments';
import { isCrossJurisdictionTerminalStatus } from '../../../../extensions/cross-j';
import { shortHash, shortId } from '../../../../infra/logger';
import {
  freezeAccountForDispute,
  isDisputeStartedByLeft,
} from '../../../../account/consensus/dispute-policy';
import {
  canonicalizeProofBodyStruct,
  collectDisputeEvidenceReadinessIssues,
  disputeLog,
  hasQueuedDisputeStart,
  reportOptionalArgumentWarnings,
  requireProofBodyStruct,
  resolveDepositoryHankoDomain,
} from './shared';

type StartTx = Extract<EntityTx, { type: 'disputeStart' }>;

type StartEvidence = {
  initialProofbody: ProofBodyStruct;
  proofBodyHash: string;
  counterpartyHanko: string;
  storedDisputeHash?: string;
  signedNonce: number;
  nonceSource: string;
  jNonce: number;
  starterInitialArguments: string;
  starterIncrementedArguments: string;
};

const validateCrossJurisdictionRoute = (
  state: EntityState,
  tx: StartTx,
): void => {
  const routeId = tx.data.crossJurisdictionRouteId;
  if (!routeId) return;
  const route = state.crossJurisdictionSwaps?.get(routeId);
  if (!route || route.orderId !== routeId) {
    throw new Error(`DISPUTE_START_CROSS_J_ROUTE_MISSING:${routeId}`);
  }
  const localEntityId = state.entityId.toLowerCase();
  const counterpartyId = tx.data.counterpartyEntityId.toLowerCase();
  const isSourceAccount =
    route.source.entityId.toLowerCase() === localEntityId &&
    route.source.counterpartyEntityId.toLowerCase() === counterpartyId;
  const isTargetAccount =
    route.target.counterpartyEntityId.toLowerCase() === localEntityId &&
    route.target.entityId.toLowerCase() === counterpartyId;
  if (!isSourceAccount && !isTargetAccount) {
    throw new Error(`DISPUTE_START_CROSS_J_ROUTE_ROLE_MISMATCH:${routeId}`);
  }
  if (isCrossJurisdictionTerminalStatus(route.status) || !route.targetPull) {
    throw new Error(`DISPUTE_START_CROSS_J_ROUTE_INACTIVE:${routeId}:${route.status}`);
  }
};

const admitDisputeStart = (
  state: EntityState,
  counterpartyId: string,
): AccountMachine | null => {
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

const loadStartProof = (
  sourceState: EntityState,
  state: EntityState,
  account: AccountMachine,
  counterpartyId: string,
): Omit<StartEvidence, 'signedNonce' | 'nonceSource' | 'jNonce' | 'starterInitialArguments' | 'starterIncrementedArguments'> | null => {
  const counterpartyHanko = account.counterpartyDisputeProofHanko;
  if (!counterpartyHanko || counterpartyHanko === '0x' || counterpartyHanko.length <= 2) {
    addMessage(state, '❌ Missing counterparty dispute hanko - cannot start dispute');
    disputeLog.error('start.hanko_missing', { counterparty: shortId(counterpartyId) });
    return null;
  }
  disputeLog.debug('start.hanko_loaded', {
    counterparty: shortId(counterpartyId),
    length: counterpartyHanko.length,
    prefix: shortHash(counterpartyHanko, 18),
    sigBytes: Math.max(counterpartyHanko.length - 2, 0) / 2,
  });
  const proofBodyHash = account.counterpartyDisputeProofBodyHash;
  if (!proofBodyHash) {
    addMessage(
      state,
      '❌ Missing stored counterparty proofBodyHash - cannot start dispute safely',
    );
    disputeLog.error('start.proof_body_hash_missing', { counterparty: shortId(counterpartyId) });
    return null;
  }
  const initialProofbody = canonicalizeProofBodyStruct(
    requireProofBodyStruct(
      account.disputeProofBodiesByHash?.[proofBodyHash],
      sourceState.entityId,
      counterpartyId,
      'disputeStart.initial',
    ),
    sourceState.entityId,
    counterpartyId,
    'disputeStart.initial',
  );
  assertDisputeProofBodyWithinContractLimits(initialProofbody, 'disputeStart.initial');
  const revealedHash = hashProofBodyStruct(initialProofbody);
  if (revealedHash.toLowerCase() !== proofBodyHash.toLowerCase()) {
    throw new Error(
      `DISPUTE_START_PROOFBODY_HASH_MISMATCH:${counterpartyId}:${proofBodyHash}:${revealedHash}`,
    );
  }
  requireDisputeArgumentSnapshot(account, proofBodyHash, 'disputeStart.initial');
  return {
    initialProofbody,
    proofBodyHash,
    counterpartyHanko,
    ...(account.counterpartyDisputeHash
      ? { storedDisputeHash: account.counterpartyDisputeHash }
      : {}),
  };
};

const resolveStartNonce = (
  state: EntityState,
  account: AccountMachine,
  counterpartyId: string,
  proofBodyHash: string,
): Pick<StartEvidence, 'signedNonce' | 'nonceSource' | 'jNonce'> | null => {
  let signedNonce = account.proofHeader.nextProofNonce;
  let nonceSource = 'proofHeader';
  const mappedNonce = account.disputeProofNoncesByHash?.[proofBodyHash];
  if (mappedNonce !== undefined) {
    signedNonce = mappedNonce;
    nonceSource = 'hashMap';
  } else if (account.counterpartyDisputeProofNonce !== undefined) {
    signedNonce = account.counterpartyDisputeProofNonce;
    nonceSource = 'counterpartySig';
  }
  if (
    account.counterpartyDisputeProofNonce !== undefined &&
    account.counterpartyDisputeProofNonce > signedNonce
  ) {
    signedNonce = account.counterpartyDisputeProofNonce;
    nonceSource = 'counterpartySig(fresher)';
  }
  if (signedNonce <= 0) {
    addMessage(state, `❌ Invalid dispute signedNonce=${signedNonce} — must be > 0`);
    disputeLog.error('start.signed_nonce_invalid', {
      counterparty: shortId(counterpartyId),
      signedNonce,
      nonceSource,
    });
    return null;
  }
  const jNonce = Number(account.jNonce ?? 0);
  disputeLog.debug('start.nonce', {
    counterparty: shortId(counterpartyId),
    signedNonce,
    nonceSource,
    jNonce,
  });
  if (signedNonce <= jNonce) {
    addMessage(
      state,
      `❌ Stale dispute proof nonce ${signedNonce} (on-chain=${jNonce}) - reopen required`,
    );
    disputeLog.warn('start.nonce_stale', {
      counterparty: shortId(counterpartyId),
      signedNonce,
      jNonce,
    });
    return null;
  }
  return { signedNonce, nonceSource, jNonce };
};

const buildStarterArguments = (
  state: EntityState,
  account: AccountMachine,
  counterpartyId: string,
  proofBodyHash: string,
  signedNonce: number,
  overrideInitial: string | undefined,
  env: Env,
): Pick<StartEvidence, 'starterInitialArguments' | 'starterIncrementedArguments'> => {
  const starterIsLeft = account.leftEntity === state.entityId;
  const starterSide: DisputeArgumentSide = starterIsLeft ? 'left' : 'right';
  const initial = buildDisputeArgumentsForSnapshot(
    account,
    state,
    counterpartyId,
    proofBodyHash,
    { secretsSide: starterSide },
  );
  const rawInitial =
    overrideInitial && overrideInitial !== '0x'
      ? overrideInitial
      : starterIsLeft
        ? initial.leftArguments
        : initial.rightArguments;
  const candidates = Object.values(account.disputeArgumentSnapshotsByHash ?? {})
    .filter(snapshot => snapshot.side === starterSide && snapshot.nonce > signedNonce)
    .sort((left, right) => left.nonce - right.nonce);
  if (candidates.length > 1) {
    throw new Error(
      `DISPUTE_START_IMPOSSIBLE_MULTIPLE_INCREMENTED_SNAPSHOTS:${counterpartyId}:` +
      candidates.map(snapshot => `${snapshot.nonce}:${snapshot.proofbodyHash}`).join(','),
    );
  }
  const warnings = [...initial.warnings];
  let rawIncremented = '0x';
  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    const incremented = buildDisputeArgumentsForSnapshot(
      account,
      state,
      counterpartyId,
      candidate.proofbodyHash,
      { secretsSide: starterSide },
    );
    rawIncremented = starterIsLeft
      ? incremented.leftArguments
      : incremented.rightArguments;
    warnings.push(...incremented.warnings);
  }
  const sanitized = sanitizeOptionalDisputeStarterArgumentPair(
    rawInitial,
    rawIncremented,
    'disputeStart.starterArguments',
  );
  warnings.push(...sanitized.warnings);
  reportOptionalArgumentWarnings(env, counterpartyId, warnings);
  assertDisputeArgumentsWithinContractLimits(
    [sanitized.initial, sanitized.incremented],
    'disputeStart.starterArguments',
  );
  return {
    starterInitialArguments: sanitized.initial,
    starterIncrementedArguments: sanitized.incremented,
  };
};

const verifyStartHanko = async (
  sourceState: EntityState,
  state: EntityState,
  account: AccountMachine,
  counterpartyId: string,
  evidence: StartEvidence,
  env: Env,
): Promise<boolean> => {
  const domain = resolveDepositoryHankoDomain(sourceState);
  if (!domain) {
    addMessage(state, '❌ disputeStart blocked: missing jurisdiction depository address');
    return false;
  }
  const disputeHash = createDisputeProofHashWithNonce(
    account,
    evidence.proofBodyHash,
    domain,
    evidence.signedNonce,
  );
  if (
    evidence.storedDisputeHash?.startsWith('0x') &&
    evidence.storedDisputeHash.toLowerCase() !== disputeHash.toLowerCase()
  ) {
    throw new Error(
      `DISPUTE_STORED_HASH_MISMATCH:${counterpartyId}:${evidence.storedDisputeHash}:${disputeHash}`,
    );
  }
  const boardHash = resolveObserverCertifiedBoardHash(
    sourceState,
    getCertifiedBoardNodeStore(env),
    counterpartyId,
  );
  const verification = await verifyHankoForHash(
    evidence.counterpartyHanko,
    disputeHash,
    counterpartyId,
    env,
    boardHash ? { registeredBoardHash: boardHash } : undefined,
  );
  if (verification.valid) return true;
  const currentProof = buildAccountProofBodyFromEnv(env, account);
  addMessage(
    state,
    `❌ Counterparty dispute proof invalid for current account snapshot; ` +
    `nonce=${evidence.signedNonce} onChain=${evidence.jNonce} source=${evidence.nonceSource}`,
  );
  disputeLog.error('start.preflight_failed', {
    entityId: sourceState.entityId,
    counterpartyEntityId: counterpartyId,
    signedNonce: evidence.signedNonce,
    nonceSource: evidence.nonceSource,
    jNonce: evidence.jNonce,
    proofHeaderNonce: account.proofHeader.nextProofNonce,
    counterpartyDisputeProofNonce: account.counterpartyDisputeProofNonce,
    storedProofBodyHash: evidence.proofBodyHash,
    storedDisputeHash: evidence.storedDisputeHash,
    currentProofBodyHash: currentProof.proofBodyHash,
    storedHashMatchesCurrent: evidence.proofBodyHash === currentProof.proofBodyHash,
    pendingFrameHeight: account.pendingFrame?.height ?? null,
    currentFrameHeight: account.currentFrame?.height ?? null,
    currentHeight: account.currentHeight,
    lockCount: account.locks?.size ?? 0,
    swapOfferCount: account.swapOffers?.size ?? 0,
    knownDisputeProofHashes: Object.keys(account.disputeProofNoncesByHash ?? {}),
    disputeHashSource: evidence.storedDisputeHash ? 'stored+recomputed' : 'recomputed',
    disputeHash,
    depositoryAddress: domain.depositoryAddress,
    recoveredEntityId: verification.entityId,
    hankoBytes: Math.max(evidence.counterpartyHanko.length - 2, 0) / 2,
  });
  return false;
};

const queueDisputeStart = (
  sourceState: EntityState,
  state: EntityState,
  account: AccountMachine,
  tx: StartTx,
  evidence: StartEvidence,
  outputs: EntityInput[],
): void => {
  const batch = state.jBatchState!.batch;
  if (batch.disputeStarts.length >= J_BATCH_CONTRACT_LIMITS.maxDisputeStarts) {
    throw new Error(
      `J_BATCH_LIMIT_EXCEEDED: disputeStarts ${batch.disputeStarts.length + 1}/` +
      `${J_BATCH_CONTRACT_LIMITS.maxDisputeStarts}`,
    );
  }
  if (getBatchSize(batch) + 1 > J_BATCH_CONTRACT_LIMITS.maxTotalOps) {
    throw new Error(
      `J_BATCH_LIMIT_EXCEEDED: disputeStart would exceed total ops ${getBatchSize(batch) + 1}/` +
      `${J_BATCH_CONTRACT_LIMITS.maxTotalOps}`,
    );
  }
  batch.disputeStarts.push({
    counterentity: tx.data.counterpartyEntityId,
    nonce: evidence.signedNonce,
    proofbodyHash: evidence.proofBodyHash,
    initialProofbody: evidence.initialProofbody,
    watchSeed: String(evidence.initialProofbody.watchSeed),
    sig: evidence.counterpartyHanko,
    starterInitialArguments: evidence.starterInitialArguments,
    starterIncrementedArguments: evidence.starterIncrementedArguments,
  });
  encodeJBatch(batch);
  if (tx.data.crossJurisdictionRouteId) {
    state.jBatchState!.autoBroadcastDraft = true;
    if (!state.jBatchState!.sentBatch) {
      const signerId = state.config.validators[0];
      if (!signerId) throw new Error('DISPUTE_START_CROSS_J_BROADCAST_SIGNER_MISSING');
      outputs.push({
        entityId: state.entityId,
        signerId,
        entityTxs: [{ type: 'j_broadcast', data: {} }],
      });
    }
  }
  account.status = 'disputed';
  delete account.disputePrepare;
  freezeAccountForDispute(account, false);
  account.activeDispute ??= {
    startedByLeft: isDisputeStartedByLeft(
      sourceState.entityId,
      account.leftEntity,
      account.rightEntity,
    ),
    initialProofbodyHash: evidence.proofBodyHash,
    initialNonce: evidence.signedNonce,
    // Depository chooses the authoritative timeout at inclusion height.
    disputeTimeout: 0,
    jNonce: evidence.jNonce,
    starterInitialArguments: evidence.starterInitialArguments,
    starterIncrementedArguments: evidence.starterIncrementedArguments,
    observedOnChain: false,
    finalizeQueued: false,
  };
};

export const handleDisputeStart = async (
  entityState: EntityState,
  entityTx: StartTx,
  env: Env,
  _storageChanges: RuntimeOverlayRecord[] = [],
): Promise<{ newState: EntityState; outputs: EntityInput[] }> => {
  if (entityTx.data.starterIncrementedArguments !== undefined) {
    throw new Error('DISPUTE_INCREMENTED_ARGUMENT_OVERRIDE_UNSUPPORTED');
  }
  validateCrossJurisdictionRoute(entityState, entityTx);
  const counterpartyId = entityTx.data.counterpartyEntityId;
  const newState = cloneEntityState(entityState);
  const outputs: EntityInput[] = [];
  disputeLog.debug('start.begin', {
    entity: shortId(entityState.entityId),
    counterparty: shortId(counterpartyId),
  });
  const account = admitDisputeStart(newState, counterpartyId);
  if (!account) return { newState, outputs };
  const proof = loadStartProof(entityState, newState, account, counterpartyId);
  if (!proof) return { newState, outputs };
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
  queueDisputeStart(entityState, newState, account, entityTx, evidence, outputs);
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
