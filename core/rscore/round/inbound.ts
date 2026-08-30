/**
 * One Entity input's arrivals, handed to the engine in one call.
 *
 * The Entity frame knows every account input it carries before it dispatches
 * any of them. Rather than asking the engine one arrival at a time, it hands
 * over one whole batch and then reads the verdicts back as its own handlers
 * reach them. Inbound is effects-only: no full Account body crosses here.
 * The final body and node diff span both visits and return once, after the
 * Entity has derived every outbound admission. The batch is never split into
 * extra IPC calls.
 *
 * The verdicts are a queue, not a lookup: a verdict TypeScript never consumed
 * means the engine applied something the Entity decided not to, so the round
 * refuses to close rather than leaving the two sides quietly apart.
 */
import type { EntityTx } from '../../types/entity-tx';
import type { AccountPeerInput } from '../../types/account';
import type { Wave } from '../wave-decode';
import { safeStringify } from '../../protocol/serialization';

const fail = (code: string, detail: Readonly<Record<string, unknown>> = {}): never => {
  throw new Error(`RSCORE_ROUND_${code}:${safeStringify(detail)}`);
};

/** The three arrival shapes the Account layer accepts from a peer. */
type PeerArrivalInput = Extract<AccountPeerInput, { kind: 'frame' | 'ack' | 'ack_frame' }>;

/** One arrival waiting to be handed over, in the order the frame carries it. */
export type InboundArrival = Readonly<{
  accountId: string;
  input: PeerArrivalInput;
}>;

export type InboundWaveIndex = Readonly<{
  appliedByOperation: ReadonlyMap<number, Wave['applied'][number]>;
  postAccountById: ReadonlyMap<string, Wave['postAccounts'][number]>;
  touchedById: ReadonlyMap<string, Wave['touched'][number]>;
}>;

/** Build once per bulk response; slicing every arrival must stay O(1). */
export const indexInboundWave = (wave: Wave): InboundWaveIndex => {
  const appliedByOperation = new Map(wave.applied.map(row => [row.operationIndex, row]));
  const postAccountById = new Map(wave.postAccounts.map(row => [row.accountId, row]));
  const touchedById = new Map(wave.touched.map(row => [row.accountId, row]));
  if (
    appliedByOperation.size !== wave.applied.length
    || postAccountById.size !== wave.postAccounts.length
    || touchedById.size !== wave.touched.length
  ) {
    return fail('INDEX_DUPLICATE');
  }
  return { appliedByOperation, postAccountById, touchedById };
};

/**
 * The arrivals one Entity frame carries, in order.
 *
 * An `accountInput` Entity transaction names the peer it came from, and that
 * peer is the account it moves. Anything else in the frame is the Entity's own
 * work and never reaches the Account layer on the way in.
 */
export const inboundArrivals = (entityTxs: readonly EntityTx[]): InboundArrival[] =>
  entityTxs.flatMap(entityTx => {
    if (entityTx.type !== 'accountInput') return [];
    const input = entityTx.data;
    const accountId = String(input.fromEntityId ?? '').trim().toLowerCase();
    if (accountId.length === 0) return fail('ARRIVAL_PEER_MISSING');
    if (input.kind !== 'frame' && input.kind !== 'ack' && input.kind !== 'ack_frame') {
      return fail('ARRIVAL_KIND_OUTSIDE_PROFILE', { account: accountId, kind: input.kind });
    }
    return [{ accountId, input }];
  });

/**
 * One arrival's own view of the round it was answered in.
 *
 * The publisher downstream expects the reply for a single operation. Slicing
 * the bulk verdict here keeps it unaware that anything was batched; the
 * post-state row is deliberately absent until the outbound visit.
 */
export const inboundSlice = (
  wave: Wave,
  accountId: string,
  operationIndex: number,
  index: InboundWaveIndex = indexInboundWave(wave),
): Wave => {
  const applied = index.appliedByOperation.get(operationIndex);
  if (applied === undefined || applied.accountId !== accountId) {
    return fail('VERDICT_UNBOUND', {
      account: accountId,
      operationIndex,
      rows: applied === undefined ? 0 : 1,
    });
  }
  const postAccount = index.postAccountById.get(accountId);
  const touched = index.touchedById.get(accountId);
  return {
    ...wave,
    applied: [applied],
    admissions: [],
    proposals: [],
    postAccounts: postAccount === undefined ? [] : [postAccount],
    touched: touched === undefined ? [] : [touched],
  };
};
