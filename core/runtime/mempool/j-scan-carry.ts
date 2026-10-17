/**
 * Header-only authenticated J scan progress carried in the live envelope.
 *
 * An empty authenticated page proves only that nothing relevant happened on
 * chain. Committing it as its own Runtime frame turned chain liveness into one
 * WAL frame per block per chain while a wallet sat idle (19 frames / 8 s on the
 * two-chain stand). The watcher commits such a page alone only once per
 * `BLOCKCHAIN.JBLOCK_LIVENESS_INTERVAL` blocks; until then the newest page per
 * Entity replica waits here and rides the next Runtime frame that carries an
 * Entity input for that replica. Runtime txs apply before Entity inputs, so a
 * payment admitted in that frame still derives its deadline from the
 * authenticated tip rather than from a scan up to one interval old (a 50-block
 * instant lock would otherwise expire against the peer's head).
 *
 * Authority: only the local watcher stores here, and it stores the exact
 * `observeJRange` object it marked as local J authority. Old/new: the watcher
 * joins each newly authenticated page with the carried headers. Watchers use
 * this contiguous live evidence for reads and canonical reorg audits; the next
 * admitted observation includes the complete suffix and supersedes the carry.
 * Counterexample: a page read before a reorg rewind would
 * re-record the abandoned branch after the rewind, so the rewind drops it.
 * Crash: nothing here is durable; recovery rescans from persisted jHistory and
 * recordValidatorJHistory accepts identical overlapping headers.
 */
import { LIMITS } from '../../config/constants';
import type { EntityReplica } from '../../entity/types';
import { recordValidatorJHistory } from '../../jurisdiction/machine/local-history';
import { ensureRuntimeInfrastructure } from '../envelope/replica-envelope';
import type { RuntimeInput, RuntimeReplica, RuntimeTx } from '../types';

/** Read-only live view; never replaces the replica's WAL-backed history. */
export const getJScanHistory = (env: RuntimeReplica, replicaKey: string, replica: EntityReplica) => {
  const carried = env.infrastructure?.carriedJScanTips?.get(replicaKey);
  if (!carried || carried.data.scannedThroughHeight <= replica.state.lastFinalizedJHeight) return replica.jHistory;
  return recordValidatorJHistory(replica.jHistory, carried.data, replica.state);
};

type ObserveJRangeTx = Extract<RuntimeTx, { type: 'observeJRange' }>;

const addressKey = (entityId: string, signerId: string): string =>
  `${entityId.trim().toLowerCase()}:${signerId.trim().toLowerCase()}`;

export const carryJScanTip = (env: RuntimeReplica, replicaKey: string, tx: ObserveJRangeTx): void => {
  const infrastructure = ensureRuntimeInfrastructure(env);
  const carried = infrastructure.carriedJScanTips ?? new Map<string, ObserveJRangeTx>();
  carried.delete(replicaKey);
  carried.set(replicaKey, tx);
  infrastructure.carriedJScanTips = carried;
};

export const dropCarriedJScanTips = (env: RuntimeReplica, replicaKeys: Iterable<string>): void => {
  const carried = env.infrastructure?.carriedJScanTips;
  if (!carried) return;
  for (const replicaKey of replicaKeys) carried.delete(replicaKey);
};

/**
 * Move the carried page of every replica addressed by this frame's Entity
 * inputs in front of them. Never creates or wakes a frame (a checkpoint
 * barrier has no Entity input), and never exceeds the input runtimeTx limit.
 * False means the caller must defer Entity work, preserving the carry. These
 * observations already passed watcher ingress before a quiesce fence, so they
 * must accompany accepted Entity work while that work drains.
 */
export const attachCarriedJScanTips = (env: RuntimeReplica, input: RuntimeInput): boolean => {
  const infrastructure = ensureRuntimeInfrastructure(env);
  const carried = infrastructure.carriedJScanTips;
  if (!carried || carried.size === 0 || input.entityInputs.length === 0) return true;
  const addressed = new Set(
    input.entityInputs.map(entityInput => addressKey(entityInput.entityId, entityInput.signerId)),
  );
  const attached = [...carried].filter(([, tx]) => addressed.has(addressKey(tx.data.entityId, tx.data.signerId)));
  if (attached.length === 0) return true;
  if (input.runtimeTxs.length + attached.length > LIMITS.MAX_RUNTIME_INPUT_RUNTIME_TXS) return false;
  input.runtimeTxs.unshift(...attached.map(([, tx]) => tx));
  for (const [replicaKey] of attached) carried.delete(replicaKey);
  return true;
};
