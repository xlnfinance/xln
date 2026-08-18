/**
 * Add Delta Handler
 * Creates a new token delta with zero balances (Channel.ts AddDelta pattern)
 */

import type { AccountTx } from '../../../../types/account';
import type { AccountDraftState } from '../../../state/account-state-draft';
import { AccountDeltaError } from '../../../state/delta';
import type { ApplyAccountTxResult } from '../../apply-types';
import {
  accountTxApplied,
  accountTxRejected,
  rejectionFromDeltaError,
} from '../../apply-result';
import { commitDeltaDraft, createDeltaDraft } from '../../delta-utils';

export function handleAddDelta(
  account: AccountDraftState,
  accountTx: Extract<AccountTx, { type: 'add_delta' }>,
): ApplyAccountTxResult {
  const { tokenId } = accountTx.data;
  const events: string[] = [];

  const existed = account.deltas.has(tokenId);
  try {
    // A zero-valued row is omitted from AccountFrame.deltas, so frame-shape
    // validation alone cannot stop a signed peer from exhausting this map.
    // Keep the bounded insertion at the mutation sink and reject it as data.
    commitDeltaDraft(account, createDeltaDraft(account, tokenId));
  } catch (error) {
    if (!(error instanceof AccountDeltaError)) throw error;
    return accountTxRejected(rejectionFromDeltaError(error, tokenId), [error.message]);
  }
  if (existed) return accountTxApplied(events);

  events.push(`➕ Added token ${tokenId} to account`);
  return accountTxApplied(events);
}
