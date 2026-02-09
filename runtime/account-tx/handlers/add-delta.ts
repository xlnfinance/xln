/**
 * Add Delta Handler
 * Creates a new token delta with zero balances (Channel.ts AddDelta pattern)
 */

import type { AccountMachine, AccountTx } from '../../types';
import type { TokenId } from '../../ids';
import { getAccountPerspective } from '../../state-helpers';

export function handleAddDelta(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'add_delta' }>
): { success: boolean; events: string[]; error?: string } {
  const tokenId = accountTx.data.tokenId as TokenId;
  const events: string[] = [];

  // Check if delta already exists
  if (accountMachine.deltas.has(tokenId)) {
    console.warn(`⚠️ Delta for token ${tokenId} already exists, skipping add_delta`);
    return { success: true, events }; // Idempotent - not an error
  }

  // Create new delta with zero balances (matches Channel.ts AddDelta pattern)
  const newDelta = {
    tokenId,
    collateral: 0n,
    ondelta: 0n,
    offdelta: 0n,
    leftCreditLimit: 0n,
    rightCreditLimit: 0n,
    leftAllowance: 0n,
    rightAllowance: 0n,
  };

  accountMachine.deltas.set(tokenId, newDelta);
  const { counterparty } = getAccountPerspective(accountMachine, accountMachine.proofHeader.fromEntity);
  console.log(`✅ Added delta for token ${tokenId} to account with ${counterparty.slice(-4)}`);

  events.push(`➕ Added token ${tokenId} to account`);
  return { success: true, events };
}
