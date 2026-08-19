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

const stateLeaf = (path: string, value: unknown): { hexKey: string; value: Uint8Array } => ({
  hexKey: integrityMerkleKey('account.state', path),
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
): ReadonlyArray<readonly [path: string, value: unknown]> => {
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
  ] as const satisfies ReadonlyArray<readonly [path: string, value: unknown]>;
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
 * non-deterministic. In-place scalar edits miss via exact scalar bytes;
 * collection replacement misses via object identity.
 */
const ACCOUNT_STATE_ROOT_MEMO = Symbol('ACCOUNT_STATE_ROOT_MEMO');

type AccountStateRootMemo = {
  collections: readonly unknown[];
  scalarBytes: string;
  root: string;
};

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

const accountRootScalarBytes = (account: AccountState): string => {
  const domain = normalizeAccountStateDomain(account.domain);
  return ethers.hexlify(encodeAccountStateValue({
    chainId: domain.chainId,
    depositoryAddress: domain.depositoryAddress,
    leftEntity: account.leftEntity,
    rightEntity: account.rightEntity,
    watchSeed: account.watchSeed,
    jNonce: account.jNonce,
    disputeConfig: account.disputeConfig,
    settlementWorkspace: settlementWorkspaceWithoutHankos(account.settlementWorkspace),
    lastFinalizedJHeight: account.lastFinalizedJHeight,
    leftPendingJClaims: account.leftPendingJClaims,
    rightPendingJClaims: account.rightPendingJClaims,
  }));
};

const sameCollections = (left: readonly unknown[], right: readonly unknown[]): boolean => {
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
};

const readAccountStateRootMemo = (account: AccountState): AccountStateRootMemo | undefined => {
  const memo = Reflect.get(account, ACCOUNT_STATE_ROOT_MEMO);
  return memo === undefined ? undefined : memo as AccountStateRootMemo;
};

const writeAccountStateRootMemo = (account: AccountState, memo: AccountStateRootMemo): void => {
  const existing = Object.getOwnPropertyDescriptor(account, ACCOUNT_STATE_ROOT_MEMO);
  if (existing?.writable) {
    Reflect.set(account, ACCOUNT_STATE_ROOT_MEMO, memo);
    return;
  }
  try {
    Object.defineProperty(account, ACCOUNT_STATE_ROOT_MEMO, {
      value: memo,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Frozen/sealed AccountState still hashes correctly; it cannot cache.
  }
};

export const computeAccountStateRoot = (
  account: AccountState,
  timing?: AccountStateRootTiming,
): string => {
  if (timing === undefined && accountStateRootDebugRecorder === null) {
    const collections = accountRootCollectionIdentities(account);
    const scalarBytes = accountRootScalarBytes(account);
    const memo = readAccountStateRootMemo(account);
    if (memo && memo.scalarBytes === scalarBytes && sameCollections(memo.collections, collections)) {
      return memo.root;
    }
    const root = computeAccountStateRootUncached(account);
    writeAccountStateRootMemo(account, { collections, scalarBytes, root });
    return root;
  }
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
