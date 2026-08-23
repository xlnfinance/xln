/**
 * TS account state -> rscore process wire builders for the shadow mirror.
 * Every shape here is pinned by tests/rscore/accounts-tree-parity.test.ts and
 * the process wire decoders (rscore/crates/process/src/wire_decode.rs).
 */
import type { AccountReplica, AccountTx, Delta, HtlcLock } from '../types/account';
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
 * Why an account snapshot cannot be mirrored, or null when it can. The Rust
 * payment profile commits swap/pull/subcontract/rebalance/J-claim sections at
 * their genesis values, so any account carrying live state there would seed to
 * a different root — refuse loudly instead of diverging silently.
 */
export const shadowIneligibilityReason = (account: AccountReplica): string | null => {
  const state = account.state;
  if (state.swapOffers.size > 0) return 'SWAP_OFFERS';
  if ((state.pulls?.size ?? 0) > 0) return 'PULLS';
  if ((state.subcontracts?.size ?? 0) > 0) return 'SUBCONTRACTS';
  if ((state.lendingIntents?.size ?? 0) > 0) return 'LENDING_INTENTS';
  if (state.settlementWorkspace !== undefined) return 'SETTLEMENT_WORKSPACE';
  if (state.leftPendingJClaims.count !== 0n) return 'LEFT_PENDING_J_CLAIMS';
  if (state.rightPendingJClaims.count !== 0n) return 'RIGHT_PENDING_J_CLAIMS';
  if (state.requestedRebalance.size > 0) return 'REQUESTED_REBALANCE';
  if (state.requestedRebalanceFeeState.size > 0) return 'REBALANCE_FEE_STATE';
  if ((state.rebalanceFeePolicies?.size ?? 0) > 0) return 'REBALANCE_FEE_POLICIES';
  return null;
};

/** Seed-wire row (arity 11) for one committed account snapshot. */
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
  ];
};

export const SHADOW_SUPPORTED_TX_TYPES = new Set(['direct_payment', 'htlc_lock', 'htlc_resolve']);

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
    case 'htlc_resolve':
      return tx.data.outcome === 'secret'
        ? [2, tx.data.lockId, 0, hexToWireBytes(tx.data.secret, 32, 'SHADOW_SECRET')]
        : [2, tx.data.lockId, 1, tx.data.reason ?? null];
    default:
      return null;
  }
};
