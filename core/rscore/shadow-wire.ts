/**
 * TS account state -> rscore process wire builders for the shadow mirror.
 * Every shape here is pinned by tests/rscore/accounts-tree-parity.test.ts and
 * the process wire decoders (rscore/crates/process/src/wire_decode.rs).
 */
import { EMPTY_ACCOUNT_STATE_ROOT } from '../account/commitment/state-root';
import { requirePersistentAccountStateMap } from '../account/state/persistent-state-map';
import type { AccountReplica, AccountState, AccountTx, Delta, HtlcLock } from '../types/account';
import type {
  BilateralRebalanceFeePolicy,
  RebalanceFeePolicySnapshot,
} from '../types/finance/rebalance';
import type { AccountStateCollection, AccountStateMapNamespace } from '../account/state/persistent-state-map';
import type { RscoreWireValue } from './client';

export const hexToWireBytes = (value: string, expectedBytes: number, code: string): Uint8Array => {
  const clean = value.trim().toLowerCase().replace(/^0x/, '');
  if (clean.length !== expectedBytes * 2 || !/^[0-9a-f]*$/.test(clean)) {
    throw new Error(`${code}:${value}`);
  }
  const bytes = new Uint8Array(expectedBytes);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const deltaWire = (delta: Delta): RscoreWireValue[] => [
  delta.tokenId,
  delta.collateral.toString(),
  delta.ondelta.toString(),
  delta.offdelta.toString(),
  delta.leftCreditLimit.toString(),
  delta.rightCreditLimit.toString(),
  delta.leftAllowance.toString(),
  delta.rightAllowance.toString(),
  delta.leftHold.toString(),
  delta.rightHold.toString(),
];

const lockWire = (lock: HtlcLock): RscoreWireValue[] => [
  lock.lockId,
  hexToWireBytes(lock.hashlock, 32, 'SHADOW_HASHLOCK'),
  lock.timelock.toString(),
  lock.revealBeforeHeight,
  lock.amount.toString(),
  lock.tokenId,
  lock.senderIsLeft ? 0 : 1, // Side wire: 0 = left, 1 = right
  lock.createdHeight,
  lock.createdTimestamp,
  lock.envelopeHash === undefined ? null : hexToWireBytes(lock.envelopeHash, 32, 'SHADOW_ENVELOPE_HASH'),
];

/**
 * Why an account snapshot cannot be mirrored, or null when it can.
 *
 * Most out-of-profile sections are *carried*: the engine commits their roots
 * verbatim and no supported transaction mutates them, so a live account with
 * swap/pull/rebalance/J-claim state still reproduces its exact state root.
 * Two cannot be carried and are refused loudly:
 *   - lendingIntents: the engine owns this map itself (it computes the root
 *     from its own entries), so a non-empty one would need the entries.
 *   - settlementWorkspace: TypeScript commits the whole object, not a root,
 *     and the engine has no representation for it.
 */
export const shadowIneligibilityReason = (account: AccountReplica): string | null => {
  const state = account.state;
  if ((state.lendingIntents?.size ?? 0) > 0) return 'LENDING_INTENTS';
  if (state.settlementWorkspace !== undefined) return 'SETTLEMENT_WORKSPACE';
  return null;
};

const collectionRoot = (
  namespace: AccountStateMapNamespace,
  map: AccountStateCollection<never, never> | undefined,
): string => (map === undefined
  ? EMPTY_ACCOUNT_STATE_ROOT
  : requirePersistentAccountStateMap(map, namespace).rootHash());

/** Roots of the sections the engine carries without interpreting them. */
const carriedSectionsWire = (account: AccountReplica): RscoreWireValue[] => {
  const state = account.state;
  const claim = (accumulator: { root: string; count: bigint }): RscoreWireValue[] => [
    hexToWireBytes(accumulator.root, 32, 'SHADOW_J_CLAIM_ROOT'),
    Number(accumulator.count),
  ];
  const root = (
    namespace: AccountStateMapNamespace,
    map: unknown,
  ): Uint8Array => hexToWireBytes(
    collectionRoot(namespace, map as AccountStateCollection<never, never> | undefined),
    32,
    `SHADOW_${namespace.toUpperCase()}_ROOT`,
  );
  return [
    root('pulls', state.pulls),
    root('swapOffers', state.swapOffers),
    root('subcontracts', state.subcontracts),
    root('requestedRebalance', state.requestedRebalance),
    root('requestedRebalanceFeeState', state.requestedRebalanceFeeState),
    rebalanceFeePoliciesWire(state.rebalanceFeePolicies),
    claim(state.leftPendingJClaims),
    claim(state.rightPendingJClaims),
  ];
};

/**
 * Slot 5 of the carried tuple is not a carried root: the engine owns the
 * rebalance fee registers and recomputes their root, so the seed ships their
 * full contents. An absent side is an empty tuple.
 */
const policySnapshotWire = (
  snapshot: RebalanceFeePolicySnapshot | undefined,
): RscoreWireValue[] => (snapshot === undefined ? [] : [
  snapshot.policyVersion,
  snapshot.baseFee.toString(),
  snapshot.liquidityFeeBps.toString(),
  snapshot.gasFee.toString(),
  snapshot.updatedAt,
]);

const rebalanceFeePoliciesWire = (
  policies: AccountState['rebalanceFeePolicies'],
): RscoreWireValue[] => [...(policies ?? new Map<number, BilateralRebalanceFeePolicy>()).entries()]
  .sort(([left], [right]) => left - right)
  .map(([tokenId, policy]) => [
    tokenId,
    policySnapshotWire(policy.left),
    policySnapshotWire(policy.right),
  ]);

/** Seed-wire row (arity 12) for one committed account snapshot. */
export const accountSeedWire = (
  ownerEntityId: string,
  counterpartyEntityId: string,
  account: AccountReplica,
): RscoreWireValue[] => {
  const state = account.state;
  return [
    hexToWireBytes(counterpartyEntityId, 32, 'SHADOW_ACCOUNT_ID'),
    hexToWireBytes(ownerEntityId, 32, 'SHADOW_OWNER'),
    hexToWireBytes(state.leftEntity, 32, 'SHADOW_LEFT'),
    hexToWireBytes(state.rightEntity, 32, 'SHADOW_RIGHT'),
    state.domain.chainId,
    hexToWireBytes(state.domain.depositoryAddress, 20, 'SHADOW_DEPOSITORY'),
    hexToWireBytes(state.watchSeed, 32, 'SHADOW_WATCH_SEED'),
    [state.disputeConfig.leftResponseSeconds, state.disputeConfig.rightResponseSeconds],
    [...state.deltas.values()]
      .sort((left, right) => left.tokenId - right.tokenId)
      .map(deltaWire),
    [...state.locks.values()]
      .sort((left, right) => (left.lockId < right.lockId ? -1 : left.lockId > right.lockId ? 1 : 0))
      .map(lockWire),
    [state.jNonce, state.lastFinalizedJHeight],
    carriedSectionsWire(account),
  ];
};

export const SHADOW_SUPPORTED_TX_TYPES = new Set([
  'direct_payment', 'htlc_lock', 'htlc_resolve', 'add_delta', 'set_credit_limit',
  'rebalance_policy',
]);

/** Process-wire tx tuple, or null when the tx type is outside the profile. */
export const accountTxWire = (tx: AccountTx): RscoreWireValue[] | null => {
  switch (tx.type) {
    case 'direct_payment':
      return [
        0,
        tx.data.tokenId,
        tx.data.amount.toString(),
        [...tx.data.route],
        tx.data.description ?? null,
        tx.data.fromEntityId,
        tx.data.toEntityId,
        tx.data.deliveryMode === 'direct' ? 0 : 1,
        tx.data.trustedGatewayEntityId ?? null,
      ];
    case 'htlc_lock':
      return [
        1,
        tx.data.lockId,
        hexToWireBytes(tx.data.hashlock, 32, 'SHADOW_HASHLOCK'),
        tx.data.timelock.toString(),
        tx.data.revealBeforeHeight,
        tx.data.amount.toString(),
        tx.data.tokenId,
        tx.data.deliveryMode === undefined ? null : tx.data.deliveryMode === 'instant' ? 0 : 1,
        tx.data.envelope ? Buffer.from(tx.data.envelope.ciphertext, 'base64') : null,
      ];
    case 'add_delta':
      return [3, tx.data.tokenId];
    case 'set_credit_limit':
      return [4, tx.data.tokenId, tx.data.amount.toString()];
    case 'rebalance_policy':
      return [
        5,
        tx.data.tokenId,
        tx.data.policyVersion,
        tx.data.baseFee.toString(),
        tx.data.liquidityFeeBps.toString(),
        tx.data.gasFee.toString(),
      ];
    case 'htlc_resolve':
      return tx.data.outcome === 'secret'
        ? [2, tx.data.lockId, 0, hexToWireBytes(tx.data.secret, 32, 'SHADOW_SECRET')]
        : [2, tx.data.lockId, 1, tx.data.reason ?? null];
    default:
      return null;
  }
};
