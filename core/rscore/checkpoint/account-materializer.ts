/**
 * Pure Rust Account checkpoint -> canonical TypeScript AccountReplica materializer.
 *
 * Rust owns the five financial maps and Account consensus. Entity-private
 * collections remain bodies owned by the TypeScript Entity shell; the Rust
 * row commits only their roots, so they may cross this boundary solely by
 * exact root-checked structural reuse from the prior committed replica.
 */
import {
  computeAccountStateRoot,
  computeAccountStateRootCold,
  EMPTY_ACCOUNT_STATE_ROOT,
} from '../../account/commitment/state-root';
import { accountInputAck, accountInputProposal } from '../../account/consensus/flush';
import { encodeAccountStateValue } from '../../account/commitment/account-state-value';
import { forkAccountReplicaShell } from '../../account/state/account-replica-shell';
import {
  PersistentAccountStateMap,
  requirePersistentAccountStateMap,
  type AccountStateCollection,
  type AccountStateMapKey,
  type AccountStateMapNamespace,
} from '../../account/state/persistent-state-map';
import { validateAccountReplica } from '../../account/validation/state-validation';
import {
  computeEntityAccountLeafDigest,
  projectEntityAccountLeaf,
} from '../../entity/consensus/state-root';
import {
  cloneIsolatedAccountFrame,
  cloneIsolatedAccountTx,
  copyAccountDisputeConfig,
  copyAccountStateDomain,
} from '../../protocol/state/account-input-clone';
import { buffersEqual, compareStableText } from '../../protocol/serialization';
import type {
  AccountDisputeHanko,
  AccountFrame,
  AccountInput,
  AccountReplica,
  AccountState,
} from '../../types/account';
import type { HankoString } from '../../types/hanko';
import type { RscoreDisputeDraft, RscoreOutboundAck } from './checkpoint-restore-consensus';
import type { RscoreAccountStateSeed } from './checkpoint-restore-state';
import { projectRscoreCommittedEnvelopeFields } from './checkpoint-restore';
import { RSCORE_CUTOVER_VERIFY } from '../cutover/verify';
import type {
  RscoreAccountCheckpointRow,
  RscoreResolvedAccountRow,
} from './wave-checkpoint-decode';

export type RscoreAccountMaterializerBinding = Readonly<{
  /** Entity bound by the live authority process Hello response. */
  sessionOwnerEntityId: string;
  /** Exact signer id used to derive that session's key. */
  expectedSignerId: string;
}>;

type RscoreAccountLocalHashToSign = Readonly<{
  hash: string;
  type: 'accountFrame' | 'dispute';
  context: string;
}>;

/**
 * Exact fresh secondary-hash manifest emitted by the staged Rust wave.
 *
 * Absence from this list means reuse, which is accepted only when the prior
 * TypeScript Account already contains the exact certified witness. Rust-local
 * Hankos in the checkpoint row are never authority for either branch.
 */
export type RscoreAccountLocalWitnessPlan = Readonly<{
  freshHashesToSign: readonly RscoreAccountLocalHashToSign[];
}>;

export type RscoreAccountMaterialization = Readonly<{
  account: AccountReplica;
  /** Feed these exact rows into the Entity frame's secondary-hash manifest. */
  hashesToSign: readonly RscoreAccountLocalHashToSign[];
}>;

const fail = (code: string): never => {
  throw new Error(`RSCORE_MATERIALIZE_${code}`);
};

const canonicalEntityId = (value: string, field: string): string => {
  if (!/^0x[0-9a-f]{64}$/.test(value)) return fail(`${field}_ENTITY_ID`);
  return value;
};

const canonicalRoot = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) {
    return fail(`${field}_ROOT`);
  }
  return value;
};

const record = (value: unknown, field: string): Readonly<Record<string, unknown>> => {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || value instanceof Map
    || value instanceof Set
  ) {
    return fail(`${field}_OBJECT`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const canonicalEqual = (left: unknown, right: unknown): boolean =>
  buffersEqual(
    Buffer.from(encodeAccountStateValue(left)),
    Buffer.from(encodeAccountStateValue(right)),
  );

const requireCanonicalEqual = (actual: unknown, expected: unknown, field: string): void => {
  if (!canonicalEqual(actual, expected)) fail(`${field}_MISMATCH`);
};

const committedMap = <K extends AccountStateMapKey, V>(
  namespace: AccountStateMapNamespace,
  value: AccountStateCollection<K, V>,
  expectedRoot: string,
  field: string,
): PersistentAccountStateMap<K, V> => {
  const map = requirePersistentAccountStateMap(value, namespace);
  if (map.rootHash() !== expectedRoot) fail(`${field}_ROOT_MISMATCH`);
  if (map.coldRootHash() !== expectedRoot) fail(`${field}_COLD_ROOT_MISMATCH`);
  return map;
};

const carriedMap = <K extends AccountStateMapKey, V>(
  namespace: AccountStateMapNamespace,
  expectedRoot: string,
  prior: AccountStateCollection<K, V> | undefined,
  create: boolean,
  field: string,
): PersistentAccountStateMap<K, V> => {
  if (create) {
    if (expectedRoot !== EMPTY_ACCOUNT_STATE_ROOT) fail(`CREATE_${field}_ROOT_NONEMPTY`);
    return PersistentAccountStateMap.empty<K, V>(namespace);
  }
  if (prior === undefined) {
    if (expectedRoot !== EMPTY_ACCOUNT_STATE_ROOT) fail(`${field}_BODY_MISSING`);
    return PersistentAccountStateMap.empty<K, V>(namespace);
  }
  return committedMap(namespace, prior, expectedRoot, field);
};

type LocalWitnessResolver = Readonly<{
  frame(hash: string, context?: string): HankoString | undefined;
  dispute(draft: RscoreDisputeDraft, context?: string): HankoString | undefined;
  finish(): readonly RscoreAccountLocalHashToSign[];
}>;

const disputeKey = (draft: RscoreDisputeDraft): string => [
  draft.hash.toLowerCase(),
  draft.proofBodyHash.toLowerCase(),
  draft.nonce,
  draft.proposerIsLeft ? 1 : 0,
].join(':');

const addPriorWitness = (
  witnesses: Map<string, HankoString>,
  key: string,
  hanko: string | undefined,
): void => {
  if (typeof hanko !== 'string' || hanko.length === 0) return;
  const existing = witnesses.get(key);
  if (existing !== undefined && existing !== hanko) fail(`PRIOR_LOCAL_WITNESS_EQUIVOCATION:${key}`);
  witnesses.set(key, hanko as HankoString);
};

const addPriorInputWitnesses = (
  frameWitnesses: Map<string, HankoString>,
  disputeWitnesses: Map<string, HankoString>,
  input: AccountInput | undefined,
): void => {
  if (input === undefined) return;
  const ack = accountInputAck(input);
  const proposal = accountInputProposal(input);
  if (ack) {
    addPriorWitness(frameWitnesses, ack.frameHash.toLowerCase(), ack.frameHanko);
    if (ack.disputeHanko) {
      addPriorWitness(disputeWitnesses, disputeKey({
        hash: ack.disputeHanko.hash,
        proofBodyHash: ack.disputeHanko.proofBodyHash,
        nonce: ack.disputeHanko.proofNonce,
        proposerIsLeft: ack.disputeHanko.proposerIsLeft,
      }), ack.disputeHanko.hanko);
    }
  }
  if (proposal) {
    addPriorWitness(frameWitnesses, proposal.frame.stateHash.toLowerCase(), proposal.frameHanko);
    if (proposal.disputeHanko) {
      addPriorWitness(disputeWitnesses, disputeKey({
        hash: proposal.disputeHanko.hash,
        proofBodyHash: proposal.disputeHanko.proofBodyHash,
        nonce: proposal.disputeHanko.proofNonce,
        proposerIsLeft: proposal.disputeHanko.proposerIsLeft,
      }), proposal.disputeHanko.hanko);
    }
  }
};

const priorLocalWitnesses = (
  prior: AccountReplica | null,
): Readonly<{
  frames: Map<string, HankoString>;
  disputes: Map<string, HankoString>;
}> => {
  const frames = new Map<string, HankoString>();
  const disputes = new Map<string, HankoString>();
  if (prior === null) return { frames, disputes };
  addPriorInputWitnesses(frames, disputes, prior.lastOutboundAckFrame?.response);
  addPriorInputWitnesses(frames, disputes, prior.pendingAccountInput);
  const localFrameHash = prior.pendingFrame?.stateHash ?? prior.currentFrame.stateHash;
  if (localFrameHash.length > 0) {
    addPriorWitness(frames, localFrameHash.toLowerCase(), prior.currentFrameHanko);
  }
  if (
    prior.currentDisputeHash !== undefined
    && prior.currentDisputeProofBodyHash !== undefined
    && prior.currentDisputeProofNonce !== undefined
    && prior.currentDisputeProofProposerIsLeft !== undefined
  ) {
    addPriorWitness(disputes, disputeKey({
      hash: prior.currentDisputeHash,
      proofBodyHash: prior.currentDisputeProofBodyHash,
      nonce: prior.currentDisputeProofNonce,
      proposerIsLeft: prior.currentDisputeProofProposerIsLeft,
    }), prior.currentDisputeProofHanko);
  }
  return { frames, disputes };
};

const localWitnessResolver = (
  plan: RscoreAccountLocalWitnessPlan,
  prior: AccountReplica | null,
): LocalWitnessResolver => {
  const fresh = new Map<string, RscoreAccountLocalHashToSign>();
  for (const entry of plan.freshHashesToSign) {
    const hash = canonicalRoot(entry.hash, 'LOCAL_WITNESS_PLAN').toLowerCase();
    if (
      (entry.type !== 'accountFrame' && entry.type !== 'dispute')
      || entry.hash !== hash
      || entry.context.length === 0
      || entry.context.trim() !== entry.context
    ) {
      fail('LOCAL_WITNESS_PLAN_ENTRY_INVALID');
    }
    if (fresh.has(hash)) fail(`LOCAL_WITNESS_PLAN_DUPLICATE:${hash}`);
    fresh.set(hash, entry);
  }
  const priorWitnesses = priorLocalWitnesses(prior);
  const consumed = new Set<string>();
  const resolve = (
    type: 'accountFrame' | 'dispute',
    hash: string,
    key: string,
    context: string | undefined,
  ): HankoString | undefined => {
    const normalized = hash.toLowerCase();
    const freshEntry = fresh.get(normalized);
    if (freshEntry !== undefined) {
      if (freshEntry.type !== type) fail(`LOCAL_WITNESS_PLAN_TYPE_MISMATCH:${normalized}`);
      if (context === undefined || freshEntry.context !== context) {
        fail(`LOCAL_WITNESS_PLAN_CONTEXT_MISMATCH:${normalized}`);
      }
      consumed.add(normalized);
      return undefined;
    }
    const reused = type === 'accountFrame'
      ? priorWitnesses.frames.get(key)
      : priorWitnesses.disputes.get(key);
    if (reused === undefined) fail(`LOCAL_WITNESS_PLAN_INCOMPLETE:${type}:${normalized}`);
    return reused;
  };
  return {
    frame: (hash, context) => resolve('accountFrame', hash, hash.toLowerCase(), context),
    dispute: (draft, context) => resolve('dispute', draft.hash, disputeKey(draft), context),
    finish: () => {
      const unused = [...fresh.keys()].filter(hash => !consumed.has(hash));
      if (unused.length > 0) fail(`LOCAL_WITNESS_PLAN_UNUSED:${unused.join(',')}`);
      return plan.freshHashesToSign.map(entry => ({ ...entry }));
    },
  };
};

const disputeHanko = (
  witnesses: LocalWitnessResolver,
  draft: RscoreDisputeDraft,
  context: string,
): AccountDisputeHanko => {
  const hanko = witnesses.dispute(draft, context);
  return {
    ...(hanko === undefined ? {} : { hanko }),
    hash: draft.hash,
    proofBodyHash: draft.proofBodyHash,
    proofNonce: draft.nonce,
    proposerIsLeft: draft.proposerIsLeft,
  };
};

const ackInput = (
  seed: RscoreAccountStateSeed,
  witnesses: LocalWitnessResolver,
  ack: RscoreOutboundAck,
): Extract<AccountInput, { kind: 'ack' }> => {
  const prefix = `account:${seed.accountId.slice(-8)}`;
  const frameHanko = witnesses.frame(ack.frameHash, `${prefix}:ack:${ack.height}`);
  return {
    kind: 'ack',
    fromEntityId: seed.ownerEntityId,
    toEntityId: seed.accountId,
    domain: copyAccountStateDomain(seed.domain),
    disputeConfig: copyAccountDisputeConfig(seed.disputeConfig),
    watchSeed: seed.watchSeed,
    ack: {
      height: ack.height,
      frameHash: ack.frameHash,
      ...(frameHanko === undefined ? {} : { frameHanko }),
      ...(ack.dispute
        ? { disputeHanko: disputeHanko(witnesses, ack.dispute, `${prefix}:ack-dispute`) }
        : {}),
    },
  };
};

const pendingInput = (
  seed: RscoreAccountStateSeed,
  witnesses: LocalWitnessResolver,
  pending: NonNullable<RscoreResolvedAccountRow['decoded']['consensus']['pending']>,
): Extract<AccountInput, { kind: 'ack_frame' }> => {
  const prefix = `account:${seed.accountId.slice(-8)}`;
  const frameHanko = witnesses.frame(
    pending.frame.stateHash,
    `${prefix}:frame:${pending.frame.height}`,
  );
  const proposal = {
    frame: cloneIsolatedAccountFrame(pending.frame),
    ...(frameHanko === undefined ? {} : { frameHanko }),
    ...(pending.proposalDispute
      ? {
          disputeHanko: disputeHanko(
            witnesses,
            pending.proposalDispute,
            `${prefix}:dispute`,
          ),
        }
      : {}),
  };
  const common = {
    fromEntityId: seed.ownerEntityId,
    toEntityId: seed.accountId,
    domain: copyAccountStateDomain(seed.domain),
    disputeConfig: copyAccountDisputeConfig(seed.disputeConfig),
    watchSeed: seed.watchSeed,
    proposal,
  };
  if (pending.bundledAck === undefined) return { kind: 'ack_frame', ...common };
  return {
    kind: 'ack_frame',
    ...common,
    ack: ackInput(seed, witnesses, pending.bundledAck).ack,
  };
};

const h0Frame = (accountStateRoot: string): AccountFrame => ({
  height: 0,
  timestamp: 0,
  jHeight: 0,
  accountTxs: [],
  prevFrameHash: '',
  accountStateRoot,
  stateHash: '',
});

const assertPriorBinding = (
  prior: AccountReplica,
  ownerEntityId: string,
  accountId: string,
  seed: RscoreAccountStateSeed,
  currentFrame: AccountFrame,
): void => {
  validateAccountReplica(prior, 'rscore.materialize.prior');
  if (prior.proofHeader.fromEntity !== ownerEntityId) fail('PRIOR_OWNER_MISMATCH');
  if (prior.proofHeader.toEntity !== accountId) fail('PRIOR_ACCOUNT_MISMATCH');
  requireCanonicalEqual(prior.state.domain, seed.domain, 'PRIOR_DOMAIN');
  requireCanonicalEqual(prior.state.disputeConfig, seed.disputeConfig, 'PRIOR_DISPUTE_CONFIG');
  if (
    prior.state.leftEntity !== seed.leftEntity
    || prior.state.rightEntity !== seed.rightEntity
    || prior.state.watchSeed !== seed.watchSeed
  ) {
    fail('PRIOR_IDENTITY_MISMATCH');
  }
  if (prior.currentHeight > currentFrame.height) fail('PRIOR_HEIGHT_STALE');
  if (
    prior.currentHeight === currentFrame.height
    && prior.currentFrame.stateHash !== currentFrame.stateHash
  ) {
    fail('PRIOR_FRAME_FORK');
  }
  if (prior.state.jNonce > seed.jNonce) fail('PRIOR_J_NONCE_STALE');
  if (prior.state.lastFinalizedJHeight > seed.lastFinalizedJHeight) {
    fail('PRIOR_J_HEIGHT_STALE');
  }
};

/**
 * The carried halves the engine does not author. With no envelope on the wire
 * there is nothing to reconcile: the Entity's own Account already holds them,
 * and a row that changed them would have carried the change in a section.
 */
const envelopeCollections = (
  fields: Readonly<Record<string, unknown>> | null,
  prior: AccountReplica | null,
  policyRows: readonly (readonly [number, import('../../types/finance/rebalance').RebalancePolicy])[] | null,
  submittedRows: readonly (readonly [number, number])[] | null,
): Pick<AccountReplica, 'pendingWithdrawals' | 'shadow'> => {
  if (fields === null) {
    if (prior === null) return fail('ENVELOPE_REQUIRED_ON_CREATE');
    return { pendingWithdrawals: prior.pendingWithdrawals, shadow: prior.shadow };
  }
  const create = prior === null;
  const withdrawalRoot = canonicalRoot(fields['pendingWithdrawals'], 'PENDING_WITHDRAWALS');
  const pendingWithdrawals = carriedMap(
    'pendingWithdrawals',
    withdrawalRoot,
    prior?.pendingWithdrawals,
    create,
    'PENDING_WITHDRAWALS',
  );
  const shadowValue = record(fields['shadow'], 'SHADOW');
  const rebalanceValue = record(shadowValue['rebalance'], 'SHADOW_REBALANCE');
  const policyRoot = canonicalRoot(rebalanceValue['policyRoot'], 'SHADOW_POLICY');
  const submittedRoot = canonicalRoot(rebalanceValue['submittedAtByTokenRoot'], 'SHADOW_SUBMITTED');
  const presentPolicyRows = policyRows ?? fail('SHADOW_POLICY_BODY_MISSING');
  const policy = PersistentAccountStateMap.fromEntries(
    'rebalanceShadowPolicy',
    presentPolicyRows,
  );
  if (policy.rootHash() !== policyRoot) fail('SHADOW_POLICY_ROOT_MISMATCH');
  const presentSubmittedRows = submittedRows ?? fail('SHADOW_SUBMITTED_BODY_MISSING');
  const submittedAtByToken = PersistentAccountStateMap.fromEntries(
    'rebalanceShadowSubmitted',
    presentSubmittedRows,
  );
  if (submittedAtByToken.rootHash() !== submittedRoot) fail('SHADOW_SUBMITTED_ROOT_MISMATCH');
  const shadow: AccountReplica['shadow'] = create
    ? { rebalance: { policy, submittedAtByToken } }
    : {
        ...prior.shadow,
        rebalance: {
          ...prior.shadow.rebalance,
          policy,
          submittedAtByToken,
        },
      };
  const projectedShadow = {
    rebalance: {
      policyRoot: policy.rootHash(),
      submittedAtByTokenRoot: submittedAtByToken.rootHash(),
      ...(shadow.rebalance.activeQuote === undefined ? {} : { activeQuote: shadow.rebalance.activeQuote }),
      ...(shadow.rebalance.pendingRequest === undefined ? {} : { pendingRequest: shadow.rebalance.pendingRequest }),
    },
    ...(shadow.rejectedFrameEvidence === undefined
      ? {}
      : {
          rejectedFrameEvidence: {
            reason: shadow.rejectedFrameEvidence.reason,
            frameHash: shadow.rejectedFrameEvidence.frame.stateHash,
            frameHanko: shadow.rejectedFrameEvidence.frameHanko,
          },
        }),
  };
  requireCanonicalEqual(projectedShadow, shadowValue, 'SHADOW');
  return { pendingWithdrawals, shadow };
};

const stateFromSeed = (
  seed: RscoreAccountStateSeed,
  prior: AccountReplica | null,
): AccountState => {
  const create = prior === null;
  const subcontracts = carriedMap(
    'subcontracts', seed.carried.subcontractsRoot, prior?.state.subcontracts, create, 'SUBCONTRACTS',
  );
  const requestedRebalance = carriedMap(
    'requestedRebalance',
    seed.carried.requestedRebalanceRoot,
    prior?.state.requestedRebalance,
    create,
    'REQUESTED_REBALANCE',
  );
  const requestedRebalanceFeeState = carriedMap(
    'requestedRebalanceFeeState',
    seed.carried.requestedRebalanceFeeStateRoot,
    prior?.state.requestedRebalanceFeeState,
    create,
    'REQUESTED_REBALANCE_FEE_STATE',
  );
  return {
    leftEntity: seed.leftEntity,
    rightEntity: seed.rightEntity,
    domain: copyAccountStateDomain(seed.domain),
    watchSeed: seed.watchSeed,
    deltas: seed.deltas,
    locks: seed.locks,
    swapOffers: seed.swapOffers,
    pulls: seed.pulls,
    subcontracts,
    lendingIntents: seed.lendingIntents,
    leftPendingJClaims: { ...seed.carried.leftPendingJClaims },
    rightPendingJClaims: { ...seed.carried.rightPendingJClaims },
    lastFinalizedJHeight: seed.lastFinalizedJHeight,
    disputeConfig: copyAccountDisputeConfig(seed.disputeConfig),
    jNonce: seed.jNonce,
    requestedRebalance,
    requestedRebalanceFeeState,
    rebalanceFeePolicies: seed.rebalanceFeePolicies,
    ...(seed.settlementWorkspace === undefined
      ? {}
      : { settlementWorkspace: seed.settlementWorkspace }),
  };
};

const clearConsensusFields = (account: AccountReplica): void => {
  delete account.pendingFrame;
  delete account.pendingAccountInput;
  delete account.lastOutboundAckFrame;
  delete account.lastRollbackFrameHash;
  delete account.currentFrameHanko;
  delete account.counterpartyFrameHanko;
  delete account.currentDisputeProofHanko;
  delete account.currentDisputeHash;
  delete account.currentDisputeProofBodyHash;
  delete account.currentDisputeProofNonce;
  delete account.currentDisputeProofProposerIsLeft;
  delete account.counterpartyDisputeProofHanko;
  delete account.counterpartyDisputeHash;
  delete account.counterpartyDisputeProofBodyHash;
  delete account.counterpartyDisputeProofNonce;
  delete account.counterpartyDisputeProofProposerIsLeft;
};

const sameDisputeDraft = (
  left: RscoreDisputeDraft,
  right: RscoreDisputeDraft,
): boolean => disputeKey(left) === disputeKey(right);

const latestOutboundDisputeDraft = (
  consensus: RscoreResolvedAccountRow['decoded']['consensus'],
): RscoreDisputeDraft | undefined => consensus.pending?.proposalDispute
  ?? consensus.pending?.bundledAck?.dispute
  ?? consensus.lastOutboundAck?.dispute;

const latestOutboundDisputeContext = (
  consensus: RscoreResolvedAccountRow['decoded']['consensus'],
  accountId: string,
): string | undefined => {
  const prefix = `account:${accountId.slice(-8)}`;
  if (consensus.pending?.proposalDispute) return `${prefix}:dispute`;
  if (consensus.pending?.bundledAck?.dispute || consensus.lastOutboundAck?.dispute) {
    return `${prefix}:ack-dispute`;
  }
  return undefined;
};

const assertCurrentDisputeDraftOrder = (
  consensus: RscoreResolvedAccountRow['decoded']['consensus'],
): void => {
  const outbound = latestOutboundDisputeDraft(consensus);
  if (outbound !== undefined && (
    consensus.dispute === undefined || !sameDisputeDraft(outbound, consensus.dispute)
  )) {
    fail('LOCAL_DISPUTE_DRAFT_ORDER_MISMATCH');
  }
};

const assertMaterializedAccount = (
  account: AccountReplica,
  row: RscoreResolvedAccountRow,
): void => {
  if (!RSCORE_CUTOVER_VERIFY) return;
  validateAccountReplica(account, 'rscore.materialize.result');
  const expectedProjection = {
    ...projectRscoreCommittedEnvelopeFields(row.decoded.stateSeed.envelope?.fields ?? {}),
    accountStateRoot: row.decoded.accountStateRoot,
  };
  const projected = projectEntityAccountLeaf(account);
  requireCanonicalEqual(projected, expectedProjection, 'ENTITY_PROJECTION');
  const projectedLeaf = computeEntityAccountLeafDigest(
    Object.entries(projected).sort(([left], [right]) => compareStableText(left, right)),
  );
  if (projectedLeaf !== row.entityAccountLeaf) fail('ENTITY_LEAF_MISMATCH');
};

/**
 * Rebuild a fresh AccountReplica from one already-decoded Rust post-account
 * row. No TypeScript Account transition or proposal code is called.
 */
export const materializeRscoreAccountReplica = (
  binding: RscoreAccountMaterializerBinding,
  accountIdValue: string,
  row: RscoreResolvedAccountRow,
  prior: AccountReplica | null,
  witnessPlan: RscoreAccountLocalWitnessPlan,
): RscoreAccountMaterialization => {
  const ownerEntityId = canonicalEntityId(binding.sessionOwnerEntityId, 'SESSION_OWNER');
  const accountId = canonicalEntityId(accountIdValue, 'ACCOUNT');
  if (binding.expectedSignerId.length === 0 || binding.expectedSignerId.trim() !== binding.expectedSignerId) {
    fail('EXPECTED_SIGNER_ID_INVALID');
  }
  if (row.accountId !== accountId || row.decoded.accountId !== accountId) fail('ACCOUNT_BINDING_MISMATCH');
  if (row.entityAccountLeaf !== row.decoded.entityAccountLeaf) fail('LEAF_BINDING_MISMATCH');
  const { stateSeed: seed, consensus } = row.decoded;
  if (seed.ownerEntityId !== ownerEntityId) fail('OWNER_BINDING_MISMATCH');
  if (seed.signerId !== binding.expectedSignerId) fail('SIGNER_BINDING_MISMATCH');
  if (seed.accountId !== accountId) fail('SEED_ACCOUNT_BINDING_MISMATCH');
  const witnesses = localWitnessResolver(witnessPlan, prior);
  assertCurrentDisputeDraftOrder(consensus);

  const state = stateFromSeed(seed, prior);
  const accountStateRoot = row.decoded.accountStateRoot;
  if (RSCORE_CUTOVER_VERIFY) {
    if (computeAccountStateRoot(state, undefined, 'rscoreMaterialize') !== accountStateRoot) {
      fail('ACCOUNT_STATE_ROOT_MISMATCH');
    }
    if (computeAccountStateRootCold(state) !== accountStateRoot) fail('ACCOUNT_STATE_COLD_ROOT_MISMATCH');
  }
  const currentFrame = consensus.currentFrame
    ? cloneIsolatedAccountFrame(consensus.currentFrame)
    : h0Frame(accountStateRoot);
  if (prior !== null) {
    assertPriorBinding(prior, ownerEntityId, accountId, seed, currentFrame);
  }
  const fields = seed.envelope?.fields ?? null;
  const collections = envelopeCollections(
    fields,
    prior,
    seed.envelope?.rebalanceShadowPolicy ?? null,
    seed.envelope?.rebalanceShadowSubmitted ?? null,
  );
  if (prior === null) {
    if (fields === null) return fail('ENVELOPE_REQUIRED_ON_CREATE');
    if (fields['status'] !== 'active') fail('CREATE_STATUS_NON_CANONICAL');
    if (fields['publicPinned'] !== undefined && fields['publicPinned'] !== true) {
      fail('CREATE_PUBLIC_PIN_NON_CANONICAL');
    }
  }
  const account: AccountReplica = prior === null
    ? {
        state,
        status: 'active',
        ...(fields?.['publicPinned'] === true ? { publicPinned: true } : {}),
        mempool: [],
        currentFrame,
        currentHeight: currentFrame.height,
        rollbackCount: consensus.rollbackCount,
        proofHeader: {
          fromEntity: ownerEntityId,
          toEntity: accountId,
          nextProofNonce: consensus.nextProofNonce,
        },
        pendingWithdrawals: collections.pendingWithdrawals,
        shadow: collections.shadow,
      }
    : forkAccountReplicaShell(prior);
  account.state = state;
  account.mempool = consensus.mempool.map(cloneIsolatedAccountTx);
  account.currentFrame = currentFrame;
  account.currentHeight = currentFrame.height;
  account.rollbackCount = consensus.rollbackCount;
  account.proofHeader = {
    fromEntity: ownerEntityId,
    toEntity: accountId,
    nextProofNonce: consensus.nextProofNonce,
  };
  account.pendingWithdrawals = collections.pendingWithdrawals;
  account.shadow = collections.shadow;
  clearConsensusFields(account);

  if (consensus.pending) {
    account.pendingFrame = cloneIsolatedAccountFrame(consensus.pending.frame);
    account.pendingAccountInput = pendingInput(seed, witnesses, consensus.pending);
  }
  if (consensus.counterpartyFrameHanko) {
    account.counterpartyFrameHanko = consensus.counterpartyFrameHanko;
  }
  if (consensus.lastOutboundAck) {
    account.lastOutboundAckFrame = {
      height: consensus.lastOutboundAck.height,
      counterpartyEntityId: accountId,
      response: ackInput(seed, witnesses, consensus.lastOutboundAck),
    };
  }
  if (consensus.lastRollbackFrameHash) {
    account.lastRollbackFrameHash = consensus.lastRollbackFrameHash;
  }
  if (consensus.dispute) {
    const hanko = witnesses.dispute(
      consensus.dispute,
      latestOutboundDisputeContext(consensus, accountId),
    );
    if (hanko === undefined && latestOutboundDisputeDraft(consensus) === undefined) {
      fail('LOCAL_DISPUTE_DRAFT_UNREACHABLE');
    }
    if (hanko !== undefined) account.currentDisputeProofHanko = hanko;
    account.currentDisputeHash = consensus.dispute.hash;
    account.currentDisputeProofBodyHash = consensus.dispute.proofBodyHash;
    account.currentDisputeProofNonce = consensus.dispute.nonce;
    account.currentDisputeProofProposerIsLeft = consensus.dispute.proposerIsLeft;
  }
  if (consensus.counterpartyDispute) {
    account.counterpartyDisputeHash = consensus.counterpartyDispute.hash;
    account.counterpartyDisputeProofBodyHash = consensus.counterpartyDispute.proofBodyHash;
    account.counterpartyDisputeProofNonce = consensus.counterpartyDispute.nonce;
    account.counterpartyDisputeProofProposerIsLeft = consensus.counterpartyDispute.proposerIsLeft;
    if (consensus.counterpartyDispute.hanko) {
      account.counterpartyDisputeProofHanko = consensus.counterpartyDispute.hanko;
    }
  }

  const pendingProposal = account.pendingAccountInput
    ? accountInputProposal(account.pendingAccountInput)
    : undefined;
  const outboundAck = account.lastOutboundAckFrame?.response.ack;
  if (pendingProposal) {
    if (pendingProposal.frameHanko) account.currentFrameHanko = pendingProposal.frameHanko;
  } else if (outboundAck) {
    if (outboundAck.frameHanko) account.currentFrameHanko = outboundAck.frameHanko;
  } else if (consensus.currentFrame) {
    account.currentFrameHanko = witnesses.frame(consensus.currentFrame.stateHash)
      ?? fail('LOCAL_FRAME_DRAFT_UNREACHABLE');
  }

  assertMaterializedAccount(account, row);
  return { account, hashesToSign: witnesses.finish() };
};

/**
 * The local witnesses this row needs and the prior Account cannot supply.
 *
 * Materialization refuses a Hanko it can neither reuse nor account for, so
 * the caller has to say up front which ones are new. That list is exactly the
 * set of hashes the Entity's own witness pass must sign, in the order
 * TypeScript would have produced them: the acknowledgement first, then the
 * proposal, each with its dispute draft behind it.
 */
export const planRscoreLocalWitnesses = (
  accountIdValue: string,
  row: RscoreAccountCheckpointRow,
  prior: AccountReplica | null,
): RscoreAccountLocalWitnessPlan => {
  const accountId = canonicalEntityId(accountIdValue, 'PLAN_ACCOUNT');
  const prefix = `account:${accountId.slice(-8)}`;
  const witnesses = priorLocalWitnesses(prior);
  const fresh: RscoreAccountLocalHashToSign[] = [];
  const claimed = new Set<string>();
  const needFrame = (hash: string, context: string): void => {
    const normalized = hash.trim().toLowerCase();
    if (normalized.length === 0 || claimed.has(normalized)) return;
    if (witnesses.frames.has(normalized)) return;
    claimed.add(normalized);
    fresh.push({ hash: normalized, type: 'accountFrame', context });
  };
  const needDispute = (draft: RscoreDisputeDraft, context: string): void => {
    const key = disputeKey(draft);
    const normalized = draft.hash.trim().toLowerCase();
    if (claimed.has(key)) return;
    if (witnesses.disputes.has(key)) return;
    claimed.add(key);
    fresh.push({ hash: normalized, type: 'dispute', context });
  };
  const { consensus } = row;
  // Both, not one of them: a proposal may bundle an acknowledgement the
  // stored outbound copy no longer matches, and materialization asks for each
  // separately.
  for (const ack of [consensus.pending?.bundledAck, consensus.lastOutboundAck]) {
    if (ack === undefined) continue;
    needFrame(ack.frameHash, `${prefix}:ack:${ack.height}`);
    if (ack.dispute) needDispute(ack.dispute, `${prefix}:ack-dispute`);
  }
  if (consensus.pending) {
    needFrame(
      consensus.pending.frame.stateHash,
      `${prefix}:frame:${consensus.pending.frame.height}`,
    );
    if (consensus.pending.proposalDispute) {
      needDispute(consensus.pending.proposalDispute, `${prefix}:dispute`);
    }
  }
  return { freshHashesToSign: fresh };
};
