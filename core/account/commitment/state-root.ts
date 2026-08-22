/**
 * Computes the bilateral Account state root and its deterministic nested Merkle maps.
 * Key projections: money, locks, disputes, Hankos, and lifecycle evidence exactly once.
 * Human-audit importance: 100/100 — both peers and on-chain recovery trust this commitment.
 */
import { ethers } from 'ethers';
import { readRuntimeEnv } from '../../support/process/runtime-process';
import { toLowerAddressOrNull } from '../../protocol/crypto/address-cache';
import type { AccountReplica, AccountState, AccountStateDomain } from '../../types/account';
import type { JurisdictionConfig } from '../../protocol/config/jurisdiction-config';
import { buildHexKeyedMerkle, type RadixMerkleHashAlgorithm } from '../../protocol/state/radix-merkle';
import { computeIntegrityDigest } from '../../support/integrity-checksum';
import { assertAccountJClaimAccumulatorState } from '../j-claims/j-claim-accumulator';
import { createStructuredLogger } from '../../support/logger';
import { getPerfMs } from '../../support/time';
import { observePerfCount } from '../../support/performance/profile';
import { countOp, OP_COUNTERS_ENABLED } from '../../support/performance/op-counters';
import { settlementWorkspaceWithoutHankos } from '../settlement/witness-projection';
import { encodeAccountStateValue } from './account-state-value';
import {
  requirePersistentAccountStateMap,
  type AccountStateCollection,
  type AccountStateMapKey,
  type AccountStateMapNamespace,
} from '../state/persistent-state-map';

const accountRootLog = createStructuredLogger('account.state-root');

export type { AccountStateDomain } from '../../types/account';
export { encodeAccountStateValue, encodeAccountStateValueOracle } from './account-state-value';

export const EMPTY_ACCOUNT_STATE_ROOT = `0x${'00'.repeat(32)}`;

export type AccountStateRootDebugRecord = {
  accountId: string;
  root: string;
  entries: ReadonlyArray<readonly [path: string, value: unknown]>;
};

export type AccountStateSectionHashes = Readonly<Record<string, string>>;

export type AccountCommitmentSectionDetail = Readonly<{
  locksRoot: string;
  pullsRoot: string;
  swapOffersRoot: string;
  subcontractsRoot: string;
  lendingIntentsRoot: string;
  settlementWorkspaceHash: string | null;
}>;

export type AccountStateRootTiming = {
  totalMs?: number;
  phases?: {
    mapsAndProjection: number;
    leafEncoding: number;
    merkle: number;
  };
  mapMs?: Record<string, number>;
  mapStatus?: Record<string, AccountMapCommitmentTiming>;
};

export type AccountMapCommitmentTiming = {
  mode: 'persistent' | 'cold-oracle';
  entries: number;
  dirtyKeys: 0;
};

let accountStateRootDebugRecorder: ((record: AccountStateRootDebugRecord) => void) | null = null;

export const setAccountStateRootDebugRecorder = (
  recorder: ((record: AccountStateRootDebugRecord) => void) | null,
): (() => void) => {
  const previous = accountStateRootDebugRecorder;
  accountStateRootDebugRecorder = recorder;
  return () => {
    accountStateRootDebugRecorder = previous;
  };
};

export const accountStateDomainFromJurisdiction = (
  jurisdiction: JurisdictionConfig,
): AccountStateDomain => normalizeAccountStateDomain({
  chainId: Number(jurisdiction.chainId),
  depositoryAddress: String(jurisdiction.depositoryAddress || ''),
}, 'ACCOUNT_STATE_DOMAIN');

export const normalizeAccountStateDomain = (
  domain: unknown,
  code = 'ACCOUNT_STATE_DOMAIN',
): AccountStateDomain => {
  const value: { readonly chainId?: unknown; readonly depositoryAddress?: unknown } =
    typeof domain === 'object' && domain !== null && !Array.isArray(domain)
      ? domain
      : {};
  const chainId = Number(value.chainId);
  const depositoryAddress = String(value.depositoryAddress || '');
  const lowerDepository = toLowerAddressOrNull(depositoryAddress);
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || lowerDepository === null) {
    throw new Error(`${code}_INVALID: chainId=${String(value.chainId)} depository=${depositoryAddress || 'missing'}`);
  }
  return { chainId, depositoryAddress: lowerDepository };
};

export const sameAccountStateDomain = (
  left: AccountStateDomain,
  right: AccountStateDomain,
): boolean => {
  const canonicalLeft = normalizeAccountStateDomain(left);
  const canonicalRight = normalizeAccountStateDomain(right);
  return canonicalLeft.chainId === canonicalRight.chainId &&
    canonicalLeft.depositoryAddress === canonicalRight.depositoryAddress;
};

const integrityLabelDigest = (label: string): string =>
  computeIntegrityDigest(new TextEncoder().encode(label));
const keccakLabelDigest = (label: string): string => ethers.keccak256(ethers.toUtf8Bytes(label));

const integrityMerkleKey = (namespace: string, path: string): string =>
  integrityLabelDigest(`xln.${namespace}.${path}`);

const ACCOUNT_STATE_LEAF_KEYS = Object.freeze({
  identity: integrityMerkleKey('account.state', 'identity'),
  financial: integrityMerkleKey('account.state', 'financial'),
  commitments: integrityMerkleKey('account.state', 'commitments'),
  jurisdiction: integrityMerkleKey('account.state', 'jurisdiction'),
  rebalance: integrityMerkleKey('account.state', 'rebalance'),
});

type AccountStateLeafPath = keyof typeof ACCOUNT_STATE_LEAF_KEYS;

const stateLeaf = (path: AccountStateLeafPath, value: unknown): { hexKey: string; value: Uint8Array } => ({
  // AccountState has exactly five fixed sections. Precompute their keys once;
  // an ambient cache for arbitrary entity/account IDs would violate the pure
  // transition model and retain attacker-controlled labels.
  hexKey: ACCOUNT_STATE_LEAF_KEYS[path],
  value: encodeAccountStateValue(value),
});

export const computeCanonicalMerkleRoot = (
  namespace: string,
  entries: ReadonlyArray<readonly [path: string, value: unknown]>,
  hashAlgorithm: RadixMerkleHashAlgorithm = 'keccak256',
): string => buildHexKeyedMerkle(entries.map(([path, value]) => ({
    hexKey: hashAlgorithm === 'integrity'
      ? integrityMerkleKey(namespace, path)
      : keccakLabelDigest(`xln.${namespace}.${path}`),
    value: encodeAccountStateValue(value),
})), { hashAlgorithm }).root;

const accountStateRootEntries = (
  account: AccountState,
  cold = false,
  mapTimings?: Record<string, number>,
  mapStatuses?: Record<string, AccountMapCommitmentTiming>,
): ReadonlyArray<readonly [path: AccountStateLeafPath, value: unknown]> => {
  const domain = normalizeAccountStateDomain(account.domain);
  const mapRoot = <K extends AccountStateMapKey, V>(
    namespace: AccountStateMapNamespace,
    map: AccountStateCollection<K, V> | undefined,
  ): string => {
    const startedAt = mapTimings ? getPerfMs() : 0;
    const persistent = map === undefined
      ? undefined
      : requirePersistentAccountStateMap(map, namespace);
    const root = persistent === undefined
      ? EMPTY_ACCOUNT_STATE_ROOT
      : cold ? persistent.coldRootHash() : persistent.rootHash();
    if (mapTimings) mapTimings[namespace] = getPerfMs() - startedAt;
    if (mapStatuses) mapStatuses[namespace] = {
      mode: cold ? 'cold-oracle' : 'persistent',
      entries: map?.size ?? 0,
      dirtyKeys: 0,
    };
    return root;
  };
  return [
    ['identity', {
    chainId: domain.chainId,
    depositoryAddress: domain.depositoryAddress.toLowerCase(),
    leftEntity: account.leftEntity.toLowerCase(),
    rightEntity: account.rightEntity.toLowerCase(),
    watchSeed: account.watchSeed.toLowerCase(),
    }],
    ['financial', {
    deltasRoot: mapRoot('deltas', account.deltas),
    jNonce: account.jNonce,
    disputeConfig: account.disputeConfig,
    }],
    ['commitments', {
    locksRoot: mapRoot('locks', account.locks),
    pullsRoot: mapRoot('pulls', account.pulls),
    swapOffersRoot: mapRoot('swapOffers', account.swapOffers),
    subcontractsRoot: mapRoot('subcontracts', account.subcontracts),
    lendingIntentsRoot: mapRoot('lendingIntents', account.lendingIntents),
    // Bind every settlement decision, amount, nonce and signed target. Exact
    // Hanko bytes are excluded because different valid threshold subsets can
    // authorize the same target; each witness is verified before application.
    settlementWorkspace: settlementWorkspaceWithoutHankos(account.settlementWorkspace),
    }],
    ['jurisdiction', {
    lastFinalizedJHeight: account.lastFinalizedJHeight,
    leftPendingJClaims: assertAccountJClaimAccumulatorState(account.leftPendingJClaims),
    rightPendingJClaims: assertAccountJClaimAccumulatorState(account.rightPendingJClaims),
    }],
    ['rebalance', {
    requestedRebalanceRoot: mapRoot('requestedRebalance', account.requestedRebalance),
    requestedRebalanceFeeStateRoot: mapRoot('requestedRebalanceFeeState', account.requestedRebalanceFeeState),
    rebalanceFeePoliciesRoot: mapRoot('rebalanceFeePolicies', account.rebalanceFeePolicies),
    }],
  ] as const satisfies ReadonlyArray<readonly [path: AccountStateLeafPath, value: unknown]>;
};

export const computeAccountStateSectionHashes = (
  account: AccountState,
): AccountStateSectionHashes => Object.fromEntries(
  accountStateRootEntries(account).map(([path, value]) => [
    path,
    computeIntegrityDigest(encodeAccountStateValue(value)),
  ]),
);

/** Cold section oracle used only for fail-fast diagnostics and cache audits. */
export const computeAccountStateSectionHashesCold = (
  account: AccountState,
): AccountStateSectionHashes => Object.fromEntries(
  accountStateRootEntries(account, true).map(([path, value]) => [
    path,
    computeIntegrityDigest(encodeAccountStateValue(value)),
  ]),
);

const accountCommitmentSectionDetail = (
  account: AccountState,
  cold: boolean,
): AccountCommitmentSectionDetail => {
  const root = <K extends number | string, V>(
    namespace: 'locks' | 'pulls' | 'swapOffers' | 'subcontracts' | 'lendingIntents',
    map: AccountStateCollection<K, V> | undefined,
  ): string => {
    if (map === undefined) return EMPTY_ACCOUNT_STATE_ROOT;
    const persistent = requirePersistentAccountStateMap(map, namespace);
    return cold ? persistent.coldRootHash() : persistent.rootHash();
  };
  return {
  locksRoot: root('locks', account.locks),
  pullsRoot: account.pulls === undefined
    ? EMPTY_ACCOUNT_STATE_ROOT
    : root('pulls', account.pulls),
  swapOffersRoot: root('swapOffers', account.swapOffers),
  subcontractsRoot: account.subcontracts === undefined
    ? EMPTY_ACCOUNT_STATE_ROOT
    : root('subcontracts', account.subcontracts),
  lendingIntentsRoot: account.lendingIntents === undefined
    ? EMPTY_ACCOUNT_STATE_ROOT
    : root('lendingIntents', account.lendingIntents),
  settlementWorkspaceHash: account.settlementWorkspace === undefined
    ? null
    : computeIntegrityDigest(encodeAccountStateValue(
        settlementWorkspaceWithoutHankos(account.settlementWorkspace),
      )),
  };
};

/** Exact per-map breakdown emitted only after a commitment-section mismatch. */
export const computeAccountCommitmentSectionDetail = (
  account: AccountState,
): AccountCommitmentSectionDetail => accountCommitmentSectionDetail(account, false);

/** Cold per-map oracle for commitment-section mismatch diagnostics. */
export const computeAccountCommitmentSectionDetailCold = (
  account: AccountState,
): AccountCommitmentSectionDetail => accountCommitmentSectionDetail(account, true);

/**
 * Repeat Account-root queries on one live state (transition key, exact-base,
 * proposal, commit, Entity leaf) must not rebuild the 5-section Merkle while
 * collections and scalars are unchanged. The memo is a non-enumerable field on
 * the AccountState value, never a GC-by-identity collection: those caches are
 * non-deterministic. Collection and scalar *replacement* miss via object
 * identity. Overlay handlers replace `settlementWorkspace` and accumulators;
 * they must not mutate those objects in place on a memoized state.
 */
type AccountRootScalarIdentities = {
  domain: AccountState['domain'];
  disputeConfig: AccountState['disputeConfig'];
  settlementWorkspace: AccountState['settlementWorkspace'];
  leftPendingJClaims: AccountState['leftPendingJClaims'];
  rightPendingJClaims: AccountState['rightPendingJClaims'];
  leftEntity: string;
  rightEntity: string;
  watchSeed: string;
  jNonce: number;
  lastFinalizedJHeight: number;
};

type AccountStateRootMemo = {
  collections: readonly unknown[];
  scalars: AccountRootScalarIdentities;
  root: string;
};

const ACCOUNT_STATE_ROOT_MEMO_MAX = 4_096;
const accountStateRootMemos = new Map<AccountState, AccountStateRootMemo>();

const ACCOUNT_ROOT_COLLECTION_FIELDS = [
  'deltas',
  'locks',
  'pulls',
  'swapOffers',
  'subcontracts',
  'lendingIntents',
  'requestedRebalance',
  'requestedRebalanceFeeState',
  'rebalanceFeePolicies',
] as const satisfies readonly (keyof AccountState)[];

const accountRootCollectionIdentities = (account: AccountState): unknown[] =>
  ACCOUNT_ROOT_COLLECTION_FIELDS.map(field => account[field]);

const accountRootScalarIdentities = (account: AccountState): AccountRootScalarIdentities => ({
  domain: account.domain,
  disputeConfig: account.disputeConfig,
  settlementWorkspace: account.settlementWorkspace,
  leftPendingJClaims: account.leftPendingJClaims,
  rightPendingJClaims: account.rightPendingJClaims,
  leftEntity: account.leftEntity,
  rightEntity: account.rightEntity,
  watchSeed: account.watchSeed,
  jNonce: account.jNonce,
  lastFinalizedJHeight: account.lastFinalizedJHeight,
});

const sameCollections = (left: readonly unknown[], right: readonly unknown[]): boolean => {
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
};

const sameScalarIdentities = (left: AccountRootScalarIdentities, account: AccountState): boolean =>
  left.domain === account.domain &&
  left.disputeConfig === account.disputeConfig &&
  left.settlementWorkspace === account.settlementWorkspace &&
  left.leftPendingJClaims === account.leftPendingJClaims &&
  left.rightPendingJClaims === account.rightPendingJClaims &&
  left.leftEntity === account.leftEntity &&
  left.rightEntity === account.rightEntity &&
  left.watchSeed === account.watchSeed &&
  left.jNonce === account.jNonce &&
  left.lastFinalizedJHeight === account.lastFinalizedJHeight;

const readAccountStateRootMemo = (account: AccountState): AccountStateRootMemo | undefined => {
  return accountStateRootMemos.get(account);
};

const writeAccountStateRootMemo = (account: AccountState, memo: AccountStateRootMemo): boolean => {
  if (accountStateRootMemos.size >= ACCOUNT_STATE_ROOT_MEMO_MAX && !accountStateRootMemos.has(account)) {
    const oldest = accountStateRootMemos.keys().next();
    if (!oldest.done) accountStateRootMemos.delete(oldest.value);
  }
  accountStateRootMemos.set(account, memo);
  return true;
};

/**
 * Carry one already-verified derived root across an exact AccountState shell
 * fork. The fork owns fresh bounded records, so the memo is rebound to the
 * target identities instead of copying the non-enumerable cache object.
 *
 * This is safe only for a value-preserving fork. Any later collection/scalar
 * replacement misses through the identities below; Account transitions then
 * compute and install the new root before Entity commits the child leaf.
 */
export const transferAccountStateRootMemo = (
  source: AccountState,
  target: AccountState,
): boolean => {
  const sourceCollections = accountRootCollectionIdentities(source);
  const memo = readAccountStateRootMemo(source);
  if (
    !memo ||
    !sameCollections(memo.collections, sourceCollections) ||
    !sameScalarIdentities(memo.scalars, source)
  ) return false;
  return writeAccountStateRootMemo(target, {
    collections: accountRootCollectionIdentities(target),
    scalars: accountRootScalarIdentities(target),
    root: memo.root,
  });
};

export const computeAccountStateRoot = (
  account: AccountState,
  timing?: AccountStateRootTiming,
  source = 'unspecified',
): string => {
  if (timing === undefined && accountStateRootDebugRecorder === null) {
    const collections = accountRootCollectionIdentities(account);
    const memo = readAccountStateRootMemo(account);
    if (memo && sameCollections(memo.collections, collections) && sameScalarIdentities(memo.scalars, account)) {
      observePerfCount('account.stateRoot.cacheHit');
      observePerfCount(`account.stateRoot.cacheHit.${source}`);
      countOp(`account.stateRoot.cacheHit.${source}`);
      return memo.root;
    }
    observePerfCount('account.stateRoot.cacheMiss');
    observePerfCount(`account.stateRoot.cacheMiss.${source}`);
    const startedAt = OP_COUNTERS_ENABLED ? getPerfMs() : 0;
    const root = computeAccountStateRootUncached(account);
    countOp(
      `account.stateRoot.cacheMiss.${source}`,
      0,
      OP_COUNTERS_ENABLED ? Math.round((getPerfMs() - startedAt) * 1_000) : 0,
    );
    writeAccountStateRootMemo(account, { collections, scalars: accountRootScalarIdentities(account), root });
    return root;
  }
  observePerfCount(`account.stateRoot.uncached.${source}`);
  return computeAccountStateRootUncached(account, timing);
};

const computeAccountStateRootUncached = (
  account: AccountState,
  timing?: AccountStateRootTiming,
): string => {
  // Explicit opt-in only: one log line per Account root would otherwise ride
  // along with every frame-level process profile.
  const explicitProfile = readRuntimeEnv('XLN_ACCOUNT_STATE_ROOT_PROFILE') === '1';
  const profile = Boolean(timing) || explicitProfile;
  const startedAt = profile ? getPerfMs() : 0;
  const mapTimings: Record<string, number> | undefined = profile ? {} : undefined;
  const mapStatuses: Record<string, AccountMapCommitmentTiming> | undefined = profile ? {} : undefined;
  const entries = accountStateRootEntries(account, false, mapTimings, mapStatuses);
  const entriesAt = profile ? getPerfMs() : 0;
  const leaves = entries.map(([path, value]) => stateLeaf(path, value));
  const leavesAt = profile ? getPerfMs() : 0;
  const root = buildHexKeyedMerkle(leaves, { hashAlgorithm: 'integrity' }).root;
  if (profile) {
    const endedAt = getPerfMs();
    const profileRecord = {
      totalMs: Number((endedAt - startedAt).toFixed(3)),
      phases: {
        mapsAndProjection: Number((entriesAt - startedAt).toFixed(3)),
        leafEncoding: Number((leavesAt - entriesAt).toFixed(3)),
        merkle: Number((endedAt - leavesAt).toFixed(3)),
      },
      mapMs: Object.fromEntries(Object.entries(mapTimings ?? {}).map(([key, value]) => [key, Number(value.toFixed(3))])),
      mapStatus: mapStatuses,
    };
    if (timing) Object.assign(timing, profileRecord);
    if (explicitProfile) {
      accountRootLog.info('profile', {
        account: `${account.leftEntity.slice(-8)}:${account.rightEntity.slice(-8)}`,
        ...profileRecord,
      });
    }
  }
  if (accountStateRootDebugRecorder) {
    accountStateRootDebugRecorder({
      accountId: `${account.leftEntity.toLowerCase()}:${account.rightEntity.toLowerCase()}`,
      root,
      entries: structuredClone(entries),
    });
  }
  return root;
};

/** Cold oracle used by tests/restore audits to detect every missed cache invalidation. */
export const computeAccountStateRootCold = (account: AccountState): string => {
  const entries = accountStateRootEntries(account, true);
  return buildHexKeyedMerkle(
    entries.map(([path, value]) => stateLeaf(path, value)),
    { hashAlgorithm: 'integrity' },
  ).root;
};

const pendingWithdrawalOverlayRoot = (
  withdrawals: AccountReplica['pendingWithdrawals'],
): string => requirePersistentAccountStateMap(withdrawals, 'pendingWithdrawals').rootHash();

const accountEntityOverlayState = (account: AccountReplica): unknown => ({
  status: account.status,
  disputePrepare: account.disputePrepare,
  settlementWorkspace: settlementWorkspaceWithoutHankos(account.state.settlementWorkspace),
  activeDispute: account.activeDispute,
  pendingForwards: account.pendingForwards,
  pendingWithdrawalsRoot: pendingWithdrawalOverlayRoot(account.pendingWithdrawals),
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
      activeQuote: account.shadow.rebalance.activeQuote,
      pendingRequest: account.shadow.rebalance.pendingRequest,
    },
    rejectedFrameEvidence: account.shadow.rejectedFrameEvidence,
  },
});

export const computeAccountShadowRoot = (
  accounts: ReadonlyMap<string, AccountReplica>,
): string => computeCanonicalMerkleRoot(
  'entity.account-shadow',
  Array.from(accounts.entries()).map(([counterpartyId, account]) => [
    counterpartyId.toLowerCase(),
    accountEntityOverlayState(account),
  ] as const),
);
