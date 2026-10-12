import type { EntityTx } from '../../types/entity-tx';
import type { AccountInput } from '../../types/account';
import { safeStringify } from '../../protocol/serialization';

const fail = (code: string, detail: Readonly<Record<string, unknown>> = {}): never => {
  throw new Error(`RSCORE_ROUND_${code}:${safeStringify(detail)}`);
};

/** The two network arrival shapes accepted by Account. */
type AccountArrivalInput = Extract<AccountInput, { kind: 'ack' | 'ack_frame' }>;

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
    if (input.kind !== 'ack' && input.kind !== 'ack_frame') {
      return fail('ARRIVAL_KIND_OUTSIDE_PROFILE', { account: accountId, kind: input.kind });
    }
    return [{ accountId, input }];
  });
