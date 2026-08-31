import type { AccountFailedHtlcLock } from '../../../account/consensus/types';
import type { AccountTxBatch } from '../../../types/account';
import type { EntityState } from '../../types';
import { hasInboundPayment } from '../../paybook/views';

export type FailedProposalHtlcFollowup =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'originated'; hashlock: string; reason: string }>
  | Readonly<{
      kind: 'forwarded';
      hashlock: string;
      reason: string;
      accountId: string;
      input: AccountTxBatch;
    }>;

/** One canonical interpretation of a genuine Account proposal rejection. */
export const failedProposalHtlcFollowup = (
  state: EntityState,
  failure: AccountFailedHtlcLock,
): FailedProposalHtlcFollowup => {
  const route = state.paybook.entries.get(failure.hashlock);
  if (!route) return { kind: 'absent' };
  if (!hasInboundPayment(route)) return { kind: 'originated', ...failure };
  return {
    kind: 'forwarded',
    ...failure,
    accountId: route.inboundEntity,
    input: {
      kind: 'enqueue',
      txs: [{
        type: 'htlc_resolve',
        data: {
          lockId: failure.hashlock,
          outcome: 'error',
          reason: `forward_failed:${failure.reason}`,
        },
      }],
    },
  };
};
