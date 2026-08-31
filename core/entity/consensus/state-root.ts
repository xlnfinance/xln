/**
 * Commits every deterministic Entity field plus Account replica leaves.
 * Account leaves bind child Merkle roots and frame hashes, never frame bodies.
 * Key projections: bounded Entity fields and nested Account/Book Patricia roots.
 * Human-audit importance: 100/100 — this root is the Entity quorum's signed state.
 */
import { forgetEngineAccountLeaf } from '../../rscore/cutover/leaf-registry';
import { keccakBytesHash } from '../../protocol/crypto/keccak-text';

import type {
  AccountFrame,
  AccountReplica,
  AccountState,
} from '../../types/account';
import type { AssertNever, Covered } from '../../types/hash-coverage/coverage';
import type { ConsensusConfig, EntityFrameAuthority, EntityLeaderState, EntityState } from '../types';
import { compareStableText } from '../../protocol/serialization';
import { encodeCanonicalConsensusBytes } from '../../protocol/serialization/binary-codec';
import {
  computeAccountStateRoot,
  computeAccountStateRootCold,
  encodeAccountStateValue,
} from '../../account/commitment/state-root';
import { counterpartySettlementHankos } from '../../account/settlement/witness-projection';
import { computeBookCommitmentHash } from '../../orderbook/commitment';
import { createStructuredLogger } from '../../support/logger';
import { readRuntimeEnv } from '../../support/process/runtime-process';
import { getPerfMs } from '../../support/time';
import { computeIntegrityDigest } from '../../support/bytes/integrity-checksum';
import { timePerfPhase } from '../../support/performance/profile';
import { countOp, OP_COUNTERS_ENABLED } from '../../support/performance/op-counters';
import {
  ENTITY_ACCOUNT_VALUE_MAP_RADIX,
  PersistentEntityAccountMap,
  EntityAccountCandidateMap,
} from '../state/persistent-account-map';
import { entityCollectionCommitment } from '../state/persistent-collection-map';
import { requirePersistentAccountStateMap } from '../../account/state/persistent-state-map';
import { RecencyMemo } from '../../support/collections/recency-memo';

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
  'paybook',
  'outDebtsByToken',
  'inDebtsByToken',
  'orderbookExt',
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

const projectAccountEnvelopeCollections = (account: AccountReplica, cold = false): Record<string, unknown> => ({
  pendingWithdrawalsRoot: requirePersistentAccountStateMap(
    account.pendingWithdrawals,
    'pendingWithdrawals',
  )[cold ? 'coldRootHash' : 'rootHash'](),
  shadow: {
    rebalance: {
      policyRoot: requirePersistentAccountStateMap(
        account.shadow.rebalance.policy,
        'rebalanceShadowPolicy',
      )[cold ? 'coldRootHash' : 'rootHash'](),
      submittedAtByTokenRoot: requirePersistentAccountStateMap(
        account.shadow.rebalance.submittedAtByToken,
        'rebalanceShadowSubmitted',
      )[cold ? 'coldRootHash' : 'rootHash'](),
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
 * current Account frame (and therefore its root) plus every committed local
 * lifecycle field below. The pending proposal is replica coordination state.
 * A field may be added here only when it is covered by accountStateRootEntries
 * in account/commitment/state-root.ts.
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
  'currentFrame',
  'currentHeight',
  'proofHeader',
  'boardHankoRefreshMigration',
  'counterpartyBoardHankoRefresh',
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
  'disputePrepare',
  'activeDispute',
  'pendingWithdrawals',
  'shadow',
] as const satisfies readonly (keyof AccountReplica)[];

/**
 * Replica-only fields excluded from the committed Entity root. Coordination
 * state is recovered from WAL; local Hankos are attached after the committed
 * hash exists and would otherwise make the commitment circular.
 */
const ACCOUNT_ENTITY_EXCLUDED_FIELDS = [
  // Coordination state remains in the live Account replica and recovery WAL,
  // but it is not certified financial state. Committing it here made Entity
  // roots depend on scheduling, retries, and worker timing.
  'mempool',
  'pendingFrame',
  'pendingAccountInput',
  'lastOutboundAckFrame',
  'rollbackCount',
  'lastRollbackFrameHash',
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
    | (typeof ACCOUNT_ENTITY_EXCLUDED_FIELDS)[number]
  >>
>;

/** Bodies already committed by a child root or frame hash. Copied as hashes below. */
const ACCOUNT_LEAF_BODY_FIELDS = [
  'currentFrame',
  'pendingWithdrawals',
  'shadow',
] as const satisfies readonly (typeof ACCOUNT_ENTITY_COMMITTED_FIELDS)[number][];

/**
 * Counterparty Hankos are ~1.4 KB of hex each and were three quarters of every
 * leaf preimage. The leaf commits to their digest; the Hanko string itself is
 * immutable, so the digest memo is exact by identity.
 */
const ACCOUNT_LEAF_HANKO_FIELDS = [
  'counterpartyFrameHanko',
  'counterpartyDisputeProofHanko',
  'counterpartySettlementHanko',
] as const satisfies readonly (typeof ACCOUNT_ENTITY_COMMITTED_FIELDS)[number][];
const ACCOUNT_LEAF_HANKO_FIELD_SET: ReadonlySet<string> = new Set(ACCOUNT_LEAF_HANKO_FIELDS);
const hankoLeafDigests = new RecencyMemo<string, string>(8_192);
const hankoLeafDigestUtf8 = new TextEncoder();
const hankoLeafDigest = (hanko: string, cold: boolean): string => {
  const hit = cold ? undefined : hankoLeafDigests.get(hanko);
  if (hit) return hit;
  const digest = computeIntegrityDigest(hankoLeafDigestUtf8.encode(hanko));
  if (!cold) hankoLeafDigests.set(hanko, digest);
  return digest;
};

/** Hoisted: the projection runs once per account leaf on every root computation. */
const ACCOUNT_LEAF_BODY_FIELD_SET: ReadonlySet<string> = new Set(ACCOUNT_LEAF_BODY_FIELDS);

const ENTITY_ACCOUNT_LEAF_DERIVED_FIELDS = [
  'accountStateRoot',
  'currentFrameHash',
  'counterpartySettlementHankos',
  'pendingWithdrawals',
  'shadow',
] as const;

const ENTITY_ACCOUNT_LEAF_FIELDS = [
  ...ACCOUNT_ENTITY_COMMITTED_FIELDS.filter(field => !ACCOUNT_LEAF_BODY_FIELD_SET.has(field)),
  ...ENTITY_ACCOUNT_LEAF_DERIVED_FIELDS,
] as const;
const ENTITY_ACCOUNT_LEAF_UTF8 = new TextEncoder();
const ENTITY_ACCOUNT_LEAF_KEYS: ReadonlySet<string> = new Set(ENTITY_ACCOUNT_LEAF_FIELDS);

const ENTITY_ACCOUNT_LEAF_DOMAIN = ENTITY_ACCOUNT_LEAF_UTF8.encode('xln.entity.account-leaf.v3');

/**
 * Account leaf digest: one encode of the sorted projection, one hash. Nothing
 * proves a single Account field against the Entity root, and per-field memos
 * missed on every shell fork, so 25 separate hashes per touched Account were
 * pure overhead (~57 µs per Account per frame before, ~28 µs after the flat
 * digest, ~5 µs now).
 */
export const computeEntityAccountLeafDigest = (
  entries: ReadonlyArray<readonly [string, unknown]>,
): string => {
  for (const [field] of entries) {
    if (!ENTITY_ACCOUNT_LEAF_KEYS.has(field)) throw new Error(`ENTITY_ACCOUNT_LEAF_FIELD_UNCLASSIFIED:${field}`);
  }
  const encoded = encodeAccountStateValue(Object.fromEntries(entries));
  const preimage = new Uint8Array(ENTITY_ACCOUNT_LEAF_DOMAIN.length + encoded.length);
  preimage.set(ENTITY_ACCOUNT_LEAF_DOMAIN, 0);
  preimage.set(encoded, ENTITY_ACCOUNT_LEAF_DOMAIN.length);
  return computeIntegrityDigest(preimage);
};

const frameHashBinding = (frame: AccountFrame | undefined): string | undefined =>
  frame ? frame.stateHash : undefined;

const projectAccountConsensusState = (account: CoveredAccountReplica, cold = false): Record<string, unknown> => {
  const projected: Record<string, unknown> = {};
  const localEntityId = account.proofHeader.fromEntity.toLowerCase();
  const localIsLeft = localEntityId === account.state.leftEntity.toLowerCase();
  if (!localIsLeft && localEntityId !== account.state.rightEntity.toLowerCase()) {
    throw new Error(`ENTITY_ACCOUNT_OWNER_MISMATCH:${localEntityId}`);
  }
  for (const field of ACCOUNT_ENTITY_COMMITTED_FIELDS) {
    if (ACCOUNT_LEAF_BODY_FIELD_SET.has(field)) continue;
    const value: unknown = account[field];
    if (value === undefined) continue;
    projected[field] = ACCOUNT_LEAF_HANKO_FIELD_SET.has(field) && typeof value === 'string'
      ? hankoLeafDigest(value, cold)
      : value;
  }
  projected['accountStateRoot'] = cold
    ? computeAccountStateRootCold(account.state)
    : computeAccountStateRoot(account.state, undefined, 'entityLeaf');
  const currentFrameHash = frameHashBinding(account.currentFrame);
  if (currentFrameHash !== undefined) projected['currentFrameHash'] = currentFrameHash;
  const peerSettlementHankos = counterpartySettlementHankos(
    account.state.settlementWorkspace,
    localIsLeft,
  );
  if (peerSettlementHankos) {
    projected['counterpartySettlementHankos'] = peerSettlementHankos;
  }
  const envelopeCollections = projectAccountEnvelopeCollections(account, cold);
  projected['pendingWithdrawals'] = envelopeCollections['pendingWithdrawalsRoot'];
  projected['shadow'] = envelopeCollections['shadow'];
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

const projectEntityConsensusState = (
  state: CoveredEntityState,
  expandAccounts = true,
  cold = false,
): Record<string, unknown> => {
  // Preserve property presence exactly: optional fields that are absent from
  // the live State must remain absent from the signed projection. Symbols such
  // as the frame-local event collector cannot enter through this string-key
  // allowlist.
  const projected = Object.fromEntries(
    ENTITY_STATE_ROOT_FIELDS
      .filter((field) => ![
        'paybook',
        'crontabState',
        'deferredAccountProposals',
        'settlementContinuations',
        'crossJurisdictionSwaps',
        'crossJurisdictionAuthorizations',
        'pendingCrossJurisdictionFillAcks',
        'crossJurisdictionBookAdmissions',
      ].includes(field))
      .filter((field) => Object.hasOwn(state, field))
      .map((field) => [field, state[field]]),
  );
  const orderbookExt = timePerfPhase('entity.proj.orderbook', () => projectOrderbookConsensusState(state.orderbookExt));
  const crontabState = state.crontabState;
  return {
    ...projected,
    config: timePerfPhase('entity.proj.config', () => projectConsensusConfigCommitment(state.config)),
    accounts: expandAccounts
      ? new Map(
          Array.from(state.accounts.entries()).map(([counterpartyId, account]) => [
            counterpartyId,
            projectAccountConsensusState(account, cold),
          ]),
        )
      : state.accounts,
    paybook: {
      entries: timePerfPhase(
        'entity.proj.paybook',
        () => entityCollectionCommitment(state.paybook.entries, cold),
      ),
      feesEarned: state.paybook.feesEarned,
    },
    ...(crontabState
      ? {
          crontabState: {
            tasks: crontabState.tasks,
            hooks: timePerfPhase('entity.proj.hooks', () => entityCollectionCommitment(crontabState.hooks, cold)),
          },
        }
      : {}),
    ...(state.deferredAccountProposals
      ? { deferredAccountProposals: entityCollectionCommitment(state.deferredAccountProposals, cold) }
      : {}),
    ...(state.settlementContinuations
      ? { settlementContinuations: entityCollectionCommitment(state.settlementContinuations, cold) }
      : {}),
    ...(state.crossJurisdictionSwaps
      ? { crossJurisdictionSwaps: entityCollectionCommitment(state.crossJurisdictionSwaps, cold) }
      : {}),
    ...(state.crossJurisdictionAuthorizations
      ? { crossJurisdictionAuthorizations: entityCollectionCommitment(state.crossJurisdictionAuthorizations, cold) }
      : {}),
    ...(state.pendingCrossJurisdictionFillAcks
      ? { pendingCrossJurisdictionFillAcks: entityCollectionCommitment(state.pendingCrossJurisdictionFillAcks, cold) }
      : {}),
    ...(state.crossJurisdictionBookAdmissions
      ? { crossJurisdictionBookAdmissions: entityCollectionCommitment(state.crossJurisdictionBookAdmissions, cold) }
      : {}),
    ...(orderbookExt ? { orderbookExt } : {}),
  };
};

export const encodeCanonicalEntityConsensusState = (state: EntityState): Uint8Array =>
  encodeCanonicalConsensusBytes({
    domain: 'xln.entity.consensus-state',
    state: projectEntityConsensusState(state),
  });


type EntitySectionCommitment = {
  field: string;
  digest: string;
  encodedBytes: number;
};

/**
 * The exact projection the Entity hashes into its account leaf. Exported for
 * the Rust shadow, which must commit the same leaf from the same fields: a
 * second, hand-written projection there would agree with the authority only
 * until one of them changed.
 */
export const projectEntityAccountLeaf = (account: AccountReplica): Record<string, unknown> =>
  projectAccountConsensusState(account);

export const computeEntityAccountValueHash = (account: AccountReplica): string => {
  const startedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
  const entries = timePerfPhase(
    'entity.accountLeaf.project',
    () => Object.entries(projectAccountConsensusState(account))
      .sort(([left], [right]) => compareStableText(left, right)),
  );
  const projectedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
  const digest = timePerfPhase(
    'entity.accountLeaf.merkle',
    () => computeEntityAccountLeafDigest(entries),
  );
  if (OP_COUNTERS_ENABLED) {
    const endedAt = getPerfMs();
    countOp('entity.accountLeaf.project', 0, Math.round((projectedAt - startedAt) * 1_000));
    countOp('entity.accountLeaf.merkle', 0, Math.round((endedAt - projectedAt) * 1_000));
    countOp('entity.accountLeaf.valueHash', 0, Math.round((endedAt - startedAt) * 1_000));
  }
  return digest;
};

const computeEntityAccountValueHashCold = (account: AccountReplica): string => {
  const entries = Object.entries(projectAccountConsensusState(account, true))
    .sort(([left], [right]) => compareStableText(left, right));
  return computeEntityAccountLeafDigest(entries);
};

export const invalidateEntityAccountCommitment = (state: EntityState, counterpartyId: string): void => {
  // In-place envelope mutation: the engine's leaf certified the bytes before it.
  forgetEngineAccountLeaf(state.entityId, counterpartyId);
  if (state.accounts instanceof EntityAccountCandidateMap) {
    state.accounts.dropCachedProjection();
    return;
  }
  if (!(state.accounts instanceof PersistentEntityAccountMap)) {
    throw new Error(`ENTITY_ACCOUNT_MAP_NOT_PERSISTENT:${counterpartyId}`);
  }
};

const encodeEntityAccountsSection = (state: EntityState, cold: boolean): Uint8Array => {
  const root = cold
    ? PersistentEntityAccountMap.fromEntries(
        state.accounts,
        state.entityId,
        computeEntityAccountValueHashCold,
      ).rootHash()
    : state.accounts.rootHash();
  return encodeCanonicalConsensusBytes({
    domain: 'xln.entity.accounts.radix-merkle:binary',
    radix: ENTITY_ACCOUNT_VALUE_MAP_RADIX,
    hashAlgorithm: 'integrity',
    leafCount: state.accounts.size,
    root,
  });
};

/**
 * Entity state is a hierarchy of Merkle roots, not a serialized blob.
 * Scalar sections are SHA-256 committed. The Account section is the in-memory
 * radix-16 tree; each leaf binds child roots (`accountStateRoot`, current frame
 * `stateHash`, envelope roots) so a dirty Account reseals only its path. Live
 * proposal/mempool/ACK/rollback coordination is recovered from WAL, never
 * authenticated as committed Entity state.
 */
const commitEntityConsensusSections = (
  projected: Record<string, unknown>,
  state?: EntityState,
  cold = false,
): EntitySectionCommitment[] =>
  Object.entries(projected)
    .sort(([left], [right]) => compareStableText(left, right))
    .map(([field, value]) => {
      const encodeSection = (): Uint8Array => field === 'accounts' && state
        ? encodeEntityAccountsSection(state, cold)
        : encodeCanonicalConsensusBytes(value);
      // The Account Patricia root was the only material section in the
      // measured H1 profile. Keep that surgical timer; wrapping every scalar
      // section added dozens of environment checks to every production root.
      const encoded = timePerfPhase(`entity.stateRoot.section.${field}`, encodeSection);
      return {
        field,
        digest: computeIntegrityDigest(encoded),
        encodedBytes: encoded.byteLength,
      };
    });

const computeEntityRootFromSections = (sections: readonly EntitySectionCommitment[]): string =>
  keccakBytesHash(
    encodeCanonicalConsensusBytes({
      domain: 'xln.entity.consensus-state.sections:binary',
      sections: sections.map(({ field, digest }) => ({ field, digest })),
    }),
  );

const entityRootProfileEnabled = (): boolean =>
  readRuntimeEnv('XLN_ENTITY_STATE_ROOT_PROFILE') === '1';

export const computeCanonicalEntityConsensusStateHash = (state: EntityState): string => {
  // EntityState is intentionally plain deterministic data, not an observable
  // mutation wrapper. Caching this parent root on object identity is therefore
  // unsafe: profile/config/orderbook fields may change at the same height and
  // an Account-root-only key would silently certify the previous state. The
  // large Account subtree remains incrementally cached by its Patricia map;
  // this small parent commitment must always bind the scalar sections now.
  // Opt-in only: the audit recomputes the cold root and the byte breakdown
  // re-encodes the whole projection; either would distort a frame-level
  // process profile that enabled it implicitly.
  const profile = entityRootProfileEnabled();
  const startedAt = getPerfMs();
  const projected = timePerfPhase(
    'entity.stateRoot.projection',
    () => projectEntityConsensusState(state, false),
  );
  const projectedAt = getPerfMs();
  const sections = timePerfPhase(
    'entity.stateRoot.sections',
    () => commitEntityConsensusSections(projected, state),
  );
  const sectionsAt = getPerfMs();
  const root = timePerfPhase(
    'entity.stateRoot.root',
    () => computeEntityRootFromSections(sections),
  );
  const endedAt = getPerfMs();
  if (!profile) return root;
  const profileProjected = projectEntityConsensusState(state);
  const topSectionBytes = sections
    .map(({ field, encodedBytes }) => ({ field, bytes: encodedBytes }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 8);
  const topLevelBytes = Object.entries(profileProjected)
    .map(([field, value]) => ({
      field,
      bytes: encodeCanonicalConsensusBytes(value).byteLength,
    }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 8);
  const accountBytes = Array.from((profileProjected['accounts'] as Map<string, unknown>).entries())
    .map(([counterpartyId, value]) => ({
      counterparty: counterpartyId.slice(-8),
      bytes: encodeCanonicalConsensusBytes(value).byteLength,
      value,
    }))
    .sort((left, right) => right.bytes - left.bytes);
  const largestAccount = accountBytes[0];
  const largestAccountFields =
    largestAccount && typeof largestAccount.value === 'object' && largestAccount.value !== null
      ? Object.entries(largestAccount.value as Record<string, unknown>)
          .map(([field, value]) => ({
            field,
            bytes: encodeCanonicalConsensusBytes(value).byteLength,
          }))
          .sort((left, right) => right.bytes - left.bytes)
          .slice(0, 10)
      : [];
  const hookTypes: Record<string, number> = {};
  let earliestHookAt: number | null = null;
  let latestHookAt: number | null = null;
  for (const hook of state.crontabState?.hooks.values() ?? []) {
    hookTypes[hook.type] = (hookTypes[hook.type] ?? 0) + 1;
    earliestHookAt = earliestHookAt === null ? hook.triggerAt : Math.min(earliestHookAt, hook.triggerAt);
    latestHookAt = latestHookAt === null ? hook.triggerAt : Math.max(latestHookAt, hook.triggerAt);
  }
  entityRootLog.info('profile', {
    entity: state.entityId.slice(-8),
    height: state.height,
    accounts: state.accounts.size,
    encodedBytes: sections.reduce((total, section) => total + section.encodedBytes, 0),
    rootInputBytes: sections.length * 32,
    topSectionBytes,
    topLevelBytes,
    proposals: { pending: state.proposals.size },
    hooks: {
      total: state.crontabState?.hooks.size ?? 0,
      types: hookTypes,
      earliestTriggerAt: earliestHookAt,
      latestTriggerAt: latestHookAt,
    },
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
  computeEntityRootFromSections(
    commitEntityConsensusSections(projectEntityConsensusState(state, false, true), state, true),
  );

/** Expensive O(all Accounts) oracle, invoked only by the Runtime checkpoint path. */
export const auditEntityStateRootAtCheckpoint = (state: EntityState): void => {
  if (readRuntimeEnv('XLN_ENTITY_STATE_ROOT_AUDIT') !== '1') return;
  const incremental = computeCanonicalEntityConsensusStateHash(state);
  const cold = computeCanonicalEntityConsensusStateHashCold(state);
  if (incremental !== cold) {
    throw new Error(`ENTITY_STATE_ROOT_CACHE_MISMATCH:incremental=${incremental}:cold=${cold}`);
  }
};

/**
 * Compact cold-oracle evidence for diagnosing a consensus-root mismatch.
 * Values are never logged; only per-section digests identify the first
 * divergent authority or financial section without exposing private state.
 */
export const computeEntityConsensusSectionDigestsCold = (
  state: EntityState,
): ReadonlyArray<Readonly<{ field: string; digest: string }>> =>
  commitEntityConsensusSections(projectEntityConsensusState(state, false, true), state, true)
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
          digest: computeIntegrityDigest(encodeCanonicalConsensusBytes(value)),
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
  keccakBytesHash(
    encodeCanonicalConsensusBytes({
      domain: 'xln.entity.frame-authority:binary',
      authority: {
        config: projectConsensusConfigCommitment(authority.config),
        leaderState: normalizeAuthorityLeader(authority.config, authority.leaderState),
      },
    }),
  );
