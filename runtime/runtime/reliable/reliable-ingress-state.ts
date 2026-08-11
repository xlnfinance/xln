import type { RuntimeReplica } from '../types.ts';
import {
  assertReliableIngressSourceLaneBound,
  assertReliableIngressSourceLaneCapacity,
  receiverFrontierKey,
} from './reliable-frontier.ts';
import { ensureReliableState } from './reliable-receipt.ts';

const durableReceiverSourceLaneKeys = (
  state: NonNullable<RuntimeReplica['infrastructure']>,
): Set<string> => new Set([
  ...(state.reliableIngressReceiptLedger?.keys() ?? []),
  ...(state.reliableIngressTerminalWatermarks?.keys() ?? []),
]);

export const receiverSourceLaneKeys = (
  state: NonNullable<RuntimeReplica['infrastructure']>,
): Set<string> => {
  const keys = durableReceiverSourceLaneKeys(state);
  for (const pending of state.pendingReliableIngress?.values() ?? []) {
    for (const sourceRuntimeId of pending.targetRuntimeIds) {
      keys.add(receiverFrontierKey(sourceRuntimeId, pending.identity));
    }
  }
  return keys;
};

export const assertReceiverSourceLaneCapacity = (
  state: NonNullable<RuntimeReplica['infrastructure']>,
  candidateKey: string,
  knownKeys = receiverSourceLaneKeys(state),
): void => {
  assertReliableIngressSourceLaneCapacity(knownKeys, candidateKey);
  knownKeys.add(candidateKey);
};

export const ensureReliableIngressState = (
  env: RuntimeReplica,
): NonNullable<RuntimeReplica['infrastructure']> => {
  const state = ensureReliableState(env);
  state.reliableIngressReceiptLedger ??= new Map();
  state.reliableIngressTerminalWatermarks ??= new Map();
  state.pendingReliableIngress ??= new Map();
  state.reliableIngressCommitting ??= new Set();
  assertReliableIngressSourceLaneBound(durableReceiverSourceLaneKeys(state));
  return state;
};
