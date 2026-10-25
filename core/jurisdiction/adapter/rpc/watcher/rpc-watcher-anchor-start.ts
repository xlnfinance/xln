import type { EntityReplica } from '../../../../entity/types';
import type { RuntimeReplica } from '../../../../runtime/types';
import type { EntityTx } from '../../../../types/entity-tx';
import type { JReplica } from '../../../../types/jurisdiction-runtime';
import { getEntityConfigBoardHash } from '../../../../hanko/signing';
import { buildJAnchorTx } from '../../../../entity/tx/j-anchor/j-anchor-finality';
import { isSingleSignerEntity } from '../../../../entity/consensus/replica-validation';
import { enqueueRuntimeInput } from '../../../../runtime/mempool/input-queue';
import { getJScanHistory } from '../../../../runtime/mempool/j-scan-carry';
import { isEntityReplicaRelevantToWatcher } from '../../watcher';
import { readJHistoryAnchorStartFromStorage, type JHistoryAnchorStart } from '../state-anchor/rpc-proven-values-root';
import type { RpcWatcherServices, RpcWatcherSession } from './rpc-watcher-types';

type AnchorStartRequest = {
  session: RpcWatcherSession;
  services: RpcWatcherServices;
  watcherReplica: JReplica;
  safeToBlock: number;
  isCancelled(): boolean;
  isPaused(): boolean;
  emitDebug(payload: Record<string, unknown>): void;
};

const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const hasEntries = (ledger: EntityReplica['state']['outDebtsByToken']): boolean =>
  [...(ledger?.values() ?? [])].some((byId) => byId.size > 0);

/**
 * A fresh import its own signer certifies alone: lazy (no registration fence,
 * which needs a J-prefix certificate), no J finality and no scanned history,
 * and none of the local state applyJHistoryAnchor refuses (sent batch, pending
 * EntityProvider action, debts). Everything else keeps the full history scan.
 */
const isAnchorCandidate = (env: RuntimeReplica, replicaKey: string, replica: EntityReplica): boolean => {
  const { state } = replica;
  const jurisdiction = state.config.jurisdiction;
  return Boolean(jurisdiction) && jurisdiction?.registrationBlock === undefined
    && !state.jHistoryFinality && replica.isProposer && isSingleSignerEntity(state)
    && state.config.validators.length === 1 && normalize(state.config.validators[0]) === normalize(replica.signerId)
    && !getJScanHistory(env, replicaKey, replica)
    && !state.jBatchState?.sentBatch && !state.entityProviderActionState?.pending
    && !hasEntries(state.outDebtsByToken) && !hasEntries(state.inDebtsByToken);
};

const isAnchorTxAt = (height: number) => (tx: EntityTx): boolean =>
  tx.type === 'j_anchor' && tx.data.anchorHeight === height;

/** The enqueued 'j_anchor' still waits in the Runtime queue, the Entity mempool or an open frame. */
const isJAnchorQueued = (env: RuntimeReplica, replicaKey: string, height: number): boolean => {
  const replica = env.state.eReplicas.get(replicaKey);
  if (!replica) return false;
  const entityId = normalize(replica.state.entityId);
  const atHeight = isAnchorTxAt(height);
  return (env.runtimeMempool?.entityInputs ?? []).some(input =>
    normalize(input.entityId) === entityId && (input.entityTxs ?? []).some(atHeight))
    || replica.mempool.some(atHeight)
    || Boolean(replica.proposal?.txs.some(atHeight))
    || Boolean(replica.lockedFrame?.txs.some(atHeight));
};

/**
 * Starts a fresh import at the confirmed tip instead of the EntityProvider
 * deployment: values only from eth_getProof under the authenticated tip
 * header, admitted by the Entity's own 'j_anchor' frame. The scan cursor moves
 * to the anchor only after every anchored replica committed it; the first
 * range after it is then fenced by the anchor hash as its finalized parent.
 * Only an explicit 'history' read result keeps full history; evidence errors
 * propagate unchanged. Returns true while this poll must not scan.
 */
export const startWatcherFromStorageAnchor = async (request: AnchorStartRequest): Promise<boolean> => {
  const { session, services } = request;
  const env = session.env;
  const pending = session.pendingAnchor;
  if (pending) {
    const isCommitted = (replicaKey: string): boolean =>
      env.state.eReplicas.get(replicaKey)?.state.jHistoryFinality?.finalizedThroughHeight === pending.height;
    const committed = pending.replicaKeys.every(isCommitted);
    if (!committed) {
      const uncommitted = pending.replicaKeys.filter(replicaKey => !isCommitted(replicaKey));
      if (uncommitted.some(replicaKey => isJAnchorQueued(env, replicaKey, pending.height))) return true;
      // The proposer dropped the anchor on local state it refuses: nothing was
      // admitted and the cursor never moved, so full history resumes from it.
      if (uncommitted.length !== pending.replicaKeys.length) {
        throw new Error(`J_ANCHOR_START_PARTIALLY_REFUSED:${pending.height}:${uncommitted.join(',')}`);
      }
      session.pendingAnchor = null;
      request.emitDebug({ event: 'j_watch_anchor_refused', height: pending.height, replicas: uncommitted });
      return false;
    }
    session.pendingAnchor = null;
    session.lastSyncedBlock = Math.max(session.lastSyncedBlock, pending.height);
    request.emitDebug({ event: 'j_watch_anchor_committed', height: pending.height, replicas: pending.replicaKeys });
    return false;
  }
  if (services.mode !== 'rpc' && services.mode !== 'anvil') return false;
  if (session.pendingHistoryRange) return false;
  const relevant = [...env.state.eReplicas.entries()]
    .filter(([, replica]) => isEntityReplicaRelevantToWatcher(env, replica, request.watcherReplica));
  if (relevant.length === 0) return false;
  if (!relevant.every(([replicaKey, replica]) => isAnchorCandidate(env, replicaKey, replica))) return false;
  if (relevant.some(([, replica]) => Number(replica.state.lastFinalizedJHeight) >= request.safeToBlock)) return false;
  // A board that does not commit to the Entity id (numbered) proposes nothing
  // until its EntityRegistered/BoardActivated history certifies it
  // (SELF_BOARD_CERTIFICATION_REQUIRED), so its 'j_anchor' could never commit.
  for (const [, replica] of relevant) {
    if (await getEntityConfigBoardHash(env, replica.state.config) !== normalize(replica.state.entityId)) return false;
  }
  const [header] = await services.readBlockHeaders([request.safeToBlock]);
  if (!header || header.jHeight !== request.safeToBlock) {
    throw new Error(`J_ANCHOR_START_HEADER_MISSING:${request.safeToBlock}`);
  }
  const send = (method: string, params: unknown[]) => services.provider.send(method, params);
  const starts: Array<{ replicaKey: string; replica: EntityReplica; start: Extract<JHistoryAnchorStart, { kind: 'anchor' }> }> = [];
  for (const [replicaKey, replica] of relevant) {
    const jurisdiction = replica.state.config.jurisdiction;
    if (!jurisdiction) throw new Error(`J_ANCHOR_START_JURISDICTION_MISSING:${replicaKey}`);
    const start = await readJHistoryAnchorStartFromStorage({
      send,
      jurisdiction,
      entityId: replica.state.entityId,
      blockNumber: request.safeToBlock,
      authenticatedBlockHash: header.jBlockHash,
    });
    if (start.kind === 'history') {
      request.emitDebug({ event: 'j_watch_anchor_history', replica: replicaKey, reason: start.reason });
      return false;
    }
    starts.push({ replicaKey, replica, start });
  }
  // Read-only up to here; the Runtime is touched only below.
  if (request.isCancelled() || request.isPaused()) return true;
  enqueueRuntimeInput(env, {
    runtimeTxs: [],
    entityInputs: starts.map(({ replica, start }) => ({
      entityId: replica.state.entityId,
      signerId: replica.signerId,
      entityTxs: [buildJAnchorTx(env, replica.state, replica.signerId, start.header, start.values)],
    })),
  });
  session.pendingAnchor = { height: request.safeToBlock, replicaKeys: starts.map(({ replicaKey }) => replicaKey) };
  request.emitDebug({ event: 'j_watch_anchor_enqueued', height: request.safeToBlock, replicas: session.pendingAnchor.replicaKeys });
  return true;
};
