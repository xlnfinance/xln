import { deriveDelta, isLeftEntity } from '../../../account/utils';
import type { EntityTx } from '../../../types/entity-tx';
import { send, userReplica, waitFor, type PocUser } from '../user';

const collateral = (user: PocUser, hub: string): bigint => {
  const account = userReplica(user).state.accounts.get(hub);
  if (!account) throw new Error('USDC_POC_SOURCE_INGRESS_ACCOUNT_MISSING');
  const delta = account.state.deltas.get(1);
  if (!delta) throw new Error('USDC_POC_SOURCE_INGRESS_TOKEN_MISSING');
  return deriveDelta(delta, isLeftEntity(user.entityId, hub)).outCollateral;
};

/** Accepted operations are recovered from the canonical WAL-owned batch.
 * Reissuing its E2R after a lost response would debit the user's wallet twice. */
const admitIngress = (
  user: PocUser,
  operation: 'externalTokenToReserve' | 'reserveToCollateral',
  tx: EntityTx,
): void => {
  const batch = userReplica(user).state.jBatchState;
  if (batch?.sentBatch) {
    if (!batch.sentBatch.batch[operation].length) throw new Error('USDC_POC_UNRELATED_INGRESS_BATCH_PENDING');
    return;
  }
  send(user, [...(batch?.batch[operation].length ? [] : [tx]), { type: 'j_broadcast', data: {} }]);
};

export const ensureSourceCollateral = async (user: PocUser, hub: string, tokenAddress: string): Promise<void> => {
  if (collateral(user, hub) === 1_000_000n) return;
  const accepted = userReplica(user).state.jBatchState;
  if (accepted?.sentBatch?.batch.reserveToCollateral.length || accepted?.batch.reserveToCollateral.length) {
    await completeCollateral(user, hub);
    return;
  }
  const reserve = userReplica(user).state.reserves.get(1) ?? 0n;
  if (collateral(user, hub) !== 0n || (reserve !== 0n && reserve !== 1_000_000n))
    throw new Error('USDC_POC_SOURCE_INGRESS_POSITION_INVALID');
  if (reserve === 0n) {
    admitIngress(user, 'externalTokenToReserve', {
      type: 'e2r',
      data: {
        contractAddress: tokenAddress,
        internalTokenId: 1,
        amount: 1_000_000n,
      },
    });
    await waitFor(
      'reserve-deposit-observed',
      () => (userReplica(user).state.reserves.get(1) ?? 0n) === 1_000_000n || collateral(user, hub) === 1_000_000n,
    );
  }
  if (collateral(user, hub) === 1_000_000n) return;
  await completeCollateral(user, hub);
};

const completeCollateral = async (user: PocUser, hub: string): Promise<void> => {
  admitIngress(user, 'reserveToCollateral', {
    type: 'r2c',
    data: {
      counterpartyId: hub,
      tokenId: 1,
      amount: 1_000_000n,
    },
  });
  await waitFor('account-collateral-committed', () => {
    const account = userReplica(user).state.accounts.get(hub);
    return Boolean(account && !account.pendingFrame && !account.mempool.length && collateral(user, hub) === 1_000_000n);
  });
};
