import { ethers } from 'ethers';

import type { AccountMachine, AccountStateDomain, JurisdictionConfig, SettlementWorkspace } from '../types';
import { buildHexKeyedMerkle } from '../storage/merkle';
import { assertAccountJClaimAccumulatorState } from './j-claim-accumulator';

export type { AccountStateDomain } from '../types';

export const EMPTY_ACCOUNT_STATE_ROOT = `0x${'00'.repeat(32)}`;

export type AccountStateRootDebugRecord = {
  accountId: string;
  root: string;
  entries: ReadonlyArray<readonly [path: string, value: unknown]>;
};

export type AccountStateSectionHashes = Readonly<Record<string, string>>;

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

const nodeSortKey = (node: RlpNode): string => ethers.encodeRlp(node);

const canonicalRlpNode = (value: unknown): RlpNode => {
  if (value === null || ['boolean', 'number', 'bigint', 'string'].includes(typeof value)) {
    return scalarNode(value as null | boolean | number | bigint | string);
  }
  if (Array.isArray(value)) return [textNode('array'), ...value.map(canonicalRlpNode)];
  if (value instanceof Map) {
    const entries = Array.from(value.entries()).map(([key, entry]) => [canonicalRlpNode(key), canonicalRlpNode(entry)] satisfies RlpNode[]);
    entries.sort((left, right) => nodeSortKey(left[0]!).localeCompare(nodeSortKey(right[0]!)));
    return [textNode('map'), ...entries];
  }
  if (value instanceof Set) {
    const entries = Array.from(value.values()).map(canonicalRlpNode).sort((left, right) => nodeSortKey(left).localeCompare(nodeSortKey(right)));
    return [textNode('set'), ...entries];
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [textNode(key), canonicalRlpNode(entry)] satisfies RlpNode[]);
    return [textNode('object'), ...entries];
  }
  throw new Error(`ACCOUNT_STATE_RLP_UNSUPPORTED:${typeof value}`);
};

const encodeRlpValue = (value: unknown): Uint8Array =>
  ethers.getBytes(ethers.encodeRlp(canonicalRlpNode(value)));

const stateLeaf = (path: string, value: unknown): { hexKey: string; value: Uint8Array } => ({
  hexKey: ethers.keccak256(ethers.toUtf8Bytes(`xln.account.state.${path}`)),
  value: encodeRlpValue(value),
});

export const computeCanonicalMerkleRoot = (
  namespace: string,
  entries: ReadonlyArray<readonly [path: string, value: unknown]>,
): string => buildHexKeyedMerkle(entries.map(([path, value]) => ({
  hexKey: ethers.keccak256(ethers.toUtf8Bytes(`xln.${namespace}.${path}`)),
  value: encodeRlpValue(value),
}))).root;

const accountStateRootEntries = (
  account: AccountMachine,
): ReadonlyArray<readonly [path: string, value: unknown]> => {
  const domain = normalizeAccountStateDomain(account.domain);
  return [
    ['identity', {
    chainId: domain.chainId,
    depositoryAddress: domain.depositoryAddress.toLowerCase(),
    leftEntity: account.leftEntity.toLowerCase(),
    rightEntity: account.rightEntity.toLowerCase(),
    watchSeed: account.watchSeed.toLowerCase(),
    }],
    ['financial', {
    deltas: account.deltas,
    globalCreditLimits: account.globalCreditLimits,
    jNonce: account.jNonce,
    disputeConfig: account.disputeConfig,
    }],
    ['commitments', {
    locks: account.locks,
    pulls: account.pulls,
    swapOffers: account.swapOffers,
    subcontracts: account.subcontracts,
    lendingIntents: account.lendingIntents ?? new Map(),
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
    ethers.keccak256(encodeRlpValue(value)),
  ]),
);

export const computeAccountStateRoot = (
  account: AccountMachine,
): string => {
  const entries = accountStateRootEntries(account);
  const root = buildHexKeyedMerkle(entries.map(([path, value]) => stateLeaf(path, value))).root;
  if (accountStateRootDebugRecorder) {
    accountStateRootDebugRecorder({
      accountId: `${account.leftEntity.toLowerCase()}:${account.rightEntity.toLowerCase()}`,
      root,
      entries: structuredClone(entries),
    });
  }
  return root;
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
  pendingForward: account.pendingForward,
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
