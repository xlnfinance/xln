import type { EntityReplica } from '../../entity/types';
import type { RuntimeReplica, RoutedEntityInput, RuntimeInput, RuntimeTx } from '../types';
import { entityInputMergeKey } from '../../entity/consensus/input/merge';
import { safeStringify } from '../../protocol/serialization';
import { atomicCrossJInputCohortKey } from '../delivery/topology/entity-routing';

const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const findExactReplica = (
  env: RuntimeReplica,
  entityId: string,
  signerId: string,
): EntityReplica | undefined => [...env.state.eReplicas.values()].find(replica =>
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

/**
 * Certificate-bearing inputs (proposals, precommits) name an exact height and
 * stay one-per-lane per Runtime frame: H and H+1 certificates in one WAL frame
 * would make certified lineage unreplayable. Plain inputs (txs, attestations,
 * wakes) advance a replica from local work; their commits are recorded per
 * height in the WAL (`entityContextCommitKey`), so a lane may apply several of
 * them sequentially inside one Runtime frame.
 */
const carriesHeightCertificate = (input: RoutedEntityInput): boolean =>
  Boolean(input.proposedFrame) || (input.hashPrecommits?.size ?? 0) > 0;

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
  // Any remaining input can advance a single-signer Entity from replica-local
  // work. In particular, J-prefix/leader inputs can finish consensus work that
  // was already pending before this Runtime frame. Treating those envelopes as
  // non-committing allowed a following local command to commit H+2 under the
  // same Runtime-frame context key.
  if ((input.entityTxs?.length ?? 0) > 0) return currentHeight + 1;
  return currentHeight + 1;
};

const importingReplicaLanes = (runtimeTxs: readonly RuntimeTx[]): Set<string> => {
  const lanes = new Set<string>();
  for (const tx of runtimeTxs) {
    if (tx.type !== 'importReplica') continue;
    const key = `${normalize(tx.entityId)}:${normalize(tx.signerId)}`;
    if (key !== ':') lanes.add(key);
  }
  return lanes;
};

const resolveLaneHeight = (
  env: RuntimeReplica,
  key: string,
  importingLanes: ReadonlySet<string>,
): number | null => {
  const [entityId, signerId] = key.split(':');
  if (!entityId || !signerId) return null;
  const replica = findExactReplica(env, entityId, signerId);
  if (replica) return replica.state.height;
  return importingLanes.has(key) ? 0 : null;
};

/**
 * One R-frame may make at most one new certified Entity height durable per
 * entity+signer lane. Different lanes remain independent. Higher certificates
 * stay in the runtime mempool and are applied only after H is durably saved.
 */
export const applyEntityHeightDurabilityBarrier = (
  env: RuntimeReplica,
  runtimeInput: RuntimeInput,
  mempool: RuntimeInput,
  queuedAt: number,
): number => {
  const importingLanes = importingReplicaLanes(runtimeInput.runtimeTxs);
  const laneState = new Map<string, { currentHeight: number; firstFutureHeight: number }>();

  for (const input of runtimeInput.entityInputs) {
    const key = laneKey(input);
    if (!key) continue;
    const currentHeight = resolveLaneHeight(env, key, importingLanes);
    if (currentHeight === null) continue;
    const candidateHeight = possibleCommittedHeight(input, currentHeight);
    if (candidateHeight === null || candidateHeight <= currentHeight) continue;
    const prior = laneState.get(key);
    if (!prior || candidateHeight < prior.firstFutureHeight) {
      laneState.set(key, { currentHeight, firstFutureHeight: candidateHeight });
    }
  }

  if (laneState.size === 0) return 0;
  const certificateLanes = new Set<string>();
  for (const input of runtimeInput.entityInputs) {
    const key = laneKey(input);
    if (key && carriesHeightCertificate(input)) certificateLanes.add(key);
  }
  // Walk in arrival order. On lanes that carry a height certificate keep the
  // first H+1 merge group so same-`from` txs can still collapse, then defer the
  // tail; a later same-key tx after a distinct loopback must not jump ahead of
  // that deferred work. Plain-input lanes only defer future heights.
  const acceptedMergeKeyByLane = new Map<string, string>();
  const acceptedScheduledWakeByLane = new Map<string, string>();
  const closedLanes = new Set<string>();
  const commitBlocked = (input: RoutedEntityInput): boolean => {
    const key = laneKey(input);
    const state = key ? laneState.get(key) : undefined;
    if (!key || !state) return false;
    if (closedLanes.has(key)) return true;
    const candidateHeight = possibleCommittedHeight(input, state.currentHeight);
    if (candidateHeight === null || candidateHeight <= state.currentHeight) return false;
    if (candidateHeight > state.firstFutureHeight) return true;
    const mergeKey = entityInputMergeKey(input);
    const scheduledWake = input.entityTxs?.find(tx => tx.type === 'scheduledWake');
    const scheduledWakeKey = scheduledWake ? safeStringify(scheduledWake) : null;
    const accepted = acceptedMergeKeyByLane.get(key);
    if (!accepted) {
      acceptedMergeKeyByLane.set(key, mergeKey);
      if (scheduledWakeKey) acceptedScheduledWakeByLane.set(key, scheduledWakeKey);
      return false;
    }
    if (mergeKey !== accepted && !certificateLanes.has(key)) {
      // A distinct origin on a plain lane commits its own following height;
      // it does not merge with the accepted group, so no wake conflict arises.
      return false;
    }
    if (mergeKey === accepted) {
      const acceptedWake = acceptedScheduledWakeByLane.get(key);
      if (scheduledWakeKey && acceptedWake && scheduledWakeKey !== acceptedWake) {
        // Scheduler payloads are state-derived snapshots. Merging two distinct
        // snapshots would create an invalid Entity frame with two wake txs.
        // Preserve the first frame and retry the later snapshot after its
        // predecessor is durable; ordinary same-origin commands may still
        // merge beside the unique wake, which is ordered first by Entity.
        closedLanes.add(key);
        return true;
      }
      if (scheduledWakeKey && !acceptedWake) {
        acceptedScheduledWakeByLane.set(key, scheduledWakeKey);
      }
      return false;
    }
    closedLanes.add(key);
    return true;
  };
  const heightBlocked = runtimeInput.entityInputs.map(input => commitBlocked(input));
  const blockedAtomicCohorts = new Set<string>();
  runtimeInput.entityInputs.forEach((input, index) => {
    if (!heightBlocked[index]) return;
    const cohortKey = atomicCrossJInputCohortKey(input);
    if (cohortKey) blockedAtomicCohorts.add(cohortKey);
  });

  const selected: RoutedEntityInput[] = [];
  const deferred: RoutedEntityInput[] = [];
  runtimeInput.entityInputs.forEach((input, index) => {
    const cohortKey = atomicCrossJInputCohortKey(input);
    if (heightBlocked[index] || (cohortKey !== null && blockedAtomicCohorts.has(cohortKey))) {
      deferred.push(input);
    } else {
      selected.push(input);
    }
  });

  if (deferred.length === 0) return 0;
  runtimeInput.entityInputs = selected;
  mempool.entityInputs = [...deferred, ...mempool.entityInputs];
  mempool.queuedAt = mempool.queuedAt ?? queuedAt;
  return deferred.length;
};
