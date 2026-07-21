import { ethers } from 'ethers';

import type { AccountMachine, AccountStateDomain, JurisdictionConfig, SettlementWorkspace } from '../types';
import { compareStableText } from '../protocol/serialization';
import { buildHexKeyedMerkle, type RadixMerkleHashAlgorithm } from '../storage/merkle';
import { computeIntegrityDigest } from '../infra/integrity-checksum';
import { assertAccountJClaimAccumulatorState } from './j-claim-accumulator';
import {
  computeAccountMapCommitment,
  type AccountMapCommitmentTiming,
} from './map-commitment';
import { createStructuredLogger } from '../infra/logger';
import { isRuntimePerfProfileEnabled } from '../infra/perf-runtime-flags';
import { getPerfMs } from '../utils';

const accountRootLog = createStructuredLogger('account.state-root');

export type { AccountStateDomain } from '../types';

export const EMPTY_ACCOUNT_STATE_ROOT = `0x${'00'.repeat(32)}`;

export type AccountStateRootDebugRecord = {
  accountId: string;
  root: string;
  entries: ReadonlyArray<readonly [path: string, value: unknown]>;
};

export type AccountStateSectionHashes = Readonly<Record<string, string>>;

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
  domain: AccountStateDomain,
  code = 'ACCOUNT_STATE_DOMAIN',
): AccountStateDomain => {
  const chainId = Number(domain?.chainId);
  const depositoryAddress = String(domain?.depositoryAddress || '');
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !ethers.isAddress(depositoryAddress)) {
    throw new Error(`${code}_INVALID: chainId=${String(domain?.chainId)} depository=${depositoryAddress || 'missing'}`);
  }
  return { chainId, depositoryAddress: depositoryAddress.toLowerCase() };
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

const textNode = (value: string): string => ethers.hexlify(ethers.toUtf8Bytes(value));

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

const encodeRlpList = (children: readonly Uint8Array[]): Uint8Array => {
  const payloadLength = children.reduce((total, child) => total + child.byteLength, 0);
  return encodeRlpPayload(concatBytes(children, payloadLength), true);
};

const encodeText = (value: string): Uint8Array =>
  encodeRlpPayload(ethers.toUtf8Bytes(value), false);

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
      encodeRlpPayload(ethers.getBytes(ethers.toBeHex(magnitude)), false),
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

const integrityMerkleKey = (namespace: string, path: string): string =>
  computeIntegrityDigest(new TextEncoder().encode(`xln.${namespace}.${path}`));

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
      : ethers.keccak256(ethers.toUtf8Bytes(`xln.${namespace}.${path}`)),
    value: encodeAccountStateValue(value),
})), { hashAlgorithm }).root;

const accountStateRootEntries = (
  account: AccountMachine,
  cold = false,
  mapTimings?: Record<string, number>,
  mapStatuses?: Record<string, AccountMapCommitmentTiming>,
): ReadonlyArray<readonly [path: string, value: unknown]> => {
  const domain = normalizeAccountStateDomain(account.domain);
  const mapRoot = (namespace: Parameters<typeof computeAccountMapCommitment>[1]): string => {
    const startedAt = mapTimings ? getPerfMs() : 0;
    const status = mapStatuses ? {} as AccountMapCommitmentTiming : undefined;
    const root = computeAccountMapCommitment(account, namespace, encodeAccountStateValue, cold, status);
    if (mapTimings) mapTimings[namespace] = getPerfMs() - startedAt;
    if (status && mapStatuses) mapStatuses[namespace] = status;
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
    deltasRoot: mapRoot('deltas'),
    globalCreditLimits: account.globalCreditLimits,
    jNonce: account.jNonce,
    disputeConfig: account.disputeConfig,
    }],
    ['commitments', {
    locksRoot: mapRoot('locks'),
    pullsRoot: mapRoot('pulls'),
    swapOffersRoot: mapRoot('swapOffers'),
    subcontractsRoot: mapRoot('subcontracts'),
    lendingIntentsRoot: mapRoot('lendingIntents'),
    // Settlement is bilateral Account state, not an Entity-local UI overlay.
    // Bind the full sealed workspace, including its exact Hankos, so every
    // later Account frame proves the same executable authorization. Undefined
    // is omitted by canonicalRlpNode, preserving roots for accounts without one.
    settlementWorkspace: account.settlementWorkspace,
    }],
    ['jurisdiction', {
    lastFinalizedJHeight: account.lastFinalizedJHeight,
    leftPendingJClaims: assertAccountJClaimAccumulatorState(account.leftPendingJClaims),
    rightPendingJClaims: assertAccountJClaimAccumulatorState(account.rightPendingJClaims),
    }],
    ['rebalance', {
    requestedRebalance: account.requestedRebalance,
    requestedRebalanceFeeState: account.requestedRebalanceFeeState,
    rebalanceFeePolicies: account.rebalanceFeePolicies,
    }],
  ] as const satisfies ReadonlyArray<readonly [path: string, value: unknown]>;
};

export const computeAccountStateSectionHashes = (
  account: AccountMachine,
): AccountStateSectionHashes => Object.fromEntries(
  accountStateRootEntries(account).map(([path, value]) => [
    path,
    computeIntegrityDigest(encodeAccountStateValue(value)),
  ]),
);

export const computeAccountStateRoot = (
  account: AccountMachine,
  timing?: AccountStateRootTiming,
): string => {
  const profile = Boolean(timing) ||
    isRuntimePerfProfileEnabled('XLN_ACCOUNT_STATE_ROOT_PROFILE', 'XLN_RUNTIME_PROCESS_PROFILE');
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
    if (isRuntimePerfProfileEnabled('XLN_ACCOUNT_STATE_ROOT_PROFILE', 'XLN_RUNTIME_PROCESS_PROFILE')) {
      accountRootLog.warn('profile', {
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
export const computeAccountStateRootCold = (account: AccountMachine): string => {
  const entries = accountStateRootEntries(account, true);
  return buildHexKeyedMerkle(
    entries.map(([path, value]) => stateLeaf(path, value)),
    { hashAlgorithm: 'integrity' },
  ).root;
};

export const assertAccountStateRootCache = (account: AccountMachine, code = 'ACCOUNT_STATE_ROOT_CACHE'): string => {
  const incremental = computeAccountStateRoot(account);
  const cold = computeAccountStateRootCold(account);
  if (incremental !== cold) throw new Error(`${code}_MISMATCH:incremental=${incremental}:cold=${cold}`);
  return incremental;
};

const settlementOverlayState = (
  workspace: SettlementWorkspace | undefined,
): unknown => {
  if (!workspace) return undefined;
  const {
    leftHanko: _leftHanko,
    rightHanko: _rightHanko,
    postSettlementDisputeProof,
    ...state
  } = workspace;
  if (!postSettlementDisputeProof) return state;
  const {
    leftHanko: _postLeftHanko,
    rightHanko: _postRightHanko,
    ...postSettlementState
  } = postSettlementDisputeProof;
  return { ...state, postSettlementDisputeProof: postSettlementState };
};

const pendingWithdrawalOverlayState = (
  withdrawals: AccountMachine['pendingWithdrawals'],
): Map<string, Omit<AccountMachine['pendingWithdrawals'] extends Map<string, infer Entry> ? Entry : never, 'signature'>> =>
  new Map(Array.from(withdrawals.entries()).map(([requestId, withdrawal]) => {
    const { signature: _signature, ...state } = withdrawal;
    return [requestId, state];
  }));

const accountEntityOverlayState = (account: AccountMachine): unknown => ({
  status: account.status,
  disputePrepare: account.disputePrepare,
  settlementWorkspace: settlementOverlayState(account.settlementWorkspace),
  activeDispute: account.activeDispute,
  pendingForwards: account.pendingForwards,
  pendingWithdrawals: pendingWithdrawalOverlayState(account.pendingWithdrawals),
  shadow: account.shadow,
});

export const computeAccountShadowRoot = (
  accounts: ReadonlyMap<string, AccountMachine>,
): string => computeCanonicalMerkleRoot(
  'entity.account-shadow',
  Array.from(accounts.entries()).map(([counterpartyId, account]) => [
    counterpartyId.toLowerCase(),
    accountEntityOverlayState(account),
  ] as const),
);
