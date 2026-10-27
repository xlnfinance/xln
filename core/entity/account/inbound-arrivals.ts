import type { EntityTx } from '../../types/entity-tx';
import { safeStringify } from '../../protocol/serialization';

const fail = (code: string, detail: Readonly<Record<string, unknown>> = {}): never => {
  throw new Error(`RSCORE_ROUND_${code}:${safeStringify(detail)}`);
};

/**
 * Every peer-wire Account input an `accountInput` Entity transaction carries
 * (`enqueue` is local admission and never travels as one). `dispute` and
 * `board_hanko_refresh` are honest peer traffic too: board rotation emits
 * `board_hanko_refresh` to every counterparty
 * (core/entity/tx/state-effects/board-rotation-hanko-refresh.ts). The Account
 * worker applies every kind through the same `applyAccountInput` as the
 * non-resident path; refusing them here halted a cutover hub on a peer's
 * ordinary board rotation.
 */
type AccountArrivalInput = Extract<EntityTx, { type: 'accountInput' }>['data'];

/** One arrival waiting to be handed over, in the order the frame carries it. */
export type InboundArrival = Readonly<{
  accountId: string;
  input: AccountArrivalInput;
}>;

/**
 * The arrivals one Entity frame carries, in order.
 *
 * An `accountInput` Entity transaction names its counterparty, which is the
 * Account it moves. Anything else in the frame is the Entity's own
 * work and never reaches the Account layer on the way in.
 */
export const inboundArrivals = (entityTxs: readonly EntityTx[]): InboundArrival[] =>
  entityTxs.flatMap(entityTx => {
    if (entityTx.type !== 'accountInput') return [];
    const input = entityTx.data;
    const accountId = String(input.fromEntityId ?? '')
      .trim()
      .toLowerCase();
    if (accountId.length === 0) return fail('ARRIVAL_PEER_MISSING');
    return [{ accountId, input }];
  });
