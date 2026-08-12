import { ethers } from 'ethers';

import type { AccountReplica, AccountState } from '../../types/account';
import type { ConsensusConfig, EntityFrameAuthority, EntityLeaderState, EntityState } from '../types';
import { compareStableText } from '../../protocol/serialization';
import { encodeCanonicalConsensusValue } from '../../protocol/canonical-consensus-value';
import { cloneAccountInputWithoutPostCommitHankos, cloneAccountTxWithoutPostCommitHankos } from './hanko-witness';
import { computeBookCommitmentHash } from '../../orderbook/commitment';
import { createStructuredLogger } from '../../infra/logger';
import { isRuntimePerfProfileEnabled } from '../../infra/perf-runtime-flags';
import { getPerfMs } from '../../infra/time';
import { computeIntegrityDigest } from '../../infra/integrity-checksum';
import {
  buildEntityAccountCommitment,
  deleteEntityAccountCommitment,
  EMPTY_ENTITY_ACCOUNT_COMMITMENT,
  entityAccountCommitmentRoot,
  ENTITY_ACCOUNT_COMMITMENT_RADIX,
  putEntityAccountCommitment,
  type EntityAccountCommitment,
} from './account-commitment-tree';
import { EntityAccountCandidateMap, entityAccountCommitmentEntries } from '../candidate-map';

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
  'profileEncryptionManifest',
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
  'jBlockChain',
] as const satisfies readonly (keyof EntityState)[];

type AssertNoMissingEntityStateField<T extends never> = T;
export type EntityConsensusStateFieldCoverage = AssertNoMissingEntityStateField<
  Exclude<
    keyof EntityState,
    | (typeof ENTITY_STATE_ROOT_FIELDS)[number]
    | (typeof ENTITY_STATE_ROOT_EXCLUDED_FIELDS)[number]
  >
>;

const projectPendingWithdrawals = (withdrawals: AccountReplica['pendingWithdrawals']): Map<string, unknown> =>
  new Map(
    Array.from(withdrawals.entries()).map(([requestId, withdrawal]) => {
      const { signature: _signature, ...unsignedWithdrawal } = withdrawal;
      return [requestId, unsignedWithdrawal];
    }),
  );

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
    hubProfile: orderbookExt.hubProfile,
    referrals: orderbookExt.referrals,
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
  'globalCreditLimits',
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

type AssertNoMissingAccountStateField<T extends never> = T;
export type AccountStateFieldCoverage = AssertNoMissingAccountStateField<
  Exclude<keyof AccountState, (typeof ACCOUNT_ROOT_COMMITTED_FIELDS)[number]>
>;

/**
 * Deterministic Account replica fields committed by the parent Entity.
 *
 * This is an allowlist, not a spread-and-delete projection. A newly added
 * AccountReplica field must therefore make an explicit protocol choice below
 * instead of silently entering an Entity root.
 */
const ACCOUNT_ENTITY_COMMITTED_FIELDS = [
  'status',
  'mempool',
  'currentFrame',
  'swapOrderHistory',
  'swapClosedOrders',
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
  'counterpartyFrameHanko',
  'currentDisputeProofHanko',
  'counterpartyDisputeProofHanko',
  'counterpartySettlementHanko',
] as const satisfies readonly (keyof AccountReplica)[];

export type AccountReplicaFieldCoverage = AssertNoMissingAccountStateField<
  Exclude<
    keyof AccountReplica,
    | 'state'
    | (typeof ACCOUNT_ENTITY_COMMITTED_FIELDS)[number]
    | (typeof ACCOUNT_ENTITY_LOCAL_FIELDS)[number]
  >
>;

const projectAccountConsensusState = (account: AccountReplica): Record<string, unknown> => {
  const projected: Record<string, unknown> = {};
  for (const field of ACCOUNT_ENTITY_COMMITTED_FIELDS) {
    const value: unknown = account[field];
    if (value !== undefined) projected[field] = value;
  }
  projected['mempool'] = account.mempool.map(cloneAccountTxWithoutPostCommitHankos);
  projected['pendingWithdrawals'] = projectPendingWithdrawals(account.pendingWithdrawals);
  if (account.pendingAccountInput) {
    projected['pendingAccountInput'] = cloneAccountInputWithoutPostCommitHankos(account.pendingAccountInput);
  } else {
    delete projected['pendingAccountInput'];
  }
  if (account.lastOutboundFrameAck) {
    projected['lastOutboundFrameAck'] = {
      ...account.lastOutboundFrameAck,
      response: cloneAccountInputWithoutPostCommitHankos(account.lastOutboundFrameAck.response),
    };
  } else {
    delete projected['lastOutboundFrameAck'];
  }
  return projected;
};

const normalizeAuthoritySignerId = (value: string): string => value.trim().toLowerCase();

const normalizeAuthorityConfig = (config: ConsensusConfig): ConsensusConfig => {
  const shares: Record<string, bigint> = {};
  for (const [rawSignerId, share] of Object.entries(config.shares)) {
    const signerId = normalizeAuthoritySignerId(rawSignerId);
    if (!signerId || Object.prototype.hasOwnProperty.call(shares, signerId)) {
      throw new Error(`ENTITY_FRAME_AUTHORITY_DUPLICATE_SIGNER:${rawSignerId}`);
    }
    shares[signerId] = share;
  }
  return {
    ...structuredClone(config),
    validators: config.validators.map(normalizeAuthoritySignerId),
    shares,
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
  const normalized = normalizeAuthorityConfig(config);
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

const projectEntityConsensusState = (state: EntityState, expandAccounts = true): Record<string, unknown> => {
  // Preserve property presence exactly: optional fields that are absent from
  // the live State must remain absent from the signed projection. Symbols such
  // as the frame-local event collector cannot enter through this string-key
  // allowlist.
  const projected = Object.fromEntries(
    ENTITY_STATE_ROOT_FIELDS
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

const ENTITY_ACCOUNT_COMMITMENT_CACHE = Symbol('xln.entity.account-commitment-cache');
type EntityStateWithCommitmentCache = EntityState & {
  [ENTITY_ACCOUNT_COMMITMENT_CACHE]?: EntityAccountCommitment;
};

const readEntityAccountCommitmentCache = (state: EntityState): EntityAccountCommitment | undefined =>
  (state as EntityStateWithCommitmentCache)[ENTITY_ACCOUNT_COMMITMENT_CACHE];

const writeEntityAccountCommitmentCache = (state: EntityState, cache: EntityAccountCommitment): void => {
  Object.defineProperty(state, ENTITY_ACCOUNT_COMMITMENT_CACHE, {
    value: cache,
    configurable: true,
    writable: true,
    enumerable: false,
  });
};

const accountCommitmentValueHash = (account: AccountReplica): string =>
  computeIntegrityDigest(
    UTF8.encode(
      encodeCanonicalConsensusValue(projectAccountConsensusState(account)),
    ),
  );

const buildEntityAccountsCommitmentFromState = (
  state: EntityState,
): EntityAccountCommitment => {
  const entries: Array<readonly [string, string]> = [];
  for (const [rawCounterpartyId, account] of entityAccountCommitmentEntries(state.accounts)) {
    const counterpartyId = rawCounterpartyId.trim().toLowerCase();
    if (rawCounterpartyId !== counterpartyId) {
      throw new Error(
        `ENTITY_ACCOUNT_COMMITMENT_NON_CANONICAL_ID:${rawCounterpartyId}`,
      );
    }
    entries.push([counterpartyId, accountCommitmentValueHash(account)]);
  }
  return entries.length === 0
    ? EMPTY_ENTITY_ACCOUNT_COMMITMENT
    : buildEntityAccountCommitment(entries);
};

export const invalidateEntityAccountCommitment = (state: EntityState, counterpartyId: string): void => {
  const cached = readEntityAccountCommitmentCache(state);
  if (!cached) return;
  const normalized = counterpartyId.trim().toLowerCase();
  const account = state.accounts.get(normalized);
  writeEntityAccountCommitmentCache(
    state,
    account
      ? putEntityAccountCommitment(
          cached,
          normalized,
          accountCommitmentValueHash(account),
        )
      : deleteEntityAccountCommitment(cached, normalized),
  );
};

export const forkEntityAccountCommitmentCache = (source: EntityState, target: EntityState): void => {
  const sourceCache = readEntityAccountCommitmentCache(source);
  if (!sourceCache) return;
  // The trie is immutable. Certified State and its candidate share every
  // untouched node; invalidating one Account replaces only the candidate path.
  writeEntityAccountCommitmentCache(target, sourceCache);
};

const encodeEntityAccountsSection = (state: EntityState, cold: boolean): string => {
  let commitment = cold
    ? buildEntityAccountsCommitmentFromState(state)
    : (readEntityAccountCommitmentCache(state) ?? buildEntityAccountsCommitmentFromState(state));
  if (!cold && state.accounts instanceof EntityAccountCandidateMap) {
    // Merely reading an Account from the frame overlay materializes a mutable
    // clone. Its nested State can then change without another Map.set(), so a
    // cached certified leaf is no longer authoritative for every dirty key.
    // Refresh only those radix paths before hashing; a full million-account
    // rebuild would defeat the overlay, while trusting the old leaf can make
    // incremental and cold Entity roots diverge.
    for (const rawCounterpartyId of state.accounts.dirtyKeys()) {
      const counterpartyId = rawCounterpartyId.trim().toLowerCase();
      if (rawCounterpartyId !== counterpartyId) {
        throw new Error(`ENTITY_ACCOUNT_COMMITMENT_NON_CANONICAL_ID:${rawCounterpartyId}`);
      }
      const account = state.accounts.get(counterpartyId);
      commitment = account
        ? putEntityAccountCommitment(commitment, counterpartyId, accountCommitmentValueHash(account))
        : deleteEntityAccountCommitment(commitment, counterpartyId);
    }
  }
  if (!cold) writeEntityAccountCommitmentCache(state, commitment);
  return encodeCanonicalConsensusValue({
    domain: 'xln.entity.accounts.radix-merkle',
    radix: ENTITY_ACCOUNT_COMMITMENT_RADIX,
    hashAlgorithm: 'integrity',
    leafCount: commitment.leafCount,
    root: entityAccountCommitmentRoot(commitment),
  });
};

/**
 * Entity state is intentionally a hierarchy, not one giant serialized blob.
 * Scalar top-level sections are SHA-256 committed. The large Account section
 * is a persistent radix-Merkle commitment whose leaves bind complete projected
 * Account replicas. The small ordered section map is then bound by the signed
 * Keccak Entity root; Hanko still signs one outer 32-byte value.
 *
 * Counterexample: committing only Account state roots would omit pending
 * bilateral candidates and resend state that Entity consensus intentionally
 * certifies. Each Account leaf therefore hashes the full canonical projection;
 * only unchanged trie paths are reused.
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
  ethers.keccak256(
    ethers.toUtf8Bytes(
      encodeCanonicalConsensusValue({
        domain: 'xln.entity.consensus-state.sections',
        sections: sections.map(({ field, digest }) => ({ field, digest })),
      }),
    ),
  );

export const computeCanonicalEntityConsensusStateHash = (state: EntityState): string => {
  const profile = isRuntimePerfProfileEnabled('XLN_ENTITY_STATE_ROOT_PROFILE', 'XLN_RUNTIME_PROCESS_PROFILE');
  const startedAt = getPerfMs();
  const projected = projectEntityConsensusState(state, false);
  const projectedAt = getPerfMs();
  const sections = commitEntityConsensusSections(projected, state);
  const sectionsAt = getPerfMs();
  const root = computeEntityRootFromSections(sections);
  const endedAt = getPerfMs();
  if (isRuntimePerfProfileEnabled('XLN_ENTITY_STATE_ROOT_AUDIT')) {
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
  ethers.keccak256(
    ethers.toUtf8Bytes(
      encodeCanonicalConsensusValue({
        domain: 'xln.entity.frame-authority',
        authority: {
          config: projectConsensusConfigCommitment(authority.config),
          leaderState: normalizeAuthorityLeader(authority.config, authority.leaderState),
        },
      }),
    ),
  );
