/**
 * Atomically admits matcher-produced transactions into one bilateral Account lane.
 * A book fill must never commit unless every corresponding Account settlement is queued.
 * Proposal validation is the second half: any rejected matcher resolve aborts the same
 * isolated Entity candidate, so neither its book update nor Account work reaches WAL.
 */

import { applyAccountInput } from '../../../account/consensus';
import type { AccountConsensusContext } from '../../../account/consensus/context';
import { createLocalAccountInput } from '../../../account/input';
import { haltRuntimeFailure } from '../../../protocol/errors/failure-taxonomy';
import type { AccountReplica, AccountTx } from '../../../types/account';

export const admitOrderbookAccountTxBatch = async (
  context: AccountConsensusContext,
  account: AccountReplica,
  ownerEntityId: string,
  txs: readonly AccountTx[],
): Promise<void> => {
  const admission = await applyAccountInput(
    context,
    account,
    createLocalAccountInput(account.state, ownerEntityId, [...txs]),
  );
  if (!admission.ok || admission.admittedAccountTxCount !== txs.length) {
    const admitted = admission.ok ? admission.admittedAccountTxCount ?? 0 : 0;
    throw haltRuntimeFailure(
      'ORDERBOOK_ACCOUNT_TX_ADMISSION_FAILED',
      `ORDERBOOK_ACCOUNT_TX_ADMISSION_FAILED: account=${account.state.leftEntity}:${account.state.rightEntity} expected=${txs.length} admitted=${admitted}`,
    );
  }
};
