import { LIMITS } from '../../config/constants';
import type { HtlcNoteKey } from '../../types/account';
import type { EntityTx } from '../../types/entity-tx';
import type { EntityFrame, EntityReplica } from '../types';
import type { EntityInfraContext } from '../../types/entity/infra-context';

type NoteBinding = Readonly<{
  hashlock: string;
  description: string;
}>;

const nestedEntityTxs = (
  tx: EntityTx,
): readonly EntityTx[] => {
  switch (tx.type) {
    case 'entityCommand':
      return tx.data.txs;
    case 'runtimeOutput':
      return tx.data.entityTxs;
    case 'propose':
      return tx.data.action.type === 'entity_transaction'
        ? tx.data.action.data.txs
        : [];
    // Vote completion deletes the pending proposal from live state. Private
    // HTLC notes are indexed from the exact certified frame context below;
    // terminal proposal bodies belong only to Entity history/WAL.
    case 'vote':
      return [];
    default:
      return [];
  }
};

const noteBinding = (tx: EntityTx): NoteBinding | null => {
  if (tx.type === 'htlcPayment') {
    const description = tx.data.description?.trim();
    const hashlock = tx.data.hashlock;
    if (!description || !hashlock) return null;
    return {
      hashlock,
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
  notes: Map<HtlcNoteKey, string>,
  tx: EntityTx,
): void => {
  const binding = noteBinding(tx);
  if (binding) {
    putNote(notes, `hashlock:${binding.hashlock}`, binding.description);
  }
  for (const nested of nestedEntityTxs(tx)) indexTx(notes, nested);
};

/**
 * Update the validator-local presentation index from the exact certified
 * EntityFrame. This is intentionally after certification: indexing an ingress
 * request would display data that never became part of Entity history.
 */
export const indexCertifiedEntityFrameNotes = (
  replica: EntityReplica,
  frame: Pick<EntityFrame, 'txs'> & { entityContext?: EntityInfraContext },
): void => {
  const notes = replica.htlcNotes ?? new Map<HtlcNoteKey, string>();
  for (const tx of frame.txs) indexTx(notes, tx);
  // The final recipient learns the private note only by decrypting its onion;
  // it never sees the sender's htlcPayment tx. Index the exact certified
  // prepared outcome so the later ACK-backed HtlcReceived event can attach it.
  for (const entry of frame.entityContext?.htlc.entries ?? []) {
    if (entry.outcome.kind !== 'final' || !entry.outcome.description) continue;
    putNote(notes, `hashlock:${entry.binding.hashlock}`, entry.outcome.description);
  }
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
  const hashlock = typeof data['hashlock'] === 'string' ? data['hashlock'] : null;
  const notes = replica.htlcNotes;
  const description =
    typeof data['description'] === 'string'
      ? data['description']
      : (hashlock ? notes?.get(`hashlock:${hashlock}`) : undefined);
  if (notes && TERMINAL_HTLC_EVENTS.has(eventName)) {
    if (hashlock) notes.delete(`hashlock:${hashlock}`);
    if (notes.size === 0) delete replica.htlcNotes;
  }
  return description === undefined || typeof data['description'] === 'string'
    ? data
    : { ...data, description };
};
