import { normalizeRuntimeId } from '../networking/runtime-id';
import type { RoutedEntityInput } from '../types';
import { reliableIdentityExactKey } from './reliable-frontier';
import { getInputReliableIdentity } from './reliable-receipt';
import { splitRoutedOutputByDeliveryLane } from './output-routing';

const reliableKeys = (input: RoutedEntityInput): string[] =>
  splitRoutedOutputByDeliveryLane(input).flatMap((lane) => {
    const identity = getInputReliableIdentity(lane);
    return identity ? [reliableIdentityExactKey(identity)] : [];
  });

/**
 * Adds receipt-only inputs to the canonical applied batch without rescanning
 * every prior input for every receipt. The first input owning an identity
 * remains authoritative, matching the former Array.findIndex semantics.
 */
export const mergeDurableReceiptOnlyInputs = (
  appliedInputs: readonly RoutedEntityInput[],
  receiptOnlyInputs: readonly RoutedEntityInput[],
): RoutedEntityInput[] => {
  const persisted = [...appliedInputs];
  const firstIndexByReliableKey = new Map<string, number>();
  persisted.forEach((input, index) => {
    for (const key of reliableKeys(input)) {
      if (!firstIndexByReliableKey.has(key)) firstIndexByReliableKey.set(key, index);
    }
  });

  for (const input of receiptOnlyInputs) {
    const sourceRuntimeId = normalizeRuntimeId(input.from);
    if (!sourceRuntimeId) throw new Error('RUNTIME_RELIABLE_DURABLE_INPUT_SOURCE_MISSING');
    const inputIdentity = getInputReliableIdentity(input);
    const inputKey = inputIdentity ? reliableIdentityExactKey(inputIdentity) : null;
    const matchingIndex = inputKey === null
      ? undefined
      : firstIndexByReliableKey.get(inputKey);
    if (matchingIndex === undefined) {
      const nextIndex = persisted.length;
      const persistedInput = { ...input, from: sourceRuntimeId };
      persisted.push(persistedInput);
      for (const key of reliableKeys(persistedInput)) {
        if (!firstIndexByReliableKey.has(key)) firstIndexByReliableKey.set(key, nextIndex);
      }
      continue;
    }

    const existing = persisted[matchingIndex]!;
    if (!existing.from) {
      persisted[matchingIndex] = { ...existing, from: sourceRuntimeId };
      continue;
    }
    const existingSourceRuntimeId = normalizeRuntimeId(existing.from);
    if (existingSourceRuntimeId !== sourceRuntimeId) {
      throw new Error(
        `RUNTIME_RELIABLE_APPLIED_INPUT_SOURCE_CONFLICT:` +
        `${existingSourceRuntimeId}:${sourceRuntimeId}`,
      );
    }
  }
  return persisted;
};
