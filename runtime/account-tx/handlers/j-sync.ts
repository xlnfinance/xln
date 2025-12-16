/**
 * J-Sync Handler
 * Bilateral consensus for j-machine state updates (collateral, ondelta)
 *
 * PATTERN:
 * 1. Both sides receive same j-event from block N
 * 2. Both add j_sync { jBlockNumber: N, tokenId, collateral, ondelta } to mempool
 * 3. Both propose frames with j_sync
 * 4. When jBlockNumber + tokenId match → auto-finalize (2 of 2)
 * 5. Apply absolute values from j-machine (authoritative source)
 */

import { AccountMachine, AccountTx } from '../../types';
import { getDefaultCreditLimit } from '../../account-utils';

export function handleJSync(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'j_sync' }>,
  isOurFrame: boolean = true
): { success: boolean; events: string[]; error?: string } {
  const { jBlockNumber, tokenId, collateral, ondelta } = accountTx.data;
  const events: string[] = [];

  const entityShort = accountMachine.proofHeader.fromEntity.slice(-4);
  const counterpartyShort = accountMachine.counterpartyEntityId.slice(-4);

  // 3) A-MACHINE FINALIZES: j_sync applied to account delta
  console.log(`💰 [3/3] A-MACHINE: ${entityShort}↔${counterpartyShort} | coll=${collateral} delta=${ondelta}`);

  // Get or create delta
  let delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
    console.log(`🔗 J-SYNC: NEW delta token=${tokenId}`);
    const defaultCreditLimit = getDefaultCreditLimit(tokenId);
    delta = {
      tokenId,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: defaultCreditLimit,
      rightCreditLimit: defaultCreditLimit,
      leftAllowance: 0n,
      rightAllowance: 0n,
    };
    accountMachine.deltas.set(tokenId, delta);
  }

  const oldCollateral = delta.collateral;
  const oldOndelta = delta.ondelta;

  // Apply ABSOLUTE values from j-machine (authoritative source)
  delta.collateral = collateral;
  delta.ondelta = ondelta;

  console.log(`   ✅ Applied: collateral ${oldCollateral}→${delta.collateral}, ondelta ${oldOndelta}→${delta.ondelta}`);

  events.push(`🔗 J-Sync block ${jBlockNumber}: collateral=${collateral}, ondelta=${ondelta}`);

  // Update current frame deltas
  const tokenIndex = accountMachine.currentFrame.tokenIds.indexOf(tokenId);
  const totalDelta = delta.ondelta + delta.offdelta;

  if (tokenIndex >= 0) {
    accountMachine.currentFrame.deltas[tokenIndex] = totalDelta;
  } else {
    accountMachine.currentFrame.tokenIds.push(tokenId);
    accountMachine.currentFrame.deltas.push(totalDelta);
  }

  console.log(`   📊 Frame delta updated: totalDelta=${totalDelta}`);

  return { success: true, events };
}
