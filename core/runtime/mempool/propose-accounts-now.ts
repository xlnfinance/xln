/**
 * Runtime-side creation of the `proposeAccountsNow` recovery marker.
 *
 * Outbox delivery is best effort: nothing is ever resent silently and no
 * retention layer exists. A peer that was offline when this Runtime dispatched
 * an Account proposal therefore leaves the Account holding `pendingFrame` plus
 * the exact `pendingAccountInput` it signed. Recovery is explicit and
 * consensus-visible: on the offline -> online edge for that peer runtime, the
 * local proposer replica enqueues one marker per Entity, and Entity consensus
 * re-emits the retained bytes unchanged. Nothing here is durable state.
 */
import type { EntityInput } from '../../entity/types';
import type { EntityTx } from '../../types/entity-tx';
import type { RuntimeReplica } from '../types';
import {
  MAX_PROPOSE_ACCOUNTS_NOW_COUNTERPARTIES,
  type ProposeAccountsNowTx,
} from '../../entity/consensus/account/propose-accounts-now-validation';
import { isEntityActiveLeader } from '../../entity/consensus/leader';
import { compareStableText } from '../../protocol/serialization';
import { createStructuredLogger, shortId } from '../../support/logger';
import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope';
import { enqueueRuntimeInputsWithDeps, requestRuntimeLoopWake } from './input-queue';

const LOCAL_PROPOSE_ACCOUNTS_NOW = Symbol.for('xln.runtime.propose-accounts-now.local');

const proposeAccountsNowLog = createStructuredLogger('runtime.propose_accounts_now');

const replicaKey = (entityId: string, signerId: string): string =>
  `${entityId.toLowerCase()}:${signerId.toLowerCase()}`;

/** Entity ids this Runtime believes are hosted by one peer Runtime. */
const entityIdsOnPeerRuntime = (
  env: RuntimeReplica,
  peerRuntimeId: string,
): ReadonlySet<string> => {
  const target = peerRuntimeId.trim().toLowerCase();
  const hosted = new Set<string>();
  if (!target) return hosted;
  for (const [entityId, route] of env.infrastructure?.verifiedProfileRoutes ?? []) {
    if (route.runtimeId.trim().toLowerCase() === target) hosted.add(entityId.trim().toLowerCase());
  }
  return hosted;
};

/**
 * Counterparties already named by a queued marker, per replica. Deduping by
 * replica alone dropped a second peer that came online in the same frame:
 * its retained proposals were never re-sent.
 */
const alreadyQueuedCounterparties = (env: RuntimeReplica): Map<string, Set<string>> => {
  const queued = new Map<string, Set<string>>();
  const note = (entityId: string, signerId: string, tx: EntityTx): void => {
    if (tx.type !== 'proposeAccountsNow') return;
    const key = replicaKey(entityId, signerId);
    const covered = queued.get(key) ?? new Set<string>();
    for (const counterparty of tx.data.counterparties) covered.add(counterparty.trim().toLowerCase());
    queued.set(key, covered);
  };
  for (const input of env.runtimeMempool?.entityInputs ?? []) {
    for (const tx of input.entityTxs ?? []) note(input.entityId, input.signerId, tx);
  }
  for (const replica of env.state.eReplicas.values()) {
    for (const tx of replica.mempool) note(replica.entityId, replica.signerId, tx);
  }
  return queued;
};

/**
 * One marker per local proposer replica that owes this peer a retained Account
 * proposal. The counterparty list is the canonical ascending prefix so every
 * validator recomputes the same bytes from the same committed state.
 */
export const createProposeAccountsNowInputs = (
  env: RuntimeReplica,
  peerRuntimeId: string,
): EntityInput[] => {
  const peerEntityIds = entityIdsOnPeerRuntime(env, peerRuntimeId);
  if (peerEntityIds.size === 0) return [];
  const queued = alreadyQueuedCounterparties(env);
  const inputs: EntityInput[] = [];
  for (const replica of env.state.eReplicas.values()) {
    const key = replicaKey(replica.entityId, replica.signerId);
    if (!isEntityActiveLeader(replica)) continue;
    const covered = queued.get(key);
    const counterparties = [...replica.state.accounts]
      .filter(([accountId, account]) =>
        peerEntityIds.has(accountId.trim().toLowerCase()) &&
        !covered?.has(accountId.trim().toLowerCase()) &&
        account.pendingAccountInput !== undefined)
      .map(([accountId]) => accountId.trim().toLowerCase())
      .sort(compareStableText)
      .slice(0, MAX_PROPOSE_ACCOUNTS_NOW_COUNTERPARTIES);
    if (counterparties.length === 0) continue;
    const tx: ProposeAccountsNowTx = {
      type: 'proposeAccountsNow',
      data: {
        version: 1,
        proposerSignerId: replica.signerId,
        counterparties,
      },
    };
    Object.defineProperty(tx, LOCAL_PROPOSE_ACCOUNTS_NOW, { value: true, enumerable: false });
    inputs.push({ entityId: replica.entityId, signerId: replica.signerId, entityTxs: [tx] });
  }
  return inputs;
};

/**
 * Transport readiness callback. A peer coming online can never take this
 * Runtime down, so an unusable local queue is a skip, not a throw.
 */
export const enqueuePeerReadyProposeAccountsNow = (
  env: RuntimeReplica,
  peerRuntimeId: string,
  ready: boolean,
): void => {
  if (!ready) return;
  if (!env.runtimeMempool) return;
  const state = env.infrastructure;
  if (state?.halted === true || state?.persistenceQuiescing === true) return;
  const inputs = createProposeAccountsNowInputs(env, peerRuntimeId);
  if (inputs.length === 0) return;
  proposeAccountsNowLog.info('peer_ready.enqueued', {
    peerRuntime: shortId(peerRuntimeId, 8),
    entities: inputs.map(input => shortId(input.entityId)),
    counterparties: inputs.reduce(
      (total, input) => total + ((input.entityTxs?.[0] as ProposeAccountsNowTx | undefined)?.data.counterparties.length ?? 0),
      0,
    ),
  });
  enqueueRuntimeInputsWithDeps(
    env,
    { ensureRuntimeInfrastructure, requestRuntimeLoopWake },
    inputs,
    undefined,
    undefined,
    env.state.timestamp ?? 0,
    // Derived from committed state, never peer ingress: a full mempool must
    // not throw out of the transport callback.
    { localContinuation: true },
  );
};

/**
 * The marker is authored only by this Runtime for its own proposer replica.
 * External ingress carrying it is a forged local authority and is rejected.
 * Replay reads it from the committed WAL, where the local marker is gone.
 */
export const assertProposeAccountsNowTxAuthorized = (tx: EntityTx, replay: boolean): void => {
  if (
    tx.type !== 'proposeAccountsNow' ||
    replay ||
    (tx as EntityTx & { [LOCAL_PROPOSE_ACCOUNTS_NOW]?: boolean })[LOCAL_PROPOSE_ACCOUNTS_NOW] === true
  ) return;
  throw new Error('PROPOSE_ACCOUNTS_NOW_EXTERNAL_INGRESS_REJECTED');
};
