/**
 * Add Delta Handler
 * Creates a new token delta with zero balances (Channel.ts AddDelta pattern)
 */

import type { AccountTx } from '../../../../types/account';
import type { AccountDraftState } from '../../../state/account-state-draft';
import type { ApplyAccountTxResult } from '../../apply-types';
import { accountTxApplied } from '../../apply-result';
import { commitDeltaDraft, createDeltaDraft } from '../../delta-utils';

export function handleAddDelta(
  account: AccountDraftState,
  accountTx: Extract<AccountTx, { type: 'add_delta' }>,
): ApplyAccountTxResult {
  const { tokenId } = accountTx.data;
  const events: string[] = [];

  if (account.deltas.has(tokenId)) return accountTxApplied(events);
  // A zero-valued row is still part of AccountState, so the state-root-only
  // frame body cannot stop a signed peer from exhausting this map. The
  // bounded insertion at createDeltaDraft rejects the 129th row as data
  // (applyAccountTx converts it).
  commitDeltaDraft(account, createDeltaDraft(account, tokenId));
  events.push(`➕ Added token ${tokenId} to account`);
  return accountTxApplied(events);
}
