/**
 * Computes the bilateral Account state root and its deterministic nested Merkle maps.
 * Key projections: money, locks, disputes, Hankos, and lifecycle evidence exactly once.
 * Human-audit importance: 100/100 — both peers and on-chain recovery trust this commitment.
 */
import { ethers } from 'ethers';
import { readRuntimeEnv } from '../../support/process/runtime-process';
import { toLowerAddressOrNull } from '../../protocol/crypto/address-cache';
import { utf8Bytes } from '../../protocol/crypto/keccak-text';

import type { AccountReplica, AccountState, AccountStateDomain } from '../../types/account';
import type { JurisdictionConfig } from '../../protocol/config/jurisdiction-config';
import { compareStableText } from '../../protocol/serialization';
import { buildHexKeyedMerkle, type RadixMerkleHashAlgorithm } from '../../protocol/state/radix-merkle';
import { computeIntegrityDigest } from '../../support/integrity-checksum';
import { assertAccountJClaimAccumulatorState } from '../j-claims/j-claim-accumulator';
import { createStructuredLogger } from '../../support/logger';
import { getPerfMs } from '../../support/time';
import { settlementWorkspaceWithoutHankos } from '../settlement/witness-projection';
import {
  requirePersistentAccountStateMap,
  type AccountStateCollection,
  type AccountStateMapKey,
  type AccountStateMapNamespace,
} from '../state/persistent-state-map';

const accountRootLog = createStructuredLogger('account.state-root');

export type { AccountStateDomain } from '../../types/account';

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

type RlpNode = string | RlpNode[];

const textNode = (value: string): string => ethers.hexlify(utf8Bytes(value));

const scalarNode = (value: null | boolean | number | bigint | string): RlpNode => {
  if (value === null) return [textNode('null')];
  if (typeof value === 'boolean') return [textNode('bool'), value ? '0x01' : '0x00'];
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`ACCOUNT_STATE_RLP_NON_FINITE_NUMBER:${String(value)}`);
    return [textNode('number'), textNode(String(value))];
  }
  if (typeof value === 'bigint') {
    const magnitude = value < 0n ? -value : value;
    return [textNode('bigint'), value < 0n ? '0x01' : '0x00', ethers.toBeHex(magnitude)];
  }
  return [textNode('string'), textNode(value)];
};

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const limit = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < limit; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
};

const rlpLengthBytes = (length: number): Uint8Array => {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`ACCOUNT_STATE_RLP_LENGTH_INVALID:${String(length)}`);
  }
  if (length === 0) return Uint8Array.of(0);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.push(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  bytes.reverse();
  return Uint8Array.from(bytes);
};

const concatBytes = (parts: readonly Uint8Array[], totalLength: number): Uint8Array => {
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

const encodeRlpPayload = (payload: Uint8Array, list: boolean): Uint8Array => {
  if (!list && payload.byteLength === 1 && payload[0]! < 0x80) return payload;
  const shortBase = list ? 0xc0 : 0x80;
  const longBase = list ? 0xf7 : 0xb7;
  if (payload.byteLength <= 55) {
    return concatBytes([Uint8Array.of(shortBase + payload.byteLength), payload], payload.byteLength + 1);
  }
  const lengthBytes = rlpLengthBytes(payload.byteLength);
  return concatBytes(
    [Uint8Array.of(longBase + lengthBytes.byteLength), lengthBytes, payload],
    1 + lengthBytes.byteLength + payload.byteLength,
  );
};

/** Byte-identical to ethers.encodeRlp, without its recursive hex/string round trips. */
const encodeRlpNode = (node: RlpNode): Uint8Array => {
  if (typeof node === 'string') return encodeRlpPayload(ethers.getBytes(node), false);
  const children = node.map(encodeRlpNode);
  const payloadLength = children.reduce((total, child) => total + child.byteLength, 0);
  return encodeRlpPayload(concatBytes(children, payloadLength), true);
};

/** RLP list header + children written into one buffer (no payload copy). */
const encodeRlpList = (children: readonly Uint8Array[]): Uint8Array => {
  let payloadLength = 0;
  for (const child of children) payloadLength += child.byteLength;
  const lengthBytes = payloadLength <= 55 ? null : rlpLengthBytes(payloadLength);
  const headerLength = lengthBytes ? 1 + lengthBytes.byteLength : 1;
  const output = new Uint8Array(headerLength + payloadLength);
  if (lengthBytes) {
    output[0] = 0xf7 + lengthBytes.byteLength;
    output.set(lengthBytes, 1);
  } else {
    output[0] = 0xc0 + payloadLength;
  }
  let offset = headerLength;
  for (const child of children) {
    output.set(child, offset);
    offset += child.byteLength;
  }
  return output;
};

// Type tags and field names repeat in every encoded value; memoize their RLP.
const TEXT_MEMO_MAX_LENGTH = 64;
const TEXT_MEMO_MAX = 8192;
const textMemo = new Map<string, Uint8Array>();
const encodeText = (value: string): Uint8Array => {
  if (value.length > TEXT_MEMO_MAX_LENGTH) return encodeRlpPayload(utf8Bytes(value), false);
  const cached = textMemo.get(value);
  if (cached) return cached;
  const encoded = encodeRlpPayload(utf8Bytes(value), false);
  if (textMemo.size >= TEXT_MEMO_MAX) textMemo.clear();
  textMemo.set(value, encoded);
  return encoded;
};

const bigintMagnitudeBytes = (magnitude: bigint): Uint8Array => {
  if (magnitude === 0n) return Uint8Array.of(0);
  const hex = magnitude.toString(16);
  const padded = hex.length % 2 ? `0${hex}` : hex;
  const bytes = new Uint8Array(padded.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const nodeSortKey = (node: RlpNode): Uint8Array => encodeRlpNode(node);

const canonicalRlpNode = (value: unknown): RlpNode => {
  if (value === null || ['boolean', 'number', 'bigint', 'string'].includes(typeof value)) {
    return scalarNode(value as null | boolean | number | bigint | string);
  }
  if (Array.isArray(value)) return [textNode('array'), ...value.map(canonicalRlpNode)];
  if (value instanceof Map) {
    const entries = Array.from(value.entries()).map(([key, entry]) => {
      const keyNode = canonicalRlpNode(key);
      return {
        node: [keyNode, canonicalRlpNode(entry)] satisfies RlpNode[],
        sortKey: nodeSortKey(keyNode),
      };
    });
    entries.sort((left, right) => compareBytes(left.sortKey, right.sortKey));
    return [textNode('map'), ...entries.map(entry => entry.node)];
  }
  if (value instanceof Set) {
    const entries = Array.from(value.values()).map((entry) => {
      const node = canonicalRlpNode(entry);
      return { node, sortKey: nodeSortKey(node) };
    }).sort((left, right) => compareBytes(left.sortKey, right.sortKey));
    return [textNode('set'), ...entries.map(entry => entry.node)];
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([key, entry]) => [textNode(key), canonicalRlpNode(entry)] satisfies RlpNode[]);
    return [textNode('object'), ...entries];
  }
  throw new Error(`ACCOUNT_STATE_RLP_UNSUPPORTED:${typeof value}`);
};

/**
 * Byte-identical to encodeRlpNode(canonicalRlpNode(value)), but emits the RLP
 * bottom-up. A cross-j pull contains a complete immutable route; building a
 * second recursive RlpNode graph for every dirty pull doubled allocation and
 * traversal cost on the hub hot path.
 */
const encodeAccountStateValueDirect = (value: unknown): Uint8Array => {
  if (value === null) return encodeRlpList([encodeText('null')]);
  if (typeof value === 'boolean') {
    return encodeRlpList([encodeText('bool'), encodeRlpPayload(Uint8Array.of(value ? 1 : 0), false)]);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`ACCOUNT_STATE_RLP_NON_FINITE_NUMBER:${String(value)}`);
    return encodeRlpList([encodeText('number'), encodeText(String(value))]);
  }
  if (typeof value === 'bigint') {
    const magnitude = value < 0n ? -value : value;
    return encodeRlpList([
      encodeText('bigint'),
      encodeRlpPayload(Uint8Array.of(value < 0n ? 1 : 0), false),
      encodeRlpPayload(bigintMagnitudeBytes(magnitude), false),
    ]);
  }
  if (typeof value === 'string') {
    return encodeRlpList([encodeText('string'), encodeText(value)]);
  }
  if (Array.isArray(value)) {
    return encodeRlpList([encodeText('array'), ...value.map(encodeAccountStateValueDirect)]);
  }
  if (value instanceof Map) {
    const entries = Array.from(value.entries()).map(([key, entry]) => {
      const encodedKey = encodeAccountStateValueDirect(key);
      return {
        encodedKey,
        encodedEntry: encodeRlpList([encodedKey, encodeAccountStateValueDirect(entry)]),
      };
    }).sort((left, right) => compareBytes(left.encodedKey, right.encodedKey));
    return encodeRlpList([encodeText('map'), ...entries.map(entry => entry.encodedEntry)]);
  }
  if (value instanceof Set) {
    const entries = Array.from(value.values(), encodeAccountStateValueDirect).sort(compareBytes);
    return encodeRlpList([encodeText('set'), ...entries]);
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([key, entry]) => encodeRlpList([encodeText(key), encodeAccountStateValueDirect(entry)]));
    return encodeRlpList([encodeText('object'), ...entries]);
  }
  throw new Error(`ACCOUNT_STATE_RLP_UNSUPPORTED:${typeof value}`);
};

export const encodeAccountStateValueOracle = (value: unknown): Uint8Array =>
  encodeRlpNode(canonicalRlpNode(value));

export const encodeAccountStateValue = (value: unknown): Uint8Array =>
  encodeAccountStateValueDirect(value);

// Merkle keys derive from a small fixed vocabulary of section/field names, so
// their digests are memoized instead of re-hashed for every Account leaf.
const MERKLE_KEY_MEMO_MAX = 4096;
// One memo per digest algorithm: the same label hashes differently per algorithm.
const merkleKeyMemos = new WeakMap<(label: string) => string, Map<string, string>>();
const merkleKey = (label: string, digest: (label: string) => string): string => {
  let memo = merkleKeyMemos.get(digest);
  if (!memo) merkleKeyMemos.set(digest, (memo = new Map()));
  const cached = memo.get(label);
  if (cached !== undefined) return cached;
  const value = digest(label);
  if (memo.size >= MERKLE_KEY_MEMO_MAX) memo.clear();
  memo.set(label, value);
  return value;
};
const integrityLabelDigest = (label: string): string =>
  computeIntegrityDigest(new TextEncoder().encode(label));
const keccakLabelDigest = (label: string): string => ethers.keccak256(ethers.toUtf8Bytes(label));

const integrityMerkleKey = (namespace: string, path: string): string =>
  merkleKey(`xln.${namespace}.${path}`, integrityLabelDigest);

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
      : merkleKey(`xln.${namespace}.${path}`, keccakLabelDigest),
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
 * One Account root is asked for several times per bilateral frame on both
 * sides — transition key, exact-base check, proposal frame, commit check and
 * the Entity leaf (twice) — while the state itself changes once. The memo
 * lives on the AccountState object and is keyed by everything the root reads:
 * the persistent collections by identity (they are immutable and replaced on
 * change) and the bounded scalar sections by their exact leaf bytes. In-place
 * mutation of any root input therefore misses instead of returning a stale
 * root; the memo is never trusted on identity alone.
 */
type AccountStateRootMemo = {
  collections: readonly unknown[];
  scalarBytes: string;
  root: string;
};
const accountStateRootMemos = new WeakMap<AccountState, AccountStateRootMemo>();

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

/** Every non-collection input of `accountStateRootEntries`, as exact bytes. */
const accountRootScalarBytes = (account: AccountState): string => {
  const domain = normalizeAccountStateDomain(account.domain);
  return bytesToHexText(encodeAccountStateValue({
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

const bytesToHexText = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const sameCollections = (left: readonly unknown[], right: readonly unknown[]): boolean => {
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
};

export const computeAccountStateRoot = (
  account: AccountState,
  timing?: AccountStateRootTiming,
): string => {
  if (timing === undefined) {
    const collections = accountRootCollectionIdentities(account);
    const scalarBytes = accountRootScalarBytes(account);
    const memo = accountStateRootMemos.get(account);
    if (memo && memo.scalarBytes === scalarBytes && sameCollections(memo.collections, collections)) {
      return memo.root;
    }
    const root = computeAccountStateRootUncached(account);
    accountStateRootMemos.set(account, { collections, scalarBytes, root });
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
