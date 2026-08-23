import { safeStringify } from '../serialization';
import { encodeBinaryPayload } from '../serialization/binary-codec';
import { keccakBytesHash } from '../crypto/keccak-text';
import { RecencyMemo } from '../../support/collections/recency-memo';

export type FingerprintableTx = {
  type: string;
  data?: unknown;
};

// The same mempool tx object is fingerprinted at admission, on every proposal
// window selection and again on removal. Queued tx objects are immutable,
// except settlement transitions, whose seal Hankos are attached in place by
// the Entity witness pass; those always re-render.
const fingerprintMemos = new RecencyMemo<FingerprintableTx, string>(16_384);

export const txFingerprint = (tx: FingerprintableTx): string => {
  if (tx.type === 'settle_transition') return txFingerprintUncached(tx);
  const hit = fingerprintMemos.get(tx);
  if (hit !== undefined) return hit;
  const fingerprint = txFingerprintUncached(tx);
  fingerprintMemos.set(tx, fingerprint);
  return fingerprint;
};

type CompactAccountInput = {
  kind: string;
  fromEntityId: string;
  toEntityId: string;
  domain?: unknown;
  disputeConfig?: unknown;
  watchSeed?: unknown;
  proposal?: {
    frame: {
      height: number; stateHash: string; prevFrameHash: string; accountStateRoot: string;
      timestamp: number; jHeight: number; byLeft: boolean; accountTxs: readonly unknown[]; deltas: readonly unknown[];
    };
    frameHanko?: string;
    disputeSeal?: { hash: string; hanko?: string };
  };
  ack?: { height: number; frameHash: string; frameHanko?: string; disputeSeal?: { hash: string; hanko?: string } };
};

const sealKey = (seal: { hash: string; hanko?: string } | undefined): string =>
  seal ? `${seal.hash}:${seal.hanko ?? ''}` : '';

const accountInputBodyDigests = new RecencyMemo<object, string>(16_384);

/**
 * Content digest of one complete Account input body (canonical binary form),
 * computed once per queued object. Peer-claimed hashes and Hankos are not an
 * identity before body validation: two envelopes claiming one `stateHash`
 * over different txs must never share a mempool key.
 */
export const accountInputBodyDigest = (input: object): string => {
  const hit = accountInputBodyDigests.get(input);
  if (hit !== undefined) return hit;
  const digest = keccakBytesHash(encodeBinaryPayload(input, 'msgpack', { omitSymbolKeys: true }));
  accountInputBodyDigests.set(input, digest);
  return digest;
};

/**
 * A Hub mempool is mostly Account inputs. The key carries the routing scalars
 * for readable diagnostics and the verified body digest for identity; the
 * canonical binary walk is far cheaper than rendering every onion layer to
 * JSON and runs once per queued object.
 */
const compactAccountInputFingerprint = (data: unknown): string | undefined => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const input = data as CompactAccountInput;
  if (input.kind !== 'frame' && input.kind !== 'frame_ack' && input.kind !== 'ack') return undefined;
  if (typeof input.fromEntityId !== 'string' || typeof input.toEntityId !== 'string') return undefined;
  const proposal = input.kind === 'ack' ? undefined : input.proposal;
  const ack = input.kind === 'frame' ? undefined : input.ack;
  const envelope = safeStringify([input.domain ?? null, input.disputeConfig ?? null, input.watchSeed ?? null]);
  return `accountInput:${input.kind}|${input.fromEntityId}|${input.toEntityId}|${envelope}` +
    `|${proposal
      ? `${proposal.frame.height}:${proposal.frame.stateHash}:${proposal.frameHanko ?? ''}:${sealKey(proposal.disputeSeal)}`
        + `:${proposal.frame.prevFrameHash}:${proposal.frame.accountStateRoot}:${proposal.frame.timestamp}:${proposal.frame.jHeight}`
        + `:${proposal.frame.byLeft}:${proposal.frame.accountTxs.length}:${proposal.frame.deltas.length}`
      : ''}` +
    `|${ack ? `${ack.height}:${ack.frameHash}:${ack.frameHanko ?? ''}:${sealKey(ack.disputeSeal)}` : ''}` +
    `|${accountInputBodyDigest(input)}`;
};

const txFingerprintUncached = (tx: FingerprintableTx): string => {
  if (tx.type === 'accountInput') {
    const compact = compactAccountInputFingerprint(tx.data);
    if (compact !== undefined) return compact;
  }
  if (
    tx.type !== 'consensusOutput' ||
    !tx.data ||
    typeof tx.data !== 'object' ||
    Array.isArray(tx.data)
  ) {
    return `${tx.type}:${safeStringify(tx.data)}`;
  }

  /*
   * consumptionProof is a target-proposer witness over the target pre-state.
   * It is absent from the transported mempool item and attached only to the
   * proposed frame. Including it would make a committed output impossible to
   * match and remove, causing an endless idempotent replay loop.
   */
  const {
    consumptionProof: _targetWitness,
    ...certifiedOutput
  } = tx.data as Record<string, unknown>;
  return `${tx.type}:${safeStringify(certifiedOutput)}`;
};

/**
 * Remove the exact committed transaction multiset while preserving the order
 * and multiplicity of every still-pending transaction.
 */
export const removeCommittedTxsFromMempool = <
  T extends FingerprintableTx,
>(
  mempool: T[],
  committedTxs: readonly T[],
): T[] => {
  if (committedTxs.length === 0 || mempool.length === 0) return mempool;

  // Committed txs are usually the exact mempool objects: pair by identity
  // first and fingerprint (full stringify) only what identity could not pair.
  const byIdentity = new Map<T, number>();
  for (const tx of committedTxs) byIdentity.set(tx, (byIdentity.get(tx) ?? 0) + 1);
  const remaining: T[] = [];
  for (const tx of mempool) {
    const count = byIdentity.get(tx) ?? 0;
    if (count <= 0) remaining.push(tx);
    else if (count === 1) byIdentity.delete(tx);
    else byIdentity.set(tx, count - 1);
  }
  if (byIdentity.size === 0) return remaining;

  const pendingRemovals = new Map<string, number>();
  for (const [tx, count] of byIdentity) {
    const fingerprint = txFingerprint(tx);
    pendingRemovals.set(fingerprint, (pendingRemovals.get(fingerprint) ?? 0) + count);
  }

  return remaining.filter(tx => {
    const fingerprint = txFingerprint(tx);
    const remaining = pendingRemovals.get(fingerprint) ?? 0;
    if (remaining <= 0) return true;
    if (remaining === 1) pendingRemovals.delete(fingerprint);
    else pendingRemovals.set(fingerprint, remaining - 1);
    return false;
  });
};
