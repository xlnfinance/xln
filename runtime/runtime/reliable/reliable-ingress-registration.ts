import { normalizeRuntimeId } from '../../network/p2p/auth/runtime-id.ts';
import type {
  RuntimeReplica,
  ReliableDeliveryIdentity,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
} from '../types.ts';
import {
  assertTerminalReceiptCoversInput,
  canReissueTerminalAccountFrameAck,
  isReliableIdentityTerminalInPostState,
} from './reliable-authority.ts';
import {
  assertReliableLaneCompatible,
  compareReliableIdentityPosition,
  receiverFrontierKey,
  reliableActiveIsStaleBelowTerminal,
  reliableIdentityExactKey,
  reliableReceiptCoversIdentity,
} from './reliable-frontier.ts';
import {
  assertReceiverSourceLaneCapacity,
  ensureReliableIngressState,
} from './reliable-ingress-state.ts';
import {
  createReliableDeliveryReceipt,
  getInputReliableIdentity,
} from './reliable-receipt.ts';

export type ReliableIngressRegistration =
  | { kind: 'ordinary' }
  | { kind: 'enqueue' }
  | { kind: 'pending' }
  | { kind: 'receipt'; receipt: ReliableDeliveryReceipt };

export type ReliableIngressRegistrationOptions = {
  /**
   * One authenticated cross-j envelope may carry Account ACK H+1 beside the
   * source leg while ACK H is already queued immediately ahead of it. Admit
   * that exact contiguous successor into the same Runtime batch; suppressing
   * it would split the money bundle and leave only the source proposal.
   */
  allowContiguousPendingAccountAck?: boolean;
};

const validateIngressRoute = (
  env: RuntimeReplica,
  fromRuntimeIdRaw: string,
  input: RoutedEntityInput,
): string => {
  const receiverRuntimeId = normalizeRuntimeId(env.runtimeId);
  if (!receiverRuntimeId || normalizeRuntimeId(input.runtimeId) !== receiverRuntimeId) {
    throw new Error('RELIABLE_INGRESS_TARGET_RUNTIME_MISMATCH');
  }
  const fromRuntimeId = normalizeRuntimeId(fromRuntimeIdRaw);
  if (!fromRuntimeId) throw new Error('RELIABLE_INGRESS_SENDER_RUNTIME_INVALID');
  return fromRuntimeId;
};

const pendingIdentitiesForLane = (
  env: RuntimeReplica,
  fromRuntimeId: string,
  identity: ReliableDeliveryIdentity,
): ReliableDeliveryIdentity[] => [...(env.infrastructure?.pendingReliableIngress?.values() ?? [])]
  .filter(entry => entry.targetRuntimeIds.has(fromRuntimeId))
  .map(entry => entry.identity)
  .filter(candidate => candidate.laneKey === identity.laneKey);

const assertSourceLaneCapacity = (
  env: RuntimeReplica,
  fromRuntimeId: string,
  identity: ReliableDeliveryIdentity,
): void => assertReceiverSourceLaneCapacity(
  ensureReliableIngressState(env),
  receiverFrontierKey(fromRuntimeId, identity),
);

const registerAgainstDurableFrontiers = (
  env: RuntimeReplica,
  fromRuntimeId: string,
  input: RoutedEntityInput,
  identity: ReliableDeliveryIdentity,
): ReliableIngressRegistration | null => {
  const key = receiverFrontierKey(fromRuntimeId, identity);
  const terminal = env.infrastructure?.reliableIngressTerminalWatermarks?.get(key);
  if (
    terminal &&
    identity.kind === 'account-ack' &&
    terminal.body.identity.kind === 'account-ack' &&
    compareReliableIdentityPosition(identity, terminal.body.identity) < 0
  ) {
    if (!isReliableIdentityTerminalInPostState(env, terminal.body.identity)) {
      throw new Error('RELIABLE_INGRESS_TERMINAL_ACCOUNT_STATE_CORRUPTION');
    }
    // Account ACK order is a per-relationship sequence. Once a higher ACK is
    // durably terminal, any lower retry is stale and cannot mutate Account
    // state. Return a fresh receipt over the exact retry identity so a sender
    // that lost an old receipt can compact its outbox after either side restarts.
    // Same-height/different-hash inputs still reach the conflict checks below.
    return { kind: 'receipt', receipt: createReliableDeliveryReceipt(env, identity, 'terminal') };
  }
  if (
    terminal &&
    (identity.kind === 'j-finality' || identity.kind === 'hash-precommit' ||
      identity.kind === 'j-prefix-attestation') &&
    identity.kind === terminal.body.identity.kind &&
    identity.height < terminal.body.identity.height
  ) {
    assertTerminalReceiptCoversInput(env, terminal.body.identity, identity, input);
    return { kind: 'receipt', receipt: createReliableDeliveryReceipt(env, identity, 'exact') };
  }
  if (terminal && reliableReceiptCoversIdentity(terminal, identity)) {
    assertTerminalReceiptCoversInput(env, terminal.body.identity, identity, input);
    return { kind: 'receipt', receipt: terminal };
  }
  if (
    terminal &&
    canReissueTerminalAccountFrameAck(env, terminal.body.identity, identity, input)
  ) {
    return { kind: 'receipt', receipt: createReliableDeliveryReceipt(env, identity, 'terminal') };
  }
  if (
    terminal &&
    identity.kind === 'leader-timeout-vote' &&
    identity.height === terminal.body.identity.height
  ) {
    // A terminal timeout-vote receipt is exact. It may retire only the vote
    // that actually advanced this lane; a different body, prepared lock or
    // signature for the same voter/round is equivocation, not another no-op.
    assertReliableLaneCompatible(
      terminal.body.identity,
      identity,
      'RELIABLE_INGRESS_LANE_ORDER_CONFLICT',
    );
    throw new Error(`RELIABLE_INGRESS_TERMINAL_EXACT_CONFLICT:${identity.height}`);
  }
  const active = env.infrastructure?.reliableIngressReceiptLedger?.get(key);
  // A later terminal on this lane leaves a lower exact active in place because
  // H+1 receipts do not cover H. That leftover must not HOL-block H+2..n.
  if (!active || reliableActiveIsStaleBelowTerminal(active.body.identity, terminal?.body.identity)) {
    if (terminal && compareReliableIdentityPosition(identity, terminal.body.identity) < 0) {
      throw new Error(`RELIABLE_INGRESS_TERMINAL_ORDER_CONFLICT:${identity.kind}:${identity.height}`);
    }
    return null;
  }
  const activePosition = compareReliableIdentityPosition(identity, active.body.identity);
  if (activePosition > 0) {
    // A durable exact Account ACK at H proves the receiver has persisted that
    // body. The counterparty's next ACK is the authenticated message that can
    // commit the pending H+1 Account frame, so blocking it until H becomes
    // terminal creates a circular HOL deadlock. Admit exactly the contiguous
    // successor; commitReliableIngress promotes H only after H+1 actually
    // advances the Account post-state in the enclosing durable Runtime frame.
    if (
      identity.kind === 'account-ack' &&
      identity.height === active.body.identity.height + 1
    ) return null;
    return { kind: 'pending' };
  }
  if (activePosition < 0) {
    throw new Error(
      `RELIABLE_INGRESS_OPEN_FRONTIER_ORDER_GAP:${identity.kind}:` +
      `${active.body.identity.height}:${identity.height}`,
    );
  }
  assertReliableLaneCompatible(
    active.body.identity,
    identity,
    'RELIABLE_INGRESS_LANE_ORDER_CONFLICT',
  );
  return reliableReceiptCoversIdentity(active, identity)
    ? { kind: 'receipt', receipt: active }
    : null;
};

const assertNoPendingOrderGap = (
  env: RuntimeReplica,
  fromRuntimeId: string,
  identity: ReliableDeliveryIdentity,
): boolean => {
  const pending = pendingIdentitiesForLane(env, fromRuntimeId, identity);
  for (const candidate of pending.filter(entry =>
    compareReliableIdentityPosition(entry, identity) === 0)) {
    assertReliableLaneCompatible(candidate, identity, 'RELIABLE_INGRESS_LANE_ORDER_CONFLICT');
  }
  const higher = pending.find(candidate => compareReliableIdentityPosition(candidate, identity) > 0);
  if (higher) {
    throw new Error(
      `RELIABLE_INGRESS_PENDING_ORDER_REGRESSION:${identity.kind}:` +
      `${identity.height}:${higher.height}`,
    );
  }
  return pending.length > 0;
};

const canEnqueueContiguousPendingAccountAck = (
  env: RuntimeReplica,
  fromRuntimeId: string,
  identity: ReliableDeliveryIdentity,
): boolean => {
  if (identity.kind !== 'account-ack') return false;
  const pending = pendingIdentitiesForLane(env, fromRuntimeId, identity);
  if (pending.length === 0 || pending.some(candidate => candidate.kind !== 'account-ack')) return false;
  const highestPendingHeight = Math.max(...pending.map(candidate => candidate.height));
  return highestPendingHeight + 1 === identity.height;
};

/** Register transport ingress without treating durable queueing as terminal coverage. */
export const registerReliableIngress = (
  env: RuntimeReplica,
  fromRuntimeIdRaw: string,
  input: RoutedEntityInput,
  options: ReliableIngressRegistrationOptions = {},
): ReliableIngressRegistration => {
  const identity = getInputReliableIdentity(input);
  if (!identity) return { kind: 'ordinary' };
  const fromRuntimeId = validateIngressRoute(env, fromRuntimeIdRaw, input);
  const state = ensureReliableIngressState(env);
  const key = reliableIdentityExactKey(identity);
  const pending = state.pendingReliableIngress!.get(key);
  // A receipt installed in the working state is not durable until the
  // enclosing WAL commits. The same source must keep waiting on that pending
  // owner instead of observing a premature receipt.
  if (pending?.targetRuntimeIds.has(fromRuntimeId)) return { kind: 'pending' };
  const durable = registerAgainstDurableFrontiers(env, fromRuntimeId, input, identity);
  const admitContiguousPendingAccountAck =
    options.allowContiguousPendingAccountAck === true &&
    canEnqueueContiguousPendingAccountAck(env, fromRuntimeId, identity);
  if (durable && !(durable.kind === 'pending' && admitContiguousPendingAccountAck)) return durable;
  if (pending) {
    assertSourceLaneCapacity(env, fromRuntimeId, identity);
    pending.targetRuntimeIds.add(fromRuntimeId);
    return { kind: 'pending' };
  }
  if (assertNoPendingOrderGap(env, fromRuntimeId, identity) && !admitContiguousPendingAccountAck) {
    return { kind: 'pending' };
  }
  assertSourceLaneCapacity(env, fromRuntimeId, identity);
  state.pendingReliableIngress!.set(key, {
    identity,
    targetRuntimeIds: new Set([fromRuntimeId]),
  });
  return { kind: 'enqueue' };
};
