import type { Env } from '../types';
import {
  assertReliableIngressSourceLaneBound,
  assertReliableIngressSourceLaneCapacity,
  receiverFrontierKey,
} from './reliable-frontier';
import { ensureReliableState } from './reliable-receipt';

const durableReceiverSourceLaneKeys = (
  state: NonNullable<Env['runtimeState']>,
): Set<string> => new Set([
  ...(state.reliableIngressReceiptLedger?.keys() ?? []),
  ...(state.reliableIngressTerminalWatermarks?.keys() ?? []),
]);

export const receiverSourceLaneKeys = (
  state: NonNullable<Env['runtimeState']>,
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
  state: NonNullable<Env['runtimeState']>,
  candidateKey: string,
): void => assertReliableIngressSourceLaneCapacity(receiverSourceLaneKeys(state), candidateKey);

export const ensureReliableIngressState = (
  env: Env,
): NonNullable<Env['runtimeState']> => {
  const state = ensureReliableState(env);
  state.reliableIngressReceiptLedger ??= new Map();
  state.reliableIngressTerminalWatermarks ??= new Map();
  state.pendingReliableIngress ??= new Map();
  state.reliableIngressCommitting ??= new Set();
  assertReliableIngressSourceLaneBound(durableReceiverSourceLaneKeys(state));
  return state;
};
