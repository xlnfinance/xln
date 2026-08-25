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
  computeEntityAccountValueHash,
  projectEntityAccountLeaf,
} from '../../entity/consensus/state-root';
import {
  cloneIsolatedAccountFrame,
  cloneIsolatedAccountTx,
  copyAccountDisputeConfig,
  copyAccountStateDomain,
} from '../../protocol/state/account-input-clone';
import { buffersEqual } from '../../protocol/serialization';
import type {
  AccountDisputeHanko,
  AccountFrame,
  AccountPeerInput,
  AccountReplica,
  AccountState,
} from '../../types/account';
import type { RscoreDisputeDraft, RscoreOutboundAck } from './checkpoint-restore-consensus';
import type { RscoreAccountStateSeed } from './checkpoint-restore-state';
import type { RscoreAccountCheckpointRow } from './wave-checkpoint-decode';

export type RscoreAccountMaterializerBinding = Readonly<{
  /** Entity bound by the live authority process Hello response. */
  sessionOwnerEntityId: string;
  /** Exact signer id used to derive that session's key. */
  expectedSignerId: string;
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

const sameProof = (
  account: AccountReplica,
  draft: RscoreDisputeDraft,
): boolean =>
  account.currentDisputeHash === draft.hash
  && account.currentDisputeProofBodyHash === draft.proofBodyHash
  && account.currentDisputeProofNonce === draft.nonce
  && account.currentDisputeProofProposerIsLeft === draft.proposerIsLeft;

const exactLocalProofHanko = (
  prior: AccountReplica | null,
  draft: RscoreDisputeDraft,
): string => {
  const hanko = prior !== null && sameProof(prior, draft)
    ? prior.currentDisputeProofHanko
    : undefined;
  if (typeof hanko !== 'string' || hanko.length === 0) {
    return fail('LOCAL_DISPUTE_HANKO_ABI_INCOMPLETE');
  }
  return hanko;
};

const disputeHanko = (
  prior: AccountReplica | null,
  draft: RscoreDisputeDraft,
): AccountDisputeHanko => ({
  hanko: exactLocalProofHanko(prior, draft),
  hash: draft.hash,
  proofBodyHash: draft.proofBodyHash,
  proofNonce: draft.nonce,
  proposerIsLeft: draft.proposerIsLeft,
});

const ackInput = (
  seed: RscoreAccountStateSeed,
  prior: AccountReplica | null,
  ack: RscoreOutboundAck,
): Extract<AccountPeerInput, { kind: 'ack' }> => ({
  kind: 'ack',
  fromEntityId: seed.ownerEntityId,
  toEntityId: seed.accountId,
  domain: copyAccountStateDomain(seed.domain),
  disputeConfig: copyAccountDisputeConfig(seed.disputeConfig),
  watchSeed: seed.watchSeed,
  ack: {
    height: ack.height,
    frameHash: ack.frameHash,
    frameHanko: ack.frameHanko,
    ...(ack.dispute ? { disputeHanko: disputeHanko(prior, ack.dispute) } : {}),
  },
});

const pendingInput = (
  seed: RscoreAccountStateSeed,
  prior: AccountReplica | null,
  pending: NonNullable<RscoreAccountCheckpointRow['decoded']['consensus']['pending']>,
): Extract<AccountPeerInput, { kind: 'frame' | 'frame_ack' }> => {
  const proposal = {
    frame: cloneIsolatedAccountFrame(pending.frame),
    frameHanko: pending.hanko,
    ...(pending.proposalDispute
      ? { disputeHanko: disputeHanko(prior, pending.proposalDispute) }
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
  if (pending.bundledAck === undefined) return { kind: 'frame', ...common };
  return {
    kind: 'frame_ack',
    ...common,
    ack: ackInput(seed, prior, pending.bundledAck).ack,
  };
};

const h0Frame = (seed: RscoreAccountStateSeed, accountStateRoot: string): AccountFrame => ({
  height: 0,
  timestamp: 0,
  jHeight: 0,
  accountTxs: [],
  prevFrameHash: '',
  accountStateRoot,
  stateHash: '',
  byLeft: seed.ownerEntityId === seed.leftEntity,
  deltas: [],
});

const assertPriorBinding = (
  prior: AccountReplica,
  ownerEntityId: string,
  accountId: string,
  seed: RscoreAccountStateSeed,
  currentFrame: AccountFrame,
  rollbackCount: number,
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
  if (prior.rollbackCount > rollbackCount) fail('PRIOR_ROLLBACK_STALE');
  if (prior.state.jNonce > seed.jNonce) fail('PRIOR_J_NONCE_STALE');
  if (prior.state.lastFinalizedJHeight > seed.lastFinalizedJHeight) {
    fail('PRIOR_J_HEIGHT_STALE');
  }
};

const envelopeCollections = (
  fields: Readonly<Record<string, unknown>>,
  prior: AccountReplica | null,
): Pick<AccountReplica, 'pendingWithdrawals' | 'shadow'> => {
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
  if (create && policyRoot !== EMPTY_ACCOUNT_STATE_ROOT) {
    fail('CREATE_REBALANCE_POLICY_ABI_INCOMPLETE');
  }
  const policy = carriedMap(
    'rebalanceShadowPolicy',
    policyRoot,
    prior?.shadow.rebalance.policy,
    create,
    'SHADOW_POLICY',
  );
  const submittedAtByToken = carriedMap(
    'rebalanceShadowSubmitted',
    submittedRoot,
    prior?.shadow.rebalance.submittedAtByToken,
    create,
    'SHADOW_SUBMITTED',
  );
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
  const pulls = carriedMap(
    'pulls', seed.carried.pullsRoot, prior?.state.pulls, create, 'PULLS',
  );
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
  if (prior?.state.settlementWorkspace !== undefined) {
    fail('SETTLEMENT_WORKSPACE_UNSUPPORTED');
  }
  return {
    leftEntity: seed.leftEntity,
    rightEntity: seed.rightEntity,
    domain: copyAccountStateDomain(seed.domain),
    watchSeed: seed.watchSeed,
    deltas: seed.deltas,
    locks: seed.locks,
    swapOffers: seed.swapOffers,
    pulls,
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
  };
};

const clearConsensusFields = (account: AccountReplica): void => {
  delete account.pendingFrame;
  delete account.pendingAccountInput;
  delete account.lastOutboundFrameAck;
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

/**
 * Rebuild a fresh AccountReplica from one already-decoded Rust post-account
 * row. No TypeScript Account transition or proposal code is called.
 */
export const materializeRscoreAccountReplica = (
  binding: RscoreAccountMaterializerBinding,
  accountIdValue: string,
  row: RscoreAccountCheckpointRow,
  prior: AccountReplica | null,
): AccountReplica => {
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

  const state = stateFromSeed(seed, prior);
  const accountStateRoot = computeAccountStateRoot(state, undefined, 'rscoreMaterialize');
  if (accountStateRoot !== row.decoded.accountStateRoot) fail('ACCOUNT_STATE_ROOT_MISMATCH');
  if (computeAccountStateRootCold(state) !== accountStateRoot) fail('ACCOUNT_STATE_COLD_ROOT_MISMATCH');
  const currentFrame = consensus.currentFrame
    ? cloneIsolatedAccountFrame(consensus.currentFrame)
    : h0Frame(seed, accountStateRoot);
  if (prior !== null) {
    assertPriorBinding(prior, ownerEntityId, accountId, seed, currentFrame, consensus.rollbackCount);
  }
  const fields = seed.envelope.fields;
  const collections = envelopeCollections(fields, prior);
  if (prior === null && fields['status'] !== 'active') fail('CREATE_STATUS_NON_CANONICAL');
  if (prior === null && fields['publicPinned'] !== undefined && fields['publicPinned'] !== true) {
    fail('CREATE_PUBLIC_PIN_NON_CANONICAL');
  }
  const account: AccountReplica = prior === null
    ? {
        state,
        status: 'active',
        ...(fields['publicPinned'] === true ? { publicPinned: true } : {}),
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
    account.pendingAccountInput = pendingInput(seed, prior, consensus.pending);
    account.currentFrameHanko = consensus.pending.hanko;
  } else if (consensus.localCommittedFrameHanko) {
    account.currentFrameHanko = consensus.localCommittedFrameHanko;
  }
  if (consensus.counterpartyFrameHanko) {
    account.counterpartyFrameHanko = consensus.counterpartyFrameHanko;
  }
  if (consensus.lastOutboundAck) {
    account.lastOutboundFrameAck = {
      height: consensus.lastOutboundAck.height,
      counterpartyEntityId: accountId,
      response: ackInput(seed, prior, consensus.lastOutboundAck),
    };
  }
  if (consensus.lastRollbackFrameHash) {
    account.lastRollbackFrameHash = consensus.lastRollbackFrameHash;
  }
  if (consensus.dispute) {
    const hanko = exactLocalProofHanko(prior, consensus.dispute);
    account.currentDisputeProofHanko = hanko;
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

  validateAccountReplica(account, 'rscore.materialize.result');
  const expectedProjection = {
    ...fields,
    accountStateRoot,
    mempoolRoot: row.decoded.mempoolRoot,
  };
  const projected = projectEntityAccountLeaf(account);
  requireCanonicalEqual(projected, expectedProjection, 'ENTITY_PROJECTION');
  const projectedLeaf = computeEntityAccountLeafDigest(
    Object.entries(projected).sort(([left], [right]) => left.localeCompare(right)),
  );
  if (projectedLeaf !== row.entityAccountLeaf) fail('PROJECTED_LEAF_MISMATCH');
  if (computeEntityAccountValueHash(account) !== row.entityAccountLeaf) fail('ENTITY_LEAF_MISMATCH');
  return account;
};
