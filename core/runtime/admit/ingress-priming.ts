import type { RuntimeReplica } from '../types';
import type { EntityInput } from '../../entity/types';
import { cryptoPoolEnabled } from '../../protocol/crypto/crypto-pool';
import { primeInboundLayersAtIngress } from '../../entity/htlc/materialize-context';
import { primeProposalHankos } from '../../entity/consensus/proposal/prime-hankos';
import { requireEntityEncryptionPrivateKey } from '../../entity/auth/crypto';

/**
 * Start pool work (Hanko recovery, onion-layer decryption) for freshly queued
 * Entity inputs. The frame that consumes them then finds warm memos; without
 * a pool this is a no-op. Never throws: a missing local replica or key just
 * leaves the synchronous path to do the work.
 */
type PendingPrime = { txs: NonNullable<EntityInput['entityTxs']>; env: RuntimeReplica };
const pendingByEntity = new Map<string, PendingPrime>();
let flushScheduled = false;
const FLUSH_AT_ITEMS = 512;
let pendingItems = 0;

const flushPending = (): void => {
  flushScheduled = false;
  const batches = [...pendingByEntity];
  pendingByEntity.clear();
  pendingItems = 0;
  for (const [entityId, { txs, env }] of batches) {
    void primeProposalHankos(txs);
    const replica = Array.from(env.state.eReplicas.values()).find(
      candidate => candidate.entityId.toLowerCase() === entityId,
    );
    if (!replica) continue;
    try {
      primeInboundLayersAtIngress({
        state: replica.state,
        proposalTxs: txs,
        entityEncryptionPublicKey: replica.state.entityEncryptionPublicKey,
        entityEncryptionPrivateKey: requireEntityEncryptionPrivateKey(env, replica.entityId),
      });
    } catch {
      // No local encryption key for this Entity: nothing to prime.
    }
  }
};

/**
 * Inputs arrive one WebSocket message at a time; jobs are coalesced per
 * Entity and flushed on the next macrotask (or at FLUSH_AT_ITEMS) so the pool
 * sees a few large batches instead of thousands of one-item jobs.
 */
export const primeEntityInputsAtIngress = (env: RuntimeReplica, inputs: readonly EntityInput[]): void => {
  if (!cryptoPoolEnabled()) return;
  for (const input of inputs) {
    if (!Array.isArray(input.entityTxs) || input.entityTxs.length === 0) continue;
    const entityId = String(input.entityId || '').toLowerCase();
    const bucket = pendingByEntity.get(entityId);
    if (bucket) bucket.txs.push(...input.entityTxs);
    else pendingByEntity.set(entityId, { txs: [...input.entityTxs], env });
    pendingItems += input.entityTxs.length;
  }
  if (pendingItems >= FLUSH_AT_ITEMS) {
    flushPending();
    return;
  }
  if (!flushScheduled && pendingItems > 0) {
    flushScheduled = true;
    setTimeout(flushPending, 0);
  }
};
