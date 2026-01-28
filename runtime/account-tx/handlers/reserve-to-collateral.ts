/**
 * Reserve → Collateral Handler (Account Level)
 *
 * Processes on-chain R→C event to update bilateral account state.
 * Both entities receive identical event and MUST compute identical state.
 *
 * Reference: Depository.sol reserveToCollateral (line 1035)
 * Reference: 2019src.txt lines 233-239 (reserveToChannel pattern)
 *
 * CRITICAL: Uses ABSOLUTE values from contract event, not deltas.
 * This prevents drift from multiple R→C operations.
 */

import type { AccountMachine, AccountTx } from '../../types';
import { getDefaultCreditLimit } from '../../account-utils';

export function handleReserveToCollateral(
  accountMachine: AccountMachine,
  accountTx: Extract<AccountTx, { type: 'reserve_to_collateral' }>
): { success: boolean; events: string[]; error?: string } {
  const { tokenId, collateral, ondelta, side } = accountTx.data;
  const events: string[] = [];

  console.log(`💰 Processing R→C event: token ${tokenId}, collateral=${collateral}, ondelta=${ondelta}, side=${side}`);

  // CRITICAL: Both entities receive this event and MUST compute identical state
  // collateral and ondelta are ABSOLUTE values from contract, not deltas

  const collateralBigInt = BigInt(collateral);
  const ondeltaBigInt = BigInt(ondelta);

  // Get or create delta
  let delta = accountMachine.deltas.get(tokenId);
  if (!delta) {
    console.log(`💰 Creating new delta for token ${tokenId} (first R→C event)`);
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

  // CONSENSUS-CRITICAL: Update to absolute values from contract (not adding deltas!)
  const oldCollateral = delta.collateral;
  const oldOndelta = delta.ondelta;

  delta.collateral = collateralBigInt;
  delta.ondelta = ondeltaBigInt;

  const collateralDiff = collateralBigInt - oldCollateral;
  const ondeltaDiff = ondeltaBigInt - oldOndelta;

  console.log(`💰 R→C state update:`);
  console.log(`   Collateral: ${oldCollateral} → ${collateralBigInt} (diff: ${collateralDiff})`);
  console.log(`   Ondelta: ${oldOndelta} → ${ondeltaBigInt} (diff: ${ondeltaDiff})`);

  if (side === 'receiving') {
    events.push(
      `💰 Collateral +${collateralDiff} (now ${collateralBigInt}) - counterparty deposited token ${tokenId}`
    );
  } else {
    events.push(
      `📤 Collateral +${collateralDiff} (now ${collateralBigInt}) - we deposited token ${tokenId}`
    );
  }

  // Update current frame snapshot
  const totalDelta = delta.ondelta + delta.offdelta;
  const tokenIndex = accountMachine.currentFrame.tokenIds.indexOf(tokenId);

  if (tokenIndex >= 0) {
    accountMachine.currentFrame.deltas[tokenIndex] = totalDelta;
  } else {
    accountMachine.currentFrame.tokenIds.push(tokenId);
    accountMachine.currentFrame.deltas.push(totalDelta);
  }

  console.log(`✅ R→C processed successfully for token ${tokenId}`);

  return { success: true, events };
}
