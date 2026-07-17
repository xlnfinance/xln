import { normalizeRuntimeId } from '../networking/runtime-id';
import type {
  Env,
  ReliableDeliveryIdentity,
  ReliableDeliveryReceipt,
  RoutedEntityInput,
} from '../types';
import {
  assertTerminalReceiptCoversInput,
  canReissueTerminalAccountFrameAck,
  isReliableIdentityTerminalInPostState,
} from './reliable-authority';
import {
  assertReliableLaneCompatible,
  compareReliableIdentityPosition,
  receiverFrontierKey,
  reliableIdentityExactKey,
  reliableReceiptCoversIdentity,
} from './reliable-frontier';
import {
  assertReceiverSourceLaneCapacity,
  ensureReliableIngressState,
} from './reliable-ingress-state';
import {
  createReliableDeliveryReceipt,
  getInputReliableIdentity,
} from './reliable-receipt';

export type ReliableIngressRegistration =
  | { kind: 'ordinary' }
  | { kind: 'enqueue' }
  | { kind: 'pending' }
  | { kind: 'receipt'; receipt: ReliableDeliveryReceipt };

const validateIngressRoute = (
  env: Env,
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
  env: Env,
  fromRuntimeId: string,
  identity: ReliableDeliveryIdentity,
): ReliableDeliveryIdentity[] => [...(env.runtimeState?.pendingReliableIngress?.values() ?? [])]
  .filter(entry => entry.targetRuntimeIds.has(fromRuntimeId))
  .map(entry => entry.identity)
  .filter(candidate => candidate.laneKey === identity.laneKey);

const assertSourceLaneCapacity = (
  env: Env,
  fromRuntimeId: string,
  identity: ReliableDeliveryIdentity,
): void => assertReceiverSourceLaneCapacity(
  ensureReliableIngressState(env),
  receiverFrontierKey(fromRuntimeId, identity),
);

const registerAgainstDurableFrontiers = (
  env: Env,
  fromRuntimeId: string,
  input: RoutedEntityInput,
  identity: ReliableDeliveryIdentity,
): ReliableIngressRegistration | null => {
  const key = receiverFrontierKey(fromRuntimeId, identity);
  const terminal = env.runtimeState?.reliableIngressTerminalWatermarks?.get(key);
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
    identity.kind === 'j-finality' &&
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
  const active = env.runtimeState?.reliableIngressReceiptLedger?.get(key);
  if (!active) {
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
  env: Env,
  fromRuntimeId: string,
  identity: ReliableDeliveryIdentity,
): boolean => {
  const pending = pendingIdentitiesForLane(env, fromRuntimeId, identity);
  for (const candidate of pending.filter(entry =>
    compareReliableIdentityPosition(entry, identity) === 0)) {
    assertReliableLaneCompatible(candidate, identity, 'RELIABLE_INGRESS_LANE_ORDER_CONFLICT');
  }
  if (pending.some(candidate => compareReliableIdentityPosition(candidate, identity) > 0)) {
    throw new Error(`RELIABLE_INGRESS_PENDING_ORDER_REGRESSION:${identity.kind}:${identity.height}`);
  }
  return pending.length > 0;
};

/** Register transport ingress without treating durable queueing as terminal coverage. */
export const registerReliableIngress = (
  env: Env,
  fromRuntimeIdRaw: string,
  input: RoutedEntityInput,
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
  if (durable) return durable;
  if (pending) {
    assertSourceLaneCapacity(env, fromRuntimeId, identity);
    pending.targetRuntimeIds.add(fromRuntimeId);
    return { kind: 'pending' };
  }
  if (assertNoPendingOrderGap(env, fromRuntimeId, identity)) return { kind: 'pending' };
  assertSourceLaneCapacity(env, fromRuntimeId, identity);
  state.pendingReliableIngress!.set(key, {
    identity,
    targetRuntimeIds: new Set([fromRuntimeId]),
  });
  return { kind: 'enqueue' };
};
