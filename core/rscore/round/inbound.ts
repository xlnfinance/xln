/**
 * One Entity input's arrivals, handed to the engine in one call.
 *
 * The Entity frame knows every account input it carries before it dispatches
 * any of them. Rather than asking the engine one arrival at a time, it hands
 * over one whole batch and then reads the verdicts back as its own handlers
 * reach them. If an account occurs more than once, only its last verdict
 * publishes the final post-state row; every earlier verdict still publishes
 * its own events and effects. The batch is never split into extra IPC calls.
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
type PeerArrivalInput = Extract<AccountPeerInput, { kind: 'frame' | 'ack' | 'frame_ack' }>;

/** One arrival waiting to be handed over, in the order the frame carries it. */
export type InboundArrival = Readonly<{
  accountId: string;
  input: PeerArrivalInput;
}>;

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
    if (input.kind !== 'frame' && input.kind !== 'ack' && input.kind !== 'frame_ack') {
      return fail('ARRIVAL_KIND_OUTSIDE_PROFILE', { account: accountId, kind: input.kind });
    }
    return [{ accountId, input }];
  });

/**
 * One arrival's own view of the round it was answered in.
 *
 * The publisher downstream expects the reply for a single operation: one
 * verdict, and the post-state row of the account it moved. Slicing the round
 * here keeps that publisher unaware that anything was batched.
 */
export const inboundSlice = (wave: Wave, accountId: string, operationIndex: number): Wave => {
  const applied = wave.applied.filter(row => row.operationIndex === operationIndex);
  if (applied.length !== 1 || applied[0]?.accountId !== accountId) {
    return fail('VERDICT_UNBOUND', { account: accountId, operationIndex, rows: applied.length });
  }
  return {
    ...wave,
    applied,
    admissions: [],
    proposals: [],
    postAccounts: wave.postAccounts.filter(row => row.accountId === accountId),
    touched: wave.touched.filter(row => row.accountId === accountId),
  };
};
