import { LIMITS } from '../../config/constants';
import type { HtlcNoteKey } from '../../types/account';
import type { EntityTx } from '../../types/entity-tx';
import type { EntityFrame, EntityReplica } from '../types';

type NoteBinding = Readonly<{
  hashlock: string;
  lockId?: string;
  description: string;
}>;

const nestedEntityTxs = (
  tx: EntityTx,
  replica: EntityReplica,
): readonly EntityTx[] => {
  switch (tx.type) {
    case 'entityCommand':
      return tx.data.txs;
    case 'consensusOutput':
    case 'runtimeOutput':
    case 'reissueCertifiedOutput':
      return tx.data.entityTxs;
    case 'propose':
      return tx.data.action.type === 'entity_transaction'
        ? tx.data.action.data.txs
        : [];
    case 'vote': {
      const proposal = replica.state.proposals.get(tx.data.proposalId);
      return proposal?.status === 'executed'
        && proposal.action.type === 'entity_transaction'
        ? proposal.action.data.txs
        : [];
    }
    default:
      return [];
  }
};

const noteBinding = (tx: EntityTx, replica: EntityReplica): NoteBinding | null => {
  if (tx.type === 'htlcPayment') {
    const description = tx.data.description?.trim();
    const hashlock = tx.data.hashlock;
    if (!description || !hashlock) return null;
    return {
      hashlock,
      ...(tx.data.preparedLockId ? { lockId: tx.data.preparedLockId } : {}),
      description,
    };
  }
  if (tx.type === 'hashlockPayment') {
    const description = tx.data.description?.trim();
    if (!description) return null;
    const lockId = tx.data.lockId
      ?? replica.state.htlcRoutes.get(tx.data.hashlock)?.outboundLockId;
    return {
      hashlock: tx.data.hashlock,
      ...(lockId ? { lockId } : {}),
      description,
    };
  }
  if (tx.type === 'htlcOnionAdvance' && tx.data.advance.kind === 'final') {
    const description = tx.data.advance.description?.trim();
    if (!description) return null;
    return {
      hashlock: tx.data.hashlock,
      lockId: tx.data.inboundLockId,
      description,
    };
  }
  return null;
};

const putNote = (
  notes: Map<HtlcNoteKey, string>,
  key: HtlcNoteKey,
  description: string,
): void => {
  if (description.length > LIMITS.MAX_ENTITY_HTLC_NOTE_LENGTH) {
    throw new Error(`ENTITY_HTLC_NOTE_INVALID_LENGTH:${description.length}`);
  }
  const existing = notes.get(key);
  if (existing !== undefined && existing !== description) {
    throw new Error(`ENTITY_HTLC_NOTE_CONFLICT:${key}`);
  }
  if (existing === undefined && notes.size >= LIMITS.MAX_ENTITY_HTLC_NOTES) {
    throw new Error(
      `ENTITY_HTLC_NOTE_LIMIT_EXCEEDED:size=${notes.size + 1}:max=${LIMITS.MAX_ENTITY_HTLC_NOTES}`,
    );
  }
  notes.set(key, description);
};

const indexTx = (
  replica: EntityReplica,
  notes: Map<HtlcNoteKey, string>,
  tx: EntityTx,
): void => {
  const binding = noteBinding(tx, replica);
  if (binding) {
    putNote(notes, `hashlock:${binding.hashlock}`, binding.description);
    if (binding.lockId) putNote(notes, `lock:${binding.lockId}`, binding.description);
  }
  for (const nested of nestedEntityTxs(tx, replica)) indexTx(replica, notes, nested);
};

/**
 * Update the validator-local presentation index from the exact certified
 * EntityFrame. This is intentionally after certification: indexing an ingress
 * request would display data that never became part of Entity history.
 */
export const indexCertifiedEntityFrameNotes = (
  replica: EntityReplica,
  frame: Pick<EntityFrame, 'txs'>,
): void => {
  const notes = replica.htlcNotes ?? new Map<HtlcNoteKey, string>();
  for (const tx of frame.txs) indexTx(replica, notes, tx);
  if (notes.size > 0) replica.htlcNotes = notes;
  else delete replica.htlcNotes;
};

const TERMINAL_HTLC_EVENTS = new Set([
  'HtlcFailed',
  'HtlcFinalized',
  'HtlcReceived',
]);

/**
 * Attach validator-local presentation data to a durable terminal event, then
 * consume it. Consensus reachability is deliberately not a cleanup signal:
 * Account settlement may remove the last route before the parent Runtime
 * publishes the resulting event in a later frame.
 */
export const consumeHtlcRuntimeEvent = (
  replica: EntityReplica,
  eventName: string,
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const lockId = typeof data['lockId'] === 'string' ? data['lockId'] : null;
  const hashlock = typeof data['hashlock'] === 'string' ? data['hashlock'] : null;
  const notes = replica.htlcNotes;
  const description =
    typeof data['description'] === 'string'
      ? data['description']
      : (lockId ? notes?.get(`lock:${lockId}`) : undefined)
        ?? (hashlock ? notes?.get(`hashlock:${hashlock}`) : undefined);
  if (notes && TERMINAL_HTLC_EVENTS.has(eventName)) {
    if (lockId) notes.delete(`lock:${lockId}`);
    if (hashlock) notes.delete(`hashlock:${hashlock}`);
    if (notes.size === 0) delete replica.htlcNotes;
  }
  return description === undefined || typeof data['description'] === 'string'
    ? data
    : { ...data, description };
};
