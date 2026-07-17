import type { EntityReplica, Env, RoutedEntityInput, RuntimeInput } from '../types';

const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const findExactReplica = (
  env: Env,
  entityId: string,
  signerId: string,
): EntityReplica | undefined => [...env.eReplicas.values()].find(replica =>
  normalize(replica.entityId || replica.state.entityId) === entityId &&
  normalize(replica.signerId) === signerId);

const laneKey = (input: RoutedEntityInput): string | null => {
  const entityId = normalize(input.entityId);
  const signerId = normalize(input.signerId);
  return entityId && signerId ? `${entityId}:${signerId}` : null;
};

const positiveHeight = (value: unknown): number | null => {
  const height = Number(value);
  return Number.isSafeInteger(height) && height > 0 ? height : null;
};

const possibleCommittedHeight = (
  input: RoutedEntityInput,
  currentHeight: number,
): number | null => {
  // Every proposal is conservatively a possible commit. Pre-cap code cannot
  // trust proposer-supplied Hanko bytes, while allowing H and H+1 proposals
  // through one WAL frame would make certified lineage unreplayable.
  if (input.proposedFrame) {
    return positiveHeight(input.proposedFrame?.height);
  }
  if (input.hashPrecommits?.size) {
    return positiveHeight(input.hashPrecommitFrame?.height);
  }
  // A single-signer Entity can commit ordinary txs (including scheduled wakes)
  // immediately. Treat that transition as H+1 so a bundled H+2 certificate is
  // retained for the next durable R-frame instead of crossing the WAL boundary.
  if ((input.entityTxs?.length ?? 0) > 0) return currentHeight + 1;
  return null;
};

/**
 * One R-frame may make at most one new certified Entity height durable per
 * entity+signer lane. Different lanes remain independent. Higher certificates
 * stay in the runtime mempool and are applied only after H is durably saved.
 */
export const applyEntityHeightDurabilityBarrier = (
  env: Env,
  runtimeInput: RuntimeInput,
  mempool: RuntimeInput,
  queuedAt: number,
): number => {
  const laneState = new Map<string, { currentHeight: number; firstFutureHeight: number }>();

  for (const input of runtimeInput.entityInputs) {
    const key = laneKey(input);
    if (!key) continue;
    const [entityId, signerId] = key.split(':');
    if (!entityId || !signerId) continue;
    const replica = findExactReplica(env, entityId, signerId);
    if (!replica) continue;
    const currentHeight = replica.state.height;
    const candidateHeight = possibleCommittedHeight(input, currentHeight);
    if (candidateHeight === null || candidateHeight <= currentHeight) continue;
    const prior = laneState.get(key);
    if (!prior || candidateHeight < prior.firstFutureHeight) {
      laneState.set(key, { currentHeight, firstFutureHeight: candidateHeight });
    }
  }

  if (laneState.size === 0) return 0;
  const selected: RoutedEntityInput[] = [];
  const deferred: RoutedEntityInput[] = [];
  for (const input of runtimeInput.entityInputs) {
    const key = laneKey(input);
    const state = key ? laneState.get(key) : undefined;
    if (!state) {
      selected.push(input);
      continue;
    }
    const candidateHeight = possibleCommittedHeight(input, state.currentHeight);
    if (candidateHeight !== null && candidateHeight > state.firstFutureHeight) {
      deferred.push(input);
    } else {
      selected.push(input);
    }
  }

  if (deferred.length === 0) return 0;
  runtimeInput.entityInputs = selected;
  mempool.entityInputs = [...deferred, ...mempool.entityInputs];
  mempool.queuedAt = mempool.queuedAt ?? queuedAt;
  return deferred.length;
};
