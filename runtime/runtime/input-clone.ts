import { cloneIsolatedEntityInput } from '../entity/input-clone';
import type { RoutedEntityInput, RuntimeInput, RuntimeTx } from '../types';

const cloneRuntimeTxValue = (value: unknown, active = new Set<object>()): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (active.has(value)) throw new Error('RUNTIME_INPUT_RUNTIME_TX_CYCLE');
  active.add(value);
  try {
    if (Array.isArray(value)) return value.map(entry => cloneRuntimeTxValue(entry, active));
    if (value instanceof Map) return new Map(Array.from(value, ([key, entry]) => [
      cloneRuntimeTxValue(key, active),
      cloneRuntimeTxValue(entry, active),
    ]));
    if (value instanceof Set) return new Set(Array.from(value, entry => cloneRuntimeTxValue(entry, active)));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return structuredClone(value);
    const cloned = Object.create(prototype) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) cloned[key] = cloneRuntimeTxValue(entry, active);
    return cloned;
  } finally {
    active.delete(value);
  }
};

const cloneIsolatedRuntimeTx = <T extends RuntimeTx>(tx: T): T =>
  cloneRuntimeTxValue(tx) as T;

export const cloneIsolatedRuntimeInput = (input: RuntimeInput): RuntimeInput => {
  if (!Array.isArray(input.runtimeTxs)) throw new Error('RUNTIME_INPUT_RUNTIME_TXS_INVALID');
  if (!Array.isArray(input.entityInputs)) throw new Error('RUNTIME_INPUT_ENTITY_INPUTS_INVALID');
  if (input.jInputs !== undefined && !Array.isArray(input.jInputs)) {
    throw new Error('RUNTIME_INPUT_J_INPUTS_INVALID');
  }
  if (input.reliableReceipts !== undefined && !Array.isArray(input.reliableReceipts)) {
    throw new Error('RUNTIME_INPUT_RELIABLE_RECEIPTS_INVALID');
  }
  const cloned: RuntimeInput = {
    // Bun 1.3 can corrupt a later occurrence of an aliased object even inside
    // one structuredClone call. RuntimeTx object identity has no semantics, so
    // clone every branch independently just as EntityInput fields are isolated.
    runtimeTxs: input.runtimeTxs.map(cloneIsolatedRuntimeTx),
    entityInputs: input.entityInputs.map(cloneIsolatedEntityInput),
    ...(input.jInputs !== undefined
      ? { jInputs: input.jInputs.map(jInput => structuredClone(jInput)) }
      : {}),
    ...(input.reliableReceipts !== undefined
      ? { reliableReceipts: input.reliableReceipts.map(receipt => structuredClone(receipt)) }
      : {}),
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
    ...(input.queuedAt !== undefined ? { queuedAt: input.queuedAt } : {}),
  };
  if (
    cloned.runtimeTxs.length !== input.runtimeTxs.length ||
    cloned.entityInputs.length !== input.entityInputs.length ||
    (cloned.jInputs?.length ?? 0) !== (input.jInputs?.length ?? 0) ||
    (cloned.reliableReceipts?.length ?? 0) !== (input.reliableReceipts?.length ?? 0)
  ) {
    throw new Error('RUNTIME_INPUT_CLONE_SHAPE_MISMATCH');
  }
  return cloned;
};

export const cloneIsolatedRoutedEntityInputs = (
  inputs: readonly RoutedEntityInput[],
): RoutedEntityInput[] => inputs.map(cloneIsolatedEntityInput);

const cloneReplicaCollection = (value: unknown, label: string): unknown => {
  if (value instanceof Map) {
    return new Map(Array.from(value.entries(), ([key, replica]) => [
      structuredClone(key),
      structuredClone(replica),
    ]));
  }
  if (!Array.isArray(value)) throw new Error(`RUNTIME_SNAPSHOT_${label}_INVALID`);
  return value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`RUNTIME_SNAPSHOT_${label}_ENTRY_INVALID:${index}`);
    }
    return [structuredClone(entry[0]), structuredClone(entry[1])];
  });
};

/** Clone known checkpoint components independently; alias identity is not durable state. */
export const cloneIsolatedRuntimeSnapshot = <T extends Record<string, unknown>>(snapshot: T): T => {
  const cloned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === 'runtimeInput') {
      if (!value || typeof value !== 'object') throw new Error('RUNTIME_SNAPSHOT_INPUT_INVALID');
      cloned[key] = cloneIsolatedRuntimeInput(value as RuntimeInput);
    } else if (key === 'eReplicas' || key === 'jReplicas') {
      cloned[key] = cloneReplicaCollection(value, key.toUpperCase());
    } else if (key === 'pendingOutputs' || key === 'networkInbox' || key === 'pendingNetworkOutputs') {
      if (!Array.isArray(value)) throw new Error(`RUNTIME_SNAPSHOT_${key.toUpperCase()}_INVALID`);
      cloned[key] = cloneIsolatedRoutedEntityInputs(value as RoutedEntityInput[]);
    } else {
      cloned[key] = structuredClone(value);
    }
  }
  return cloned as T;
};
