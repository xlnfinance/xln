/**
 * Commits every deterministic Entity field plus Account replica leaves.
 * Account leaves bind child Merkle roots and frame hashes, never frame bodies.
 * Human-audit importance: 100/100 — this root is the Entity quorum's signed state.
 */
import { keccakTextHash } from '../../protocol/crypto/keccak-text';

import type {
  AccountBoardReseal,
  AccountDisputeSeal,
  AccountFrame,
  AccountInput,
  AccountReplica,
  AccountState,
  AccountTx,
} from '../../types/account';
import type { AssertNever, Covered } from '../../types/hash-coverage/coverage';
import type { ConsensusConfig, EntityFrameAuthority, EntityLeaderState, EntityState } from '../types';
import { compareStableText } from '../../protocol/serialization';
import { encodeCanonicalConsensusValue } from '../../protocol/serialization/canonical-consensus-value';
import {
  accountInputAck,
  accountInputBoardReseal,
  accountInputDisputeSeal,
  accountInputProposal,
} from '../../account/consensus/flush';
import { canonicalAccountTxForFrameHash } from '../../account/consensus/frame/hash';
import {
  computeAccountStateRoot,
  computeCanonicalMerkleRoot,
  EMPTY_ACCOUNT_STATE_ROOT,
} from '../../account/commitment/state-root';
import { counterpartySettlementHankos } from '../../account/settlement/witness-projection';
import { computeBookCommitmentHash } from '../../orderbook/commitment';
import { createStructuredLogger } from '../../support/logger';
import { readRuntimeEnv } from '../../support/process/runtime-process';
import { getPerfMs } from '../../support/time';
import { computeIntegrityDigest } from '../../support/integrity-checksum';
import {
  ENTITY_ACCOUNT_VALUE_MAP_RADIX,
  PersistentEntityAccountMap,
  EntityAccountCandidateMap,
} from '../state/persistent-account-map';
import { entityCollectionCommitment } from '../state/persistent-collection-map';
import { requirePersistentAccountStateMap } from '../../account/state/persistent-state-map';

const entityRootLog = createStructuredLogger('entity.state-root');

/**
 * Exact EntityState fields authenticated by the Entity state root.
 *
 * Keep this list explicit. A spread followed by deletion makes a newly added
 * field consensus-critical by accident; this allowlist instead makes the type
 * checker reject every unclassified field until its ownership is reviewed.
 */
export const ENTITY_STATE_ROOT_FIELDS = [
  'entityId',
  'height',
  'timestamp',
  'nonces',
  'entityCommandNonces',
  'proposals',
  'config',
  'leaderState',
  'reserves',
  'accounts',
  'externalWallet',
  'deferredAccountProposals',
  'settlementContinuations',
  'lastFinalizedJHeight',
  'jHistoryFinality',
  'certifiedBoardState',
  'crontabState',
  'jBatchState',
  'entityProviderActionState',
  'entityEncryptionPublicKey',
  'profile',
  'htlcRoutes',
  'htlcFeesEarned',
  'consumptionAccumulator',
  'certifiedOutputSequences',
  'outDebtsByToken',
  'inDebtsByToken',
  'orderbookExt',
  'lockBook',
  'swapTradingPairs',
  'crossJurisdictionSwaps',
  'crossJurisdictionAuthorizations',
  'pendingCrossJurisdictionFillAcks',
  'crossJurisdictionBookAdmissions',
  'hubRebalanceConfig',
  'lending',
] as const satisfies readonly (keyof EntityState)[];

export const ENTITY_STATE_ROOT_EXCLUDED_FIELDS = [
  'prevFrameHash',
] as const satisfies readonly (keyof EntityState)[];

type CoveredEntityState = Covered<EntityState, AssertNever<Exclude<
  keyof EntityState,
  | (typeof ENTITY_STATE_ROOT_FIELDS)[number]
  | (typeof ENTITY_STATE_ROOT_EXCLUDED_FIELDS)[number]
>>>;

const projectAccountEnvelopeCollections = (account: AccountReplica): Record<string, unknown> => ({
  pendingWithdrawalsRoot: requirePersistentAccountStateMap(
    account.pendingWithdrawals,
    'pendingWithdrawals',
  ).rootHash(),
  shadow: {
    rebalance: {
      policyRoot: requirePersistentAccountStateMap(
        account.shadow.rebalance.policy,
        'rebalanceShadowPolicy',
      ).rootHash(),
      submittedAtByTokenRoot: requirePersistentAccountStateMap(
        account.shadow.rebalance.submittedAtByToken,
        'rebalanceShadowSubmitted',
      ).rootHash(),
      ...(account.shadow.rebalance.activeQuote === undefined
        ? {}
        : { activeQuote: account.shadow.rebalance.activeQuote }),
      ...(account.shadow.rebalance.pendingRequest === undefined
        ? {}
        : { pendingRequest: account.shadow.rebalance.pendingRequest }),
    },
    ...(account.shadow.rejectedFrameEvidence === undefined
      ? {}
      : {
          rejectedFrameEvidence: {
            reason: account.shadow.rejectedFrameEvidence.reason,
            frameHash: account.shadow.rejectedFrameEvidence.frame.stateHash,
            frameHanko: account.shadow.rejectedFrameEvidence.frameHanko,
          },
        }),
  },
});

const projectOrderbookConsensusState = (
  orderbookExt: EntityState['orderbookExt'],
): Record<string, unknown> | undefined => {
  if (!orderbookExt) return undefined;
  return {
    // The expanded bucket tree stays consensus-bound through its incremental
    // per-book commitment. Unchanged order/level/bucket hashes survive the
    // working-state clone, so one fill rehashes only its dirty ancestry.
    books: new Map(
      Array.from(orderbookExt.books.entries()).map(([pairId, book]) => [pairId, computeBookCommitmentHash(book)]),
    ),
    // orderPairs is a deterministic cancel index rebuilt from books.
    pairDimensions: new Map(orderbookExt.pairDimensions.entries()),
    hubProfile: orderbookExt.hubProfile,
    referrals: new Map(orderbookExt.referrals.entries()),
  };
};

/**
 * These bilateral fields are already committed by AccountFrame.accountStateRoot.
 * Re-embedding them into the parent Entity root made every hub frame serialize
 * the complete resting-liquidity map twice. The Entity commitment retains the
 * current/pending Account frames (and therefore their roots) plus every local
 * lifecycle field below. A field may be added here only when it is covered by
 * accountStateRootEntries in account/commitment/state-root.ts.
 */
const ACCOUNT_ROOT_COMMITTED_FIELDS = [
  'domain',
  'leftEntity',
  'rightEntity',
  'watchSeed',
  'deltas',
  'jNonce',
  'disputeConfig',
  'locks',
  'pulls',
  'swapOffers',
  'subcontracts',
  'lendingIntents',
  'settlementWorkspace',
  'lastFinalizedJHeight',
  'leftPendingJClaims',
  'rightPendingJClaims',
  'requestedRebalance',
  'requestedRebalanceFeeState',
  'rebalanceFeePolicies',
] as const satisfies readonly (keyof AccountState)[];

/**
 * Deterministic Account replica fields committed by the parent Entity.
 *
 * This is an allowlist, not a spread-and-delete projection. A newly added
 * AccountReplica field must therefore make an explicit protocol choice below
 * instead of silently entering an Entity root.
 */
const ACCOUNT_ENTITY_COMMITTED_FIELDS = [
  'status',
  'publicPinned',
  'mempool',
  'currentFrame',
  'currentHeight',
  'pendingFrame',
  'pendingSignatures',
  'pendingAccountInput',
  'lastOutboundFrameAck',
  'rollbackCount',
  'lastRollbackFrameHash',
  'proofHeader',
  'proofBody',
  'abiProofBody',
  'boardResealMigration',
  'counterpartyBoardReseal',
  'counterpartyFrameHanko',
  'counterpartyDisputeProofHanko',
  'counterpartySettlementHanko',
  'currentDisputeProofNonce',
  'currentDisputeProofProposerIsLeft',
  'currentDisputeProofBodyHash',
  'currentDisputeHash',
  'counterpartyDisputeProofNonce',
  'counterpartyDisputeProofProposerIsLeft',
  'counterpartyDisputeProofBodyHash',
  'counterpartyDisputeHash',
  'disputeProofNoncesByHash',
  'disputeProofBodiesByHash',
  'disputeArgumentSnapshotsByHash',
  'disputePrepare',
  'activeDispute',
  'pendingForwards',
  'pendingWithdrawals',
  'shadow',
] as const satisfies readonly (keyof AccountReplica)[];

/**
 * These witnesses or routes depend on validator-local keys or are attached
 * only after the committed hash exists. Including them would either fork
 * honest validators or create a circular commitment.
 */
const ACCOUNT_ENTITY_LOCAL_FIELDS = [
  'hankoSignature',
  'currentFrameHanko',
  'currentDisputeProofHanko',
] as const satisfies readonly (keyof AccountReplica)[];

type CoveredAccountReplica = Covered<AccountReplica,
  | AssertNever<Exclude<
    keyof AccountState,
    (typeof ACCOUNT_ROOT_COMMITTED_FIELDS)[number]
  >>
  | AssertNever<Exclude<
    keyof AccountReplica,
    | 'state'
    | (typeof ACCOUNT_ENTITY_COMMITTED_FIELDS)[number]
    | (typeof ACCOUNT_ENTITY_LOCAL_FIELDS)[number]
  >>
>;

/** Bodies already committed by a child root or frame hash. Copied as hashes below. */
const ACCOUNT_LEAF_BODY_FIELDS = [
  'mempool',
  'currentFrame',
  'pendingFrame',
  'pendingAccountInput',
  'lastOutboundFrameAck',
  'abiProofBody',
  'disputeProofBodiesByHash',
  'pendingWithdrawals',
  'shadow',
] as const satisfies readonly (typeof ACCOUNT_ENTITY_COMMITTED_FIELDS)[number][];

/** Hoisted: the projection runs once per account leaf on every root computation. */
const ACCOUNT_LEAF_BODY_FIELD_SET: ReadonlySet<string> = new Set(ACCOUNT_LEAF_BODY_FIELDS);

const compactDisputeSeal = (seal: AccountDisputeSeal): Record<string, unknown> => ({
  hash: seal.hash,
  proofBodyHash: seal.proofBodyHash,
  proofNonce: seal.proofNonce,
  proposerIsLeft: seal.proposerIsLeft,
});

const compactBoardReseal = (reseal: AccountBoardReseal): Record<string, unknown> => ({
  height: reseal.height,
  frameHash: reseal.frameHash,
  boardActivationJHeight: reseal.boardActivationJHeight,
  boardActivationLogIndex: reseal.boardActivationLogIndex,
  ...(reseal.disputeSeal ? { disputeSeal: compactDisputeSeal(reseal.disputeSeal) } : {}),
});

const compactAccountInputBinding = (input: AccountInput): Record<string, unknown> => {
  const proposal = accountInputProposal(input);
  const ack = accountInputAck(input);
  const disputeSeal = input.kind === 'dispute' ? accountInputDisputeSeal(input) : undefined;
  const reseal = accountInputBoardReseal(input);
  return {
    kind: input.kind,
    fromEntityId: input.fromEntityId.toLowerCase(),
    toEntityId: input.toEntityId.toLowerCase(),
    ...(proposal
      ? {
          proposal: {
            height: proposal.frame.height,
            frameHash: proposal.frame.stateHash,
            ...(proposal.disputeSeal ? { disputeSeal: compactDisputeSeal(proposal.disputeSeal) } : {}),
          },
        }
      : {}),
    ...(ack
      ? {
          ack: {
            height: ack.height,
            frameHash: ack.frameHash,
            ...(ack.disputeSeal ? { disputeSeal: compactDisputeSeal(ack.disputeSeal) } : {}),
          },
        }
      : {}),
    ...(disputeSeal ? { disputeSeal: compactDisputeSeal(disputeSeal) } : {}),
    ...(reseal ? { reseal: compactBoardReseal(reseal) } : {}),
  };
};

const mempoolRoot = (mempool: readonly AccountTx[]): string => {
  if (mempool.length === 0) return EMPTY_ACCOUNT_STATE_ROOT;
  return computeCanonicalMerkleRoot(
    'entity.account-mempool',
    mempool.map((tx, index) => [String(index), canonicalAccountTxForFrameHash(tx)] as const),
    'integrity',
  );
};

const frameHashBinding = (frame: AccountFrame | undefined): string | undefined =>
  frame ? frame.stateHash : undefined;

const projectAccountConsensusState = (account: CoveredAccountReplica): Record<string, unknown> => {
  const projected: Record<string, unknown> = {};
  const localEntityId = account.proofHeader.fromEntity.toLowerCase();
  const localIsLeft = localEntityId === account.state.leftEntity.toLowerCase();
  if (!localIsLeft && localEntityId !== account.state.rightEntity.toLowerCase()) {
    throw new Error(`ENTITY_ACCOUNT_OWNER_MISMATCH:${localEntityId}`);
  }
  for (const field of ACCOUNT_ENTITY_COMMITTED_FIELDS) {
    if (ACCOUNT_LEAF_BODY_FIELD_SET.has(field)) continue;
    const value: unknown = account[field];
    if (value !== undefined) projected[field] = value;
  }
  projected['accountStateRoot'] = computeAccountStateRoot(account.state);
  projected['mempoolRoot'] = mempoolRoot(account.mempool);
  const currentFrameHash = frameHashBinding(account.currentFrame);
  if (currentFrameHash !== undefined) projected['currentFrameHash'] = currentFrameHash;
  const pendingFrameHash = frameHashBinding(account.pendingFrame);
  if (pendingFrameHash !== undefined) projected['pendingFrameHash'] = pendingFrameHash;
  const peerSettlementHankos = counterpartySettlementHankos(
    account.state.settlementWorkspace,
    localIsLeft,
  );
  if (peerSettlementHankos) {
    projected['counterpartySettlementHankos'] = peerSettlementHankos;
  }
  const envelopeCollections = projectAccountEnvelopeCollections(account);
  projected['pendingWithdrawals'] = envelopeCollections['pendingWithdrawalsRoot'];
  projected['shadow'] = envelopeCollections['shadow'];
  if (account.pendingAccountInput) {
    projected['pendingAccountInput'] = compactAccountInputBinding(account.pendingAccountInput);
  }
  if (account.lastOutboundFrameAck) {
    projected['lastOutboundFrameAck'] = {
      height: account.lastOutboundFrameAck.height,
      counterpartyEntityId: account.lastOutboundFrameAck.counterpartyEntityId.toLowerCase(),
      response: compactAccountInputBinding(account.lastOutboundFrameAck.response),
    };
  }
  if (account.abiProofBody) {
    projected['abiProofBody'] = {
      proofBodyHash: account.abiProofBody.proofBodyHash,
      lastUpdatedHeight: account.abiProofBody.lastUpdatedHeight,
    };
  }
  if (account.disputeProofBodiesByHash) {
    projected['disputeProofBodiesByHash'] = Object.keys(account.disputeProofBodiesByHash)
      .sort(compareStableText);
  }
  return projected;
};

const normalizeAuthoritySignerId = (value: string): string => value.trim().toLowerCase();

const normalizeAuthorityConfig = (config: ConsensusConfig, shareJurisdiction = false): ConsensusConfig => {
  const shares: Record<string, bigint> = {};
  for (const [rawSignerId, share] of Object.entries(config.shares)) {
    const signerId = normalizeAuthoritySignerId(rawSignerId);
    if (!signerId || Object.prototype.hasOwnProperty.call(shares, signerId)) {
      throw new Error(`ENTITY_FRAME_AUTHORITY_DUPLICATE_SIGNER:${rawSignerId}`);
    }
    shares[signerId] = share;
  }
  // Only the jurisdiction survives the rebuild by value; validators and shares
  // are replaced with fresh normalized copies, so deep-cloning the whole config
  // on every root computation copied them twice for nothing.
  return {
    ...config,
    validators: config.validators.map(normalizeAuthoritySignerId),
    shares,
    // The commitment projection below reads scalars off the jurisdiction and
    // never lets the object escape; only callers that hand the normalized
    // config onward (frame authority) need their own copy.
    ...(config.jurisdiction
      ? { jurisdiction: shareJurisdiction ? config.jurisdiction : structuredClone(config.jurisdiction) }
      : {}),
  };
};

const CONSENSUS_CONFIG_KEYS = new Set(['mode', 'threshold', 'validators', 'shares', 'jurisdiction']);
const JURISDICTION_CONFIG_KEYS = new Set([
  'address',
  'name',
  'chainId',
  'depositoryAddress',
  'entityProviderAddress',
  'registrationBlock',
  'entityProviderDeploymentBlock',
  'blockTimeMs',
  'rebalancePolicyUsd',
]);
const REBALANCE_POLICY_KEYS = new Set(['r2cRequestSoftLimit', 'hardLimit', 'maxFee']);

const assertNoConsensusConfigExtensions = (value: object, allowedKeys: ReadonlySet<string>): void => {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new Error('ENTITY_STATE_ROOT_SYMBOL_KEY');
    if (!allowedKeys.has(key)) throw new Error(`ENTITY_STATE_ROOT_EXTRA_PROPERTY:${key}`);
  }
};

const requireConsensusAddress = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`ENTITY_STATE_ROOT_JURISDICTION_FIELD_REQUIRED:${field}`);
  }
  return value.trim().toLowerCase();
};

/**
 * Consensus binds the jurisdiction stack, never a validator's RPC locator or
 * display label. Two honest validators commonly reach the same chain through
 * different URLs; committing either URL would make identical replay fork.
 */
const projectConsensusConfigCommitment = (config: ConsensusConfig): Record<string, unknown> => {
  assertNoConsensusConfigExtensions(config, CONSENSUS_CONFIG_KEYS);
  const normalized = normalizeAuthorityConfig(config, true);
  const jurisdiction = normalized.jurisdiction;
  if (jurisdiction) {
    assertNoConsensusConfigExtensions(jurisdiction, JURISDICTION_CONFIG_KEYS);
    if (jurisdiction.rebalancePolicyUsd) {
      assertNoConsensusConfigExtensions(jurisdiction.rebalancePolicyUsd, REBALANCE_POLICY_KEYS);
    }
  }
  return {
    mode: normalized.mode,
    threshold: normalized.threshold,
    validators: normalized.validators,
    shares: normalized.shares,
    ...(jurisdiction
      ? {
          jurisdiction: {
            ...(jurisdiction.chainId !== undefined ? { chainId: jurisdiction.chainId } : {}),
            depositoryAddress: requireConsensusAddress(jurisdiction.depositoryAddress, 'depositoryAddress'),
            entityProviderAddress: requireConsensusAddress(jurisdiction.entityProviderAddress, 'entityProviderAddress'),
            ...(jurisdiction.registrationBlock !== undefined
              ? { registrationBlock: jurisdiction.registrationBlock }
              : {}),
            ...(jurisdiction.entityProviderDeploymentBlock !== undefined
              ? { entityProviderDeploymentBlock: jurisdiction.entityProviderDeploymentBlock }
              : {}),
            ...(jurisdiction.blockTimeMs !== undefined ? { blockTimeMs: jurisdiction.blockTimeMs } : {}),
            ...(jurisdiction.rebalancePolicyUsd
              ? {
                  rebalancePolicyUsd: structuredClone(jurisdiction.rebalancePolicyUsd),
                }
              : {}),
          },
        }
      : {}),
  };
};

const projectEntityConsensusState = (state: CoveredEntityState, expandAccounts = true): Record<string, unknown> => {
  // Preserve property presence exactly: optional fields that are absent from
  // the live State must remain absent from the signed projection. Symbols such
  // as the frame-local event collector cannot enter through this string-key
  // allowlist.
  const projected = Object.fromEntries(
    ENTITY_STATE_ROOT_FIELDS
      .filter((field) => ![
        'htlcRoutes',
        'lockBook',
        'crossJurisdictionSwaps',
        'crossJurisdictionAuthorizations',
        'pendingCrossJurisdictionFillAcks',
        'crossJurisdictionBookAdmissions',
      ].includes(field))
      .filter((field) => Object.hasOwn(state, field))
      .map((field) => [field, state[field]]),
  );
  const orderbookExt = projectOrderbookConsensusState(state.orderbookExt);
  return {
    ...projected,
    config: projectConsensusConfigCommitment(state.config),
    accounts: expandAccounts
      ? new Map(
          Array.from(state.accounts.entries()).map(([counterpartyId, account]) => [
            counterpartyId,
            projectAccountConsensusState(account),
          ]),
        )
      : state.accounts,
    htlcRoutes: entityCollectionCommitment(state.htlcRoutes),
    lockBook: entityCollectionCommitment(state.lockBook),
    ...(state.crossJurisdictionSwaps
      ? { crossJurisdictionSwaps: entityCollectionCommitment(state.crossJurisdictionSwaps) }
      : {}),
    ...(state.crossJurisdictionAuthorizations
      ? { crossJurisdictionAuthorizations: entityCollectionCommitment(state.crossJurisdictionAuthorizations) }
      : {}),
    ...(state.pendingCrossJurisdictionFillAcks
      ? { pendingCrossJurisdictionFillAcks: entityCollectionCommitment(state.pendingCrossJurisdictionFillAcks) }
      : {}),
    ...(state.crossJurisdictionBookAdmissions
      ? { crossJurisdictionBookAdmissions: entityCollectionCommitment(state.crossJurisdictionBookAdmissions) }
      : {}),
    ...(orderbookExt ? { orderbookExt } : {}),
  };
};

export const encodeCanonicalEntityConsensusState = (state: EntityState): string =>
  encodeCanonicalConsensusValue({
    domain: 'xln.entity.consensus-state',
    state: projectEntityConsensusState(state),
  });

const UTF8 = new TextEncoder();

type EntitySectionCommitment = {
  field: string;
  digest: string;
  encodedBytes: number;
};

export const computeEntityAccountValueHash = (account: AccountReplica): string =>
  computeCanonicalMerkleRoot(
    'entity.account-leaf',
    Object.entries(projectAccountConsensusState(account))
      .sort(([left], [right]) => compareStableText(left, right)),
    'integrity',
  );

export const invalidateEntityAccountCommitment = (state: EntityState, counterpartyId: string): void => {
  if (
    !(state.accounts instanceof PersistentEntityAccountMap) &&
    !(state.accounts instanceof EntityAccountCandidateMap)
  ) {
    throw new Error(`ENTITY_ACCOUNT_MAP_NOT_PERSISTENT:${counterpartyId}`);
  }
};

const encodeEntityAccountsSection = (state: EntityState, _cold: boolean): string => {
  return encodeCanonicalConsensusValue({
    domain: 'xln.entity.accounts.radix-merkle.v2',
    radix: ENTITY_ACCOUNT_VALUE_MAP_RADIX,
    hashAlgorithm: 'integrity',
    leafCount: state.accounts.size,
    root: state.accounts.rootHash(),
  });
};

/**
 * Entity state is a hierarchy of Merkle roots, not a serialized blob.
 * Scalar sections are SHA-256 committed. The Account section is the in-memory
 * radix-16 tree; each leaf binds child roots (`accountStateRoot`, frame
 * `stateHash`, mempool root, envelope roots) so a dirty Account reseals only
 * its path. Pending/current frames stay certified without re-encoding bodies.
 */
const commitEntityConsensusSections = (
  projected: Record<string, unknown>,
  state?: EntityState,
  cold = false,
): EntitySectionCommitment[] =>
  Object.entries(projected)
    .sort(([left], [right]) => compareStableText(left, right))
    .map(([field, value]) => {
      const encoded =
        field === 'accounts' && state ? encodeEntityAccountsSection(state, cold) : encodeCanonicalConsensusValue(value);
      return {
        field,
        digest: computeIntegrityDigest(UTF8.encode(encoded)),
        encodedBytes: encoded.length,
      };
    });

const computeEntityRootFromSections = (sections: readonly EntitySectionCommitment[]): string =>
  keccakTextHash(
    encodeCanonicalConsensusValue({
      domain: 'xln.entity.consensus-state.sections',
      sections: sections.map(({ field, digest }) => ({ field, digest })),
    }),
  );

// Same-height root memo. The proposal path computes this root, then the WAL
// storage projection recomputes it for every replica again in the same frame;
// each pass re-encodes every committed section (~36k canonical encodes per
// 500-payment HLT run, the single largest CPU item on the Hub). A committed
// EntityState only changes through a frame (height advances) — the few
// in-place envelope mutations (crontab lastRun) all happen inside frame apply,
// before the first root computation of that height. Symbol-keyed so the cache
// is invisible to every string-keyed projection allowlist.
const ENTITY_ROOT_MEMO = Symbol.for('xln.entity.state-root.memo');
type EntityRootMemo = { state: EntityState; height: number; root: string };

export const computeCanonicalEntityConsensusStateHash = (state: EntityState): string => {
  const memo = (state as { [ENTITY_ROOT_MEMO]?: EntityRootMemo })[ENTITY_ROOT_MEMO];
  if (memo && memo.state === state && memo.height === state.height) return memo.root;
  // Opt-in only: the audit recomputes the cold root and the byte breakdown
  // re-encodes the whole projection; either would distort a frame-level
  // process profile that enabled it implicitly.
  const audit = readRuntimeEnv('XLN_ENTITY_STATE_ROOT_AUDIT') === '1';
  const profile = readRuntimeEnv('XLN_ENTITY_STATE_ROOT_PROFILE') === '1';
  const startedAt = getPerfMs();
  const projected = projectEntityConsensusState(state, false);
  const projectedAt = getPerfMs();
  const sections = commitEntityConsensusSections(projected, state);
  const sectionsAt = getPerfMs();
  const root = computeEntityRootFromSections(sections);
  const endedAt = getPerfMs();
  (state as { [ENTITY_ROOT_MEMO]?: EntityRootMemo })[ENTITY_ROOT_MEMO] =
    { state, height: state.height, root };
  if (audit) {
    const cold = computeCanonicalEntityConsensusStateHashCold(state);
    if (root !== cold) throw new Error(`ENTITY_STATE_ROOT_CACHE_MISMATCH:incremental=${root}:cold=${cold}`);
  }
  if (!profile) return root;
  const profileProjected = projectEntityConsensusState(state);
  const topLevelBytes = Object.entries(profileProjected)
    .map(([field, value]) => ({
      field,
      bytes: encodeCanonicalConsensusValue(value).length,
    }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 8);
  const accountBytes = Array.from((profileProjected['accounts'] as Map<string, unknown>).entries())
    .map(([counterpartyId, value]) => ({
      counterparty: counterpartyId.slice(-8),
      bytes: encodeCanonicalConsensusValue(value).length,
      value,
    }))
    .sort((left, right) => right.bytes - left.bytes);
  const largestAccount = accountBytes[0];
  const largestAccountFields =
    largestAccount && typeof largestAccount.value === 'object' && largestAccount.value !== null
      ? Object.entries(largestAccount.value as Record<string, unknown>)
          .map(([field, value]) => ({
            field,
            bytes: encodeCanonicalConsensusValue(value).length,
          }))
          .sort((left, right) => right.bytes - left.bytes)
          .slice(0, 10)
      : [];
  entityRootLog.info('profile', {
    entity: state.entityId.slice(-8),
    height: state.height,
    accounts: state.accounts.size,
    encodedBytes: sections.reduce((total, section) => total + section.encodedBytes, 0),
    rootInputBytes: sections.length * 32,
    topLevelBytes,
    ...(largestAccount
      ? {
          largestAccount: {
            counterparty: largestAccount.counterparty,
            bytes: largestAccount.bytes,
            fields: largestAccountFields,
          },
        }
      : {}),
    totalMs: Number((endedAt - startedAt).toFixed(3)),
    phases: {
      projection: Number((projectedAt - startedAt).toFixed(3)),
      sectionCommitments: Number((sectionsAt - projectedAt).toFixed(3)),
      rootKeccak: Number((endedAt - sectionsAt).toFixed(3)),
    },
  });
  return root;
};

/** Cold test/restore oracle: never trusts an in-memory Account leaf cache. */
export const computeCanonicalEntityConsensusStateHashCold = (state: EntityState): string =>
  computeEntityRootFromSections(commitEntityConsensusSections(projectEntityConsensusState(state, false), state, true));

/**
 * Compact cold-oracle evidence for diagnosing a consensus-root mismatch.
 * Values are never logged; only per-section digests identify the first
 * divergent authority or financial section without exposing private state.
 */
export const computeEntityConsensusSectionDigestsCold = (
  state: EntityState,
): ReadonlyArray<Readonly<{ field: string; digest: string }>> =>
  commitEntityConsensusSections(projectEntityConsensusState(state, false), state, true)
    .map(({ field, digest }) => ({ field, digest }));

export const computeEntityAccountDigests = (
  state: EntityState,
): ReadonlyArray<Readonly<{ counterpartyId: string; digest: string }>> =>
  [...state.accounts]
    .map(([counterpartyId, account]) => ({
      counterpartyId,
      digest: computeEntityAccountValueHash(account),
    }))
    .sort((left, right) => compareStableText(left.counterpartyId, right.counterpartyId));

export const computeEntityAccountFieldDigests = (
  state: EntityState,
): ReadonlyArray<Readonly<{
  counterpartyId: string;
  fields: ReadonlyArray<Readonly<{ field: string; digest: string }>>;
}>> =>
  [...state.accounts]
    .map(([counterpartyId, account]) => ({
      counterpartyId,
      fields: Object.entries(projectAccountConsensusState(account))
        .map(([field, value]) => ({
          field,
          digest: computeIntegrityDigest(UTF8.encode(encodeCanonicalConsensusValue(value))),
        }))
        .sort((left, right) => compareStableText(left.field, right.field)),
    }))
    .sort((left, right) => compareStableText(left.counterpartyId, right.counterpartyId));

export const assertEntityStateRootCache = (state: EntityState): string => {
  const incremental = computeCanonicalEntityConsensusStateHash(state);
  const cold = computeCanonicalEntityConsensusStateHashCold(state);
  if (incremental !== cold) {
    throw new Error(`ENTITY_STATE_ROOT_CACHE_MISMATCH:incremental=${incremental}:cold=${cold}`);
  }
  return incremental;
};

const normalizeAuthorityLeader = (
  config: ConsensusConfig,
  leaderState: EntityState['leaderState'],
): EntityLeaderState => {
  const activeValidatorId = normalizeAuthoritySignerId(leaderState?.activeValidatorId ?? config.validators[0] ?? '');
  if (!activeValidatorId) throw new Error('ENTITY_FRAME_AUTHORITY_LEADER_MISSING');
  return {
    activeValidatorId,
    view: leaderState?.view ?? 0,
    changedAtHeight: leaderState?.changedAtHeight ?? 0,
  };
};

export const buildEntityFrameAuthority = (state: EntityState): EntityFrameAuthority => {
  const config = normalizeAuthorityConfig(state.config);
  return {
    config,
    leaderState: normalizeAuthorityLeader(config, state.leaderState),
  };
};

export const computeEntityFrameAuthorityRoot = (authority: EntityFrameAuthority): string =>
  keccakTextHash(
    encodeCanonicalConsensusValue({
      domain: 'xln.entity.frame-authority',
      authority: {
        config: projectConsensusConfigCommitment(authority.config),
        leaderState: normalizeAuthorityLeader(authority.config, authority.leaderState),
      },
    }),
  );
